/**
 * call_turns 仓储（Siren 的通话元数据记录；不是聊天历史真源，规范第 28 节）。
 */
import type { FieldCipher } from '../field-crypto.ts';
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
  /** 历史口径首音（filler 计入）；C11 迁移新增，可省略（落 NULL） */
  first_audio_ms?: number | null;
  /** 首个正文（非 filler）音频；只有 filler 的轮次为 NULL；C11 迁移新增，可省略 */
  first_content_audio_ms?: number | null;
  /** R7 迁移新增：轮次终态；历史行/未传=NULL=unknown（取值域见 voice-core TurnOutcome） */
  outcome?: string | null;
  created_at: number;
}

export class CallTurnsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    /** S1011-013：通话文本静态加密（null=不加密） */
    private readonly cipher: FieldCipher | null = null
  ) {}

  insert(row: CallTurnRow): void {
    const stored: CallTurnRow = this.cipher
      ? {
          ...row,
          first_audio_ms: row.first_audio_ms ?? null,
          first_content_audio_ms: row.first_content_audio_ms ?? null,
          outcome: row.outcome ?? null,
          user_text: row.user_text !== null ? this.cipher.seal(row.user_text) : null,
          assistant_text: row.assistant_text !== null ? this.cipher.seal(row.assistant_text) : null
        }
      : { ...row, first_audio_ms: row.first_audio_ms ?? null, first_content_audio_ms: row.first_content_audio_ms ?? null, outcome: row.outcome ?? null };
    this.db
      .prepare(`
        INSERT INTO call_turns (
          id, call_id, turn_index, user_text, assistant_text, started_at, ended_at,
          interrupted, asr_latency_ms, llm_first_token_ms, tts_first_audio_ms,
          first_audio_ms, first_content_audio_ms, outcome, created_at
        ) VALUES (
          @id, @call_id, @turn_index, @user_text, @assistant_text, @started_at, @ended_at,
          @interrupted, @asr_latency_ms, @llm_first_token_ms, @tts_first_audio_ms,
          @first_audio_ms, @first_content_audio_ms, @outcome, @created_at
        )
      `)
      .run(stored);
  }

  listByCall(callId: string): CallTurnRow[] {
    const rows = this.db
      .prepare('SELECT * FROM call_turns WHERE call_id = ? ORDER BY turn_index ASC')
      .all(callId) as CallTurnRow[];
    if (!this.cipher) return rows;
    return rows.map((row) => ({
      ...row,
      user_text: this.cipher!.open(row.user_text),
      assistant_text: this.cipher!.open(row.assistant_text)
    }));
  }
}
