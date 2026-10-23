/**
 * R7（2026-10-23，她 D6 裁定）：call_turns 增加 outcome 列（可重入，同 002 模式）。
 * - 历史行 outcome=NULL=unknown，不回填不补造；
 * - 新写入的取值域由 voice-core TurnOutcome 持有（completed/interrupted/asr_failed/
 *   asr_timeout/core_failed/tts_failed/asr_empty）——asr_empty 为中性事实（空转写轮），
 *   不计入 ASR 故障；挂断/打断沿用 interrupted（既有事实口径，不为凑枚举造取消态）。
 * 统计分母（aggregate-turn-latency 同口径）：接纳轮=全部行；识别轮=outcome ∈
 * {completed,interrupted,core_failed,tts_failed}（进入回复链）；asr_empty/ASR 失败类
 * 不进回复链延迟分母。
 */
import type Database from 'better-sqlite3';

export function addCallTurnOutcomeColumn(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(call_turns)').all() as { name: string }[]).map((row) => row.name)
  );
  if (!existing.has('outcome')) {
    db.exec('ALTER TABLE call_turns ADD COLUMN outcome TEXT');
  }
  // RE-17（2026-10-24 返修）：outcome 值域 DB 级约束（触发器——裸 SQL 插入也拦；
  // 上轮拼错枚举（asr_empyt）被静默当 unknown）。历史 NULL=unknown 仍合法。
  const VALID = "('completed','interrupted','asr_failed','asr_timeout','core_failed','tts_failed','asr_empty')";
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_call_turns_outcome_insert
    BEFORE INSERT ON call_turns
    WHEN NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ${VALID}
    BEGIN SELECT RAISE(ABORT, 'invalid outcome'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_call_turns_outcome_update
    BEFORE UPDATE OF outcome ON call_turns
    WHEN NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ${VALID}
    BEGIN SELECT RAISE(ABORT, 'invalid outcome'); END;`);
}
