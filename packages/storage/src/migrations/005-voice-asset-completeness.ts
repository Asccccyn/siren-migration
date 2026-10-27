// GLM_VOICE_UNIFICATION RR-09：voice_assets.completeness——生成音频完整性
//（complete=完整话轮；partial=打断/失败轮的已生成部分，未播范围未知）。
import type { SqliteDatabase } from '../sqlite.ts';

export function addVoiceAssetCompleteness(db: SqliteDatabase): void {
  const cols = db.prepare("PRAGMA table_info(voice_assets)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'completeness')) return;
  db.exec("ALTER TABLE voice_assets ADD COLUMN completeness TEXT CHECK(completeness IN ('complete','partial'))");
}
