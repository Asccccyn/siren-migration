/**
 * call_turns 仓储（Siren 的通话元数据记录；不是聊天历史真源，规范第 28 节）。
 */
import type { SqliteDatabase } from '../sqlite.ts';

export interface CallTurnRow {
  id: string;
  call_id: string;
  turn_index: number;
  user_text: string | null;
  assistant_text: string | null;
  started_at: number | null;
  ended_at: number | null;
  interrupted: 0 | 1;
  asr_latency_ms: number | null;
  llm_first_token_ms: number | null;
  tts_first_audio_ms: number | null;
  created_at: number;
}

export class CallTurnsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: CallTurnRow): void {
    this.db
      .prepare(`
        INSERT INTO call_turns (
          id, call_id, turn_index, user_text, assistant_text, started_at, ended_at,
          interrupted, asr_latency_ms, llm_first_token_ms, tts_first_audio_ms, created_at
        ) VALUES (
          @id, @call_id, @turn_index, @user_text, @assistant_text, @started_at, @ended_at,
          @interrupted, @asr_latency_ms, @llm_first_token_ms, @tts_first_audio_ms, @created_at
        )
      `)
      .run(row);
  }

  listByCall(callId: string): CallTurnRow[] {
    return this.db
      .prepare('SELECT * FROM call_turns WHERE call_id = ? ORDER BY turn_index ASC')
      .all(callId) as CallTurnRow[];
  }
}
