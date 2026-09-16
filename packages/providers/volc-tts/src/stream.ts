/**
 * 火山引擎流式 TTS。
 *
 * 实现说明（docs/PROVIDERS.md 有完整记录）：
 * v1 实现按“句子粒度的批量合成 + 流水线预取”提供 streaming 能力——
 * 每句请求 encoding=pcm / 24kHz / mono，返回 PCM16 chunk 流；
 * 与 sentence splitter 配合后，首句首包延迟 = 单句 HTTP 合成耗时，
 * 后续句在上一句播放期间预取，听感上等价于流式协议。
 * 若后续切换火山 v3 双向流式 WebSocket 协议，只需替换本文件，
 * 上层（voice-core）只依赖 StreamTtsProvider 接口。
 */
import type { Logger } from '@siren/telemetry';
import {
  REALTIME_OUTPUT_SAMPLE_RATE,
  type BatchTtsProvider,
  type PcmChunk,
  type StreamTtsProvider,
  type TtsRequest
} from '@siren/contracts';
import { chunkPcm16, samplesForDuration } from '@siren/audio';

export class VolcStreamTtsProvider implements StreamTtsProvider {
  constructor(
    private readonly batch: BatchTtsProvider,
    private readonly logger?: Logger
  ) {}

  async *synthesizeStream(request: TtsRequest): AsyncGenerator<PcmChunk> {
    const sampleRate = request.sampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE;
    const result = await this.batch.synthesize({ ...request, format: 'pcm', sampleRate });
    if (result.sampleRate !== sampleRate) {
      this.logger?.warn('tts_sample_rate_mismatch', {
        expected: sampleRate,
        actual: result.sampleRate
      });
    }
    const chunkSamples = samplesForDuration(result.sampleRate, 20); // 20ms 帧
    for (const frame of chunkPcm16(result.audio, chunkSamples)) {
      yield { audio: frame, sampleRate: result.sampleRate };
    }
  }
}
