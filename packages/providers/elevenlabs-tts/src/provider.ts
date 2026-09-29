/**
 * ElevenLabs TTS（可选替换 Provider）。
 * - 批量：显式 format 映射（P1-2）——mp3 -> mp3_44100_128；
 *   wav/pcm -> pcm_{rate}（ElevenLabs 不提供 wav 输出，如实返回 pcm + 正确 MIME，
 *   不支持的采样率直接抛 unsupported_format，不伪装）
 * - 流式：官方 /v1/text-to-speech/{id}/stream 增量读取响应体（P0-9 附录说明：
 *   这是 provider 端流式端点 + 增量 transport 读取，非本地切片）
 * - AbortSignal：透传到 fetch，barge-in 时真正取消上游请求
 * 情绪映射为 voice_settings 参数（规范第 9 节）。
 */
import {
  ProviderError,
  REALTIME_OUTPUT_SAMPLE_RATE,
  type AudioFormat,
  type PcmChunk,
  type StreamTtsProvider,
  type TtsAudioResult,
  type TtsProvider,
  type TtsRequest,
  type SirenEmotion
} from '@siren/contracts';
import { estimateMp3DurationMs, samplesForDuration } from '@siren/audio';

export interface ElevenLabsConfig {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  timeoutMs: number;
}

/** ElevenLabs pcm 输出支持的采样率 */
const PCM_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);

/** 官方 voice_settings.speed 允许范围（https://elevenlabs.io/docs … text-to-speech） */
const ELEVEN_SPEED_MIN = 0.7;
const ELEVEN_SPEED_MAX = 1.2;

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  /** 官方 voice_settings.speed，允许范围 0.7–1.2（F17） */
  speed?: number;
}

const EMOTION_SETTINGS: Record<SirenEmotion, Partial<VoiceSettings>> = {
  neutral: {},
  warm: { stability: 0.55, style: 0.15 },
  happy: { style: 0.55 },
  sad: { stability: 0.75, style: 0.2 },
  angry: { stability: 0.3, style: 0.7 },
  teasing: { stability: 0.35, style: 0.65 },
  sleepy: { stability: 0.85, style: 0.05 },
  excited: { stability: 0.25, style: 0.8 },
  surprised: { stability: 0.4, style: 0.6 }
};

/** 请求格式 -> ElevenLabs output_format 的显式映射；返回实际交付格式与采样率 */
function mapFormat(format: AudioFormat, sampleRateHint: number): {
  outputFormat: string;
  actualFormat: AudioFormat;
  actualSampleRate: number;
} {
  if (format === 'mp3') {
    return { outputFormat: 'mp3_44100_128', actualFormat: 'mp3', actualSampleRate: 44100 };
  }
  // wav / pcm：ElevenLabs 只有 pcm 输出；wav 请求如实降为 pcm（MIME/格式一致）
  const rate = sampleRateHint || REALTIME_OUTPUT_SAMPLE_RATE;
  if (!PCM_RATES.has(rate)) {
    throw new ProviderError(
      'unsupported_format',
      'elevenlabs',
      `pcm sample rate ${rate} not supported by elevenlabs (supported: ${[...PCM_RATES].join(', ')})`
    );
  }
  return { outputFormat: `pcm_${rate}`, actualFormat: 'pcm', actualSampleRate: rate };
}

export class ElevenLabsTtsProvider implements TtsProvider, StreamTtsProvider {
  constructor(private readonly config: ElevenLabsConfig) {}

