/**
 * C11：call_turns 增加首音延迟两列（可重入）。
 * - first_audio_ms：历史口径——首个下行音频（filler 计入），对应 metrics.total_first_audio_ms
 * - first_content_audio_ms：首个正文（非 filler）音频；只有 filler 的轮次为 NULL
 * 旧库（已应用 001）与新库（001 建表后）都经此迁移补列；用 PRAGMA table_info
 * 探测已存在的列再 ALTER ADD COLUMN，重复执行不报错（SQLite 无 ADD COLUMN IF NOT EXISTS）。
 * 类型从 better-sqlite3 直接引入（type-only），不经 sqlite.ts——避免迁移文件与
 * 迁移执行器之间的文件级循环依赖。
 */
import type Database from 'better-sqlite3';

export function addCallTurnLatencyColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(call_turns)').all() as { name: string }[]).map((row) => row.name)
  );
  if (!existing.has('first_audio_ms')) {
    db.exec('ALTER TABLE call_turns ADD COLUMN first_audio_ms INTEGER');
  }
  if (!existing.has('first_content_audio_ms')) {
    db.exec('ALTER TABLE call_turns ADD COLUMN first_content_audio_ms INTEGER');
  }
}
