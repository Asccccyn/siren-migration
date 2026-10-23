/**
 * CallTurnRecorder：把一轮通话写回 call_turns（Siren 侧元数据，非聊天历史真源，规范第 28 节）。
 */
import type { CallTurnsRepository } from '@siren/storage';
import { errorFields, type Logger } from '@siren/telemetry';
import type { ActiveTurn } from './reply-pipeline.ts';

export type TurnOutcome = 'completed' | 'interrupted' | 'asr_failed' | 'asr_timeout' | 'core_failed' | 'tts_failed' | 'asr_empty';
// R7（2026-10-23，她 D6 裁定）：asr_empty=中性事实（空转写轮，用户说了话但无文本）——
// 不算 ASR 故障、不进回复链分母；其余六值维持既有语义。

export class CallTurnRecorder {
  constructor(
    private readonly turnsRepo: CallTurnsRepository | undefined,
    private readonly logger: Logger
  ) {}

  write(callId: string, turn: ActiveTurn, outcome: TurnOutcome): void {
    if (!this.turnsRepo || turn.written) return;
    turn.written = true;
    const metrics = turn.metrics.toDbColumns();
    try {
      this.turnsRepo.insert({
        id: turn.turnId,
        call_id: callId,
        turn_index: turn.index,
        user_text: outcome === 'asr_failed' || outcome === 'asr_empty' ? null : turn.userText,
        assistant_text: outcome === 'asr_failed' || outcome === 'asr_empty' ? null : turn.fullText,
        started_at: turn.startedAt,
        ended_at: Date.now(),
        interrupted: outcome === 'interrupted' ? 1 : 0,
        asr_latency_ms: metrics.asr_latency_ms,
        llm_first_token_ms: metrics.llm_first_token_ms,
        tts_first_audio_ms: metrics.tts_first_audio_ms,
        // C11：首音两列（first_audio_ms 为 filler 计入历史口径，first_content_audio_ms 只算正文）
        first_audio_ms: metrics.first_audio_ms,
        first_content_audio_ms: metrics.first_content_audio_ms,
        outcome,
        created_at: Date.now()
      });
    } catch (error) {
      this.logger.warn('call_turn_write_failed', errorFields(error));
    }
  }
}
