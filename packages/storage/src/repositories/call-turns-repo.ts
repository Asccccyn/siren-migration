/**
 * call_turns 仓储（Siren 的通话元数据记录；不是聊天历史真源，规范第 28 节）。
 */
import type { FieldCipher } from '../field-crypto.ts';
import type { SqliteDatabase } from '../sqlite.ts';
import type { CallPlaybackEvidence, CallTurnAudio } from '@siren/contracts';

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
  output_stream_id?: string | null;
  sent_audio_ms?: number | null;
  filler_audio_ms?: number | null;
  playback_json?: string | null;
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
          first_audio_ms, first_content_audio_ms, outcome, output_stream_id, sent_audio_ms, filler_audio_ms, playback_json, created_at
        ) VALUES (
          @id, @call_id, @turn_index, @user_text, @assistant_text, @started_at, @ended_at,
          @interrupted, @asr_latency_ms, @llm_first_token_ms, @tts_first_audio_ms,
          @first_audio_ms, @first_content_audio_ms, @outcome, @output_stream_id, @sent_audio_ms, @filler_audio_ms, @playback_json, @created_at
        )
      `)
      .run({ ...stored, output_stream_id: row.output_stream_id ?? null, sent_audio_ms: row.sent_audio_ms ?? null, filler_audio_ms: row.filler_audio_ms ?? null, playback_json: row.playback_json ?? null });
  }

  listAudioByCall(callId: string): CallTurnAudio[] {
    const rows = this.db.prepare(`
      SELECT t.id,t.turn_index,t.outcome,t.sent_audio_ms,t.filler_audio_ms,t.playback_json,
        u.id AS user_asset_id,u.duration_ms AS user_duration_ms,
        r.id AS reply_asset_id,r.duration_ms AS reply_duration_ms,r.completeness AS reply_completeness
      FROM call_turns t
      LEFT JOIN voice_assets u ON u.call_id=t.call_id AND u.turn_id=t.id AND u.direction='user'
      LEFT JOIN voice_assets r ON r.call_id=t.call_id AND r.turn_id=t.id AND r.direction='assistant'
      WHERE t.call_id=? ORDER BY t.turn_index
    `).all(callId) as Array<{
      id: string; turn_index: number; outcome: string | null; sent_audio_ms: number | null; filler_audio_ms: number | null; playback_json: string | null;
      user_asset_id: string | null; user_duration_ms: number; reply_asset_id: string | null; reply_duration_ms: number; reply_completeness: 'complete' | 'partial' | null;
    }>;
    return rows.map(row => ({
      turn_id: row.id, turn_index: row.turn_index, outcome: row.outcome,
      user_audio: row.user_asset_id ? { asset_id: row.user_asset_id, duration_ms: row.user_duration_ms } : null,
      reply_audio: row.reply_asset_id ? { asset_id: row.reply_asset_id, duration_ms: row.reply_duration_ms, completeness: row.reply_completeness } : null,
      sent_audio_ms: row.sent_audio_ms, filler_audio_ms: row.filler_audio_ms,
      playback: row.playback_json ? JSON.parse(row.playback_json) as CallPlaybackEvidence : { basis: 'unknown' },
    }));
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
