/**
 * ElevenLabs TTS（可选替换 Provider）。
 * - 批量：output_format=mp3_44100_128 -> 完整 MP3
 * - 流式：output_format=pcm_24000 -> PCM16 24kHz mono chunk 流
 * 情绪映射为 voice_settings 参数（规范第 9 节）。
 */
import {
  ProviderError,
  REALTIME_OUTPUT_SAMPLE_RATE,
  type PcmChunk,
  type StreamTtsProvider,
  type TtsAudioResult,
  type TtsProvider,
  type TtsRequest,
  type SirenEmotion
} from '@siren/contracts';
import { chunkPcm16, estimateMp3DurationMs, samplesForDuration } from '@siren/audio';

export interface ElevenLabsConfig {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  timeoutMs: number;
}

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
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

export class ElevenLabsTtsProvider implements TtsProvider, StreamTtsProvider {
  constructor(private readonly config: ElevenLabsConfig) {}

  async synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError('provider_unavailable', 'elevenlabs', 'voice id missing (set ELEVENLABS_VOICE_ID or profile voiceId)');
    }
    const audio = await this.rawRequest(voiceId, request, 'mp3_44100_128');
    return {
      audio,
      format: request.format === 'wav' ? 'wav' : request.format,
      sampleRate: request.sampleRate ?? 44100,
      durationMs: estimateMp3DurationMs(audio.length, 128)
    };
  }

  async *synthesizeStream(request: TtsRequest): AsyncGenerator<PcmChunk> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError('provider_unavailable', 'elevenlabs', 'voice id missing');
    }
    const sampleRate = request.sampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE;
    const audio = await this.rawRequest(voiceId, request, 'pcm_24000');
    const chunkSamples = samplesForDuration(sampleRate, 20);
    for (const frame of chunkPcm16(audio, chunkSamples)) {
      yield { audio: frame, sampleRate };
    }
  }

  private async rawRequest(voiceId: string, request: TtsRequest, outputFormat: string): Promise<Buffer> {
    const settings: VoiceSettings = {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.2,
      use_speaker_boost: true,
      ...EMOTION_SETTINGS[request.style.emotion]
    };
    if (request.style.speed !== undefined) {
      // ElevenLabs 无原生语速参数，通过 stability 间接微调
      settings.stability = clamp(1.1 - request.style.speed * 0.5, 0.05, 1.0);
    }
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text: request.ttsScript ?? request.text,
          model_id: this.config.modelId,
          voice_settings: settings
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new ProviderError('tts_failed', 'elevenlabs', `tts http ${response.status} ${message.slice(0, 200)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
