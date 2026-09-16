/**
 * SQLite 打开与迁移（better-sqlite3，WAL 模式）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATION_001 } from './migrations/001-init.ts';

export type SqliteDatabase = Database.Database;

const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: MIGRATION_001 }];

export function openDatabase(path: string): SqliteDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      );
    });
    tx();
  }
}
