/**
 * 单轮通话延迟采集（规范第 39 节）。
 * speech_end -> asr_final / llm_first_token / first_sentence_ready / tts_first_chunk / audio_play_request
 */
import type { LatencyMark, TurnLatencyMetrics } from '@siren/contracts';

export class LatencyTracker {
  private readonly marks = new Map<LatencyMark, number>();
  private interrupted = false;
  private fillerPlayed = false;

  // Every automatic mark shares this process's monotonic clock. Wall time is
  // reserved for stored timestamps, never elapsed-time subtraction.
  mark(mark: LatencyMark, at: number = performance.now()): void {
    if (!Number.isFinite(at)) throw new RangeError('latency mark must be finite');
    if (!this.marks.has(mark)) this.marks.set(mark, at);
  }


  markEnd(at: number = performance.now()): void {
    this.mark('turn_end', at);
  }

  setInterrupted(): void {
    this.interrupted = true;
  }

  setFillerPlayed(): void {
    this.fillerPlayed = true;
  }

  get(mark: LatencyMark): number | undefined {
    return this.marks.get(mark);
  }

  compute(): TurnLatencyMetrics {
    const diff = (a: LatencyMark, b: LatencyMark): number | null => {
      const av = this.marks.get(a);
      const bv = this.marks.get(b);
      if (av === undefined || bv === undefined) return null;
      const elapsed = bv - av;
      return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    };
    return {
      asr_latency_ms: diff('speech_end', 'asr_final'),
      llm_first_token_ms: diff('speech_end', 'llm_first_token'),
      tts_first_audio_ms: diff('first_sentence_ready', 'tts_first_chunk'),
      // 历史口径：首个下行音频（filler 计入）。C11 起另设 first_content_audio_ms
      // 区分正文首音；本字段保留以维持既有趋势数据的连续性。
      total_first_audio_ms: diff('speech_end', 'audio_play_request'),
      // C11：首个正文（非 filler）音频；只有 filler 时该 mark 不存在 -> null（不虚构）
      first_content_audio_ms: diff('speech_end', 'content_audio_play_request'),
      interrupted: this.interrupted,
      filler_played: this.fillerPlayed
    };
  }

  /** 落库用的延迟列（call_turns 表）。first_audio_ms 为 filler 计入的历史口径。 */
  toDbColumns(): {
    asr_latency_ms: number | null;
    llm_first_token_ms: number | null;
    tts_first_audio_ms: number | null;
    first_audio_ms: number | null;
    first_content_audio_ms: number | null;
  } {
    const m = this.compute();
    return {
      asr_latency_ms: m.asr_latency_ms,
      llm_first_token_ms: m.llm_first_token_ms,
      tts_first_audio_ms: m.tts_first_audio_ms,
      first_audio_ms: m.total_first_audio_ms,
      first_content_audio_ms: m.first_content_audio_ms
    };
  }
}
