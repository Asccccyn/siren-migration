/**
 * call_sessions 仓储。
 */
import type { SqliteDatabase } from '../sqlite.ts';

export interface CallSessionRow {
  id: string;
  conversation_id: string | null;
  voice_profile: string;
  started_at: number | null;
  ended_at: number | null;
  status: 'active' | 'ended' | 'error';
  asr_provider: string | null;
  tts_provider: string | null;
  created_at: number;
}

export class CallSessionsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(row: CallSessionRow): void {
    this.db
      .prepare(`
        INSERT INTO call_sessions (id, conversation_id, voice_profile, started_at, ended_at, status, asr_provider, tts_provider, created_at)
        VALUES (@id, @conversation_id, @voice_profile, @started_at, @ended_at, @status, @asr_provider, @tts_provider, @created_at)
      `)
      .run(row);
  }

  findById(id: string): CallSessionRow | undefined {
    return this.db.prepare('SELECT * FROM call_sessions WHERE id = ?').get(id) as CallSessionRow | undefined;
  }

  markStarted(id: string, at: number): void {
    this.db.prepare('UPDATE call_sessions SET started_at = ? WHERE id = ?').run(at, id);
  }

  markEnded(id: string, at: number, status: 'ended' | 'error'): void {
    this.db
      .prepare('UPDATE call_sessions SET ended_at = ?, status = ? WHERE id = ?')
      .run(at, status, id);
  }

  /**
   * 进程启动清扫（审计修复）：启动瞬间不可能有活跃通话，
   * 所有 status=active 的行都是上一进程的残留（如创建后从未连 WS、或进程崩溃）。
   * 返回清理行数。
   */
  endAllActive(at: number): number {
    const result = this.db
      .prepare("UPDATE call_sessions SET ended_at = ?, status = 'ended' WHERE status = 'active'")
      .run(at);
    return Number(result.changes);
  }
}