  async synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError('provider_unavailable', 'elevenlabs', 'voice id missing (set ELEVENLABS_VOICE_ID or profile voiceId)');
    }
    const mapped = mapFormat(request.format, request.sampleRate ?? 0);
    const audio = await this.rawRequest(voiceId, request, mapped.outputFormat);
    return {
      audio,
      // 如实上报：请求 wav 但拿回 pcm 时格式就是 pcm，MIME/扩展名按此为准
      format: mapped.actualFormat,
      sampleRate: mapped.actualSampleRate,
      durationMs:
        mapped.actualFormat === 'mp3'
          ? estimateMp3DurationMs(audio.length, 128)
          : Math.round((audio.length / 2 / mapped.actualSampleRate) * 1000)
    };
  }

  /** 官方流式端点 + 响应体增量读取：音频边生成边到达（pcm_24000） */
  async *synthesizeStream(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError('provider_unavailable', 'elevenlabs', 'voice id missing');
    }
    const mapped = mapFormat(request.format === 'mp3' ? 'pcm' : request.format, request.sampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE);
    const sampleRate = mapped.actualSampleRate;
    const framer = new PcmAccumulator(sampleRate);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await this.fetchStream(voiceId, request, mapped.outputFormat, signal);
      if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new ProviderError('tts_failed', 'elevenlabs', `tts http ${response.status} ${message.slice(0, 200)}`);
      }
      if (!response.body) {
        throw new ProviderError('tts_failed', 'elevenlabs', 'tts stream body missing');
      }
      reader = response.body.getReader();
      while (true) {
        if (signal?.aborted) throw new ProviderError('tts_failed', 'elevenlabs', 'tts aborted');
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of framer.push(Buffer.from(value))) {
          yield { audio: frame, sampleRate };
        }
      }
      for (const frame of framer.flush()) {
        yield { audio: frame, sampleRate };
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted) {
        throw new ProviderError('tts_failed', 'elevenlabs', 'tts aborted', error);
      }
      // F16：网络故障（fetch rejection / reader 异常 / 超时）统一归类 tts_failed，
      // 调用方的降级链只认 ProviderError——透传 TypeError 会被当成 Core 故障
      throw new ProviderError('tts_failed', 'elevenlabs', `tts network error: ${(error as Error).message}`, error);
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }

  private async fetchStream(
    voiceId: string,
    request: TtsRequest,
    outputFormat: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return this.post(voiceId, request, outputFormat, '/stream', combined);
  }

  private async rawRequest(voiceId: string, request: TtsRequest, outputFormat: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.post(voiceId, request, outputFormat, '', AbortSignal.timeout(this.config.timeoutMs));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // F16：批量路径的网络故障同样归类 tts_failed（REST 层才能回 502 而不是 500）
      throw new ProviderError('tts_failed', 'elevenlabs', `tts network error: ${(error as Error).message}`, error);
    }
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new ProviderError('tts_failed', 'elevenlabs', `tts http ${response.status} ${message.slice(0, 200)}`);
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('tts_failed', 'elevenlabs', `tts network error: ${(error as Error).message}`, error);
    }
  }

  private post(
    voiceId: string,
    request: TtsRequest,
    outputFormat: string,
    suffix: string,
    signal: AbortSignal
  ): Promise<Response> {
    const settings: VoiceSettings = {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.2,
      use_speaker_boost: true,
      ...EMOTION_SETTINGS[request.style.emotion]
    };
    if (request.style.speed !== undefined) {
      // F17：官方 API 提供原生 speed（0.7–1.2）；此前误写成 stability，
      // 既没变速又破坏了情绪预设的稳定性
      settings.speed = clamp(request.style.speed, ELEVEN_SPEED_MIN, ELEVEN_SPEED_MAX);
    }
    return fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}/v1/text-to-speech/${encodeURIComponent(voiceId)}${suffix}?output_format=${outputFormat}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'content-type': 'application/json',
          accept: outputFormat.startsWith('pcm') ? 'audio/pcm' : 'audio/mpeg'
        },
        body: JSON.stringify({
          text: request.ttsScript ?? request.text,
          model_id: this.config.modelId,
          voice_settings: settings
        }),
        signal
      }
    );
  }
}

/** 字节流按 20ms 帧切分（跨 read 保留残余） */
class PcmAccumulator {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly sampleRate: number) {}

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frameBytes = samplesForDuration(this.sampleRate, 20) * 2;
    const frames: Buffer[] = [];
    while (this.pending.length >= frameBytes) {
      frames.push(this.pending.subarray(0, frameBytes));
      this.pending = this.pending.subarray(frameBytes);
    }
    return frames;
  }

  flush(): Buffer[] {
    if (this.pending.length === 0) return [];
    const rest = [this.pending];
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
