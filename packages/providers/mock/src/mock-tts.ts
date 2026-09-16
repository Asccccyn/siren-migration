/**
 * Mock TTS：生成确定性的 PCM/WAV 音频，开发与测试使用。
 * 可注入故障用于验证降级链路（规范第 40 节）。
 */
import {
  ProviderError,
  REALTIME_OUTPUT_SAMPLE_RATE,
  type BatchTtsProvider,
  type PcmChunk,
  type StreamTtsProvider,
  type TtsAudioResult,
  type TtsRequest
} from '@siren/contracts';
import { buildWav, chunkPcm16, pcmDurationMs, samplesForDuration } from '@siren/audio';

export interface MockTtsFaults {
  failStream?: boolean;
  failBatch?: boolean;
  /** 流式产出多少个 chunk 后再失败（0 = 立刻） */
  failStreamAfterChunks?: number;
}

/** 按文本长度生成低幅正弦“语音”PCM（约 60ms/字） */
export function generateMockPcm(text: string, sampleRate: number, freq = 220, amplitude = 0.18): Buffer {
  const samples = samplesForDuration(sampleRate, Math.max(text.length, 1) * 60);
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const envelope = amplitude * Math.min(i / (sampleRate * 0.02), 1);
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * envelope;
    out.writeInt16LE(Math.round(value * 0x7fff * 0.5), i * 2);
  }
  return out;
}

export class MockTtsProvider implements BatchTtsProvider, StreamTtsProvider {
  readonly calls: { batchCount: number; streamCount: number } = { batchCount: 0, streamCount: 0 };
  readonly synthesizedTexts: string[] = [];
  faults: MockTtsFaults = {};

  async synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    this.calls.batchCount++;
    if (this.faults.failBatch) {
      throw new ProviderError('tts_failed', 'mock-tts', 'mock batch tts failure');
    }
    const sampleRate = request.sampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE;
    const text = request.ttsScript ?? request.text;
    this.synthesizedTexts.push(text);
    const pcm = generateMockPcm(text, sampleRate);
    if (request.format === 'pcm') {
      return { audio: pcm, format: 'pcm', sampleRate, durationMs: pcmDurationMs(pcm.length, sampleRate) };
    }
    if (request.format === 'wav') {
      return { audio: buildWav(pcm, sampleRate), format: 'wav', sampleRate, durationMs: pcmDurationMs(pcm.length, sampleRate) };
    }
    // Mock 无 MP3 编码器：以 WAV 容器承载 PCM，content-type 如实标注
    return { audio: buildWav(pcm, sampleRate), format: 'wav', sampleRate, durationMs: pcmDurationMs(pcm.length, sampleRate) };
  }

  async *synthesizeStream(request: TtsRequest): AsyncGenerator<PcmChunk> {
    this.calls.streamCount++;
    const sampleRate = request.sampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE;
    const text = request.ttsScript ?? request.text;
    this.synthesizedTexts.push(text);
    const pcm = generateMockPcm(text, sampleRate);
    const frames = chunkPcm16(pcm, samplesForDuration(sampleRate, 20));
    let sent = 0;
    for (const frame of frames) {
      if (this.faults.failStream && sent >= (this.faults.failStreamAfterChunks ?? 0)) {
        throw new ProviderError('tts_failed', 'mock-tts', 'mock stream tts failure');
      }
      sent++;
      yield { audio: frame, sampleRate };
    }
  }
}
