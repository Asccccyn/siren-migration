/**
 * B5/P1（2026-10-24，CallHome 原位吸收 A09/A10/A12）：来电邀请持久状态。
 * - pending → accepted | declined | expired | cancelled（唯一终态，CAS 更新带版本）；
 * - expires_at 服务端权威；过期回收不依赖页面轮询（服务端 sweeper，重启后启动扫描恢复）；
 * - accepted ≠ 音频已连接（媒体连接失败另行如实记录，不伪装成自然未接）；
 * - declined ≠ 自然过期（拒接不自动补打、不走留言任务——不同事实不同终态）。
 */
import type Database from 'better-sqlite3';

export function createCallInvites(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_invites (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      voice_profile TEXT NOT NULL DEFAULT 'main',
      state TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','expired','cancelled')),
      state_version INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      ended_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_invites_pending_expiry ON call_invites(state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_call_invites_conversation ON call_invites(conversation_id, created_at);
  `);
}
