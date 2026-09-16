/**
 * 单轮通话延迟采集（规范第 39 节）。
 * speech_end -> asr_final / llm_first_token / first_sentence_ready / tts_first_chunk / audio_play_request
 */
import type { LatencyMark, TurnLatencyMetrics } from '@siren/contracts';

export class LatencyTracker {
  private readonly marks = new Map<LatencyMark, number>();
  private interrupted = false;
  private fillerPlayed = false;

  mark(mark: LatencyMark, at: number = Date.now()): void {
    if (!this.marks.has(mark)) this.marks.set(mark, at);
  }

  markOnce(mark: LatencyMark, at: number = Date.now()): void {
    this.mark(mark, at);
  }

  markEnd(at: number = Date.now()): void {
    if (!this.marks.has('turn_end')) this.marks.set('turn_end', at);
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
      return Math.max(bv - av, 0);
    };
    return {
      asr_latency_ms: diff('speech_end', 'asr_final'),
      llm_first_token_ms: diff('speech_end', 'llm_first_token'),
      tts_first_audio_ms: diff('first_sentence_ready', 'tts_first_chunk'),
      total_first_audio_ms: diff('speech_end', 'audio_play_request'),
      interrupted: this.interrupted,
      filler_played: this.fillerPlayed
    };
  }

  /** 落库用的三个核心列（call_turns 表） */
  toDbColumns(): { asr_latency_ms: number | null; llm_first_token_ms: number | null; tts_first_audio_ms: number | null } {
    const m = this.compute();
    return {
      asr_latency_ms: m.asr_latency_ms,
      llm_first_token_ms: m.llm_first_token_ms,
      tts_first_audio_ms: m.tts_first_audio_ms
    };
  }
}
