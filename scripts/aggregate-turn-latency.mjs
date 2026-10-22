#!/usr/bin/env node
/**
 * C11/C16：call_turns 首音延迟聚合（p50/p95）。
 * 读 Siren 的 SQLite 存储（call_turns 表，schema 见 packages/storage/src/migrations），
 * 聚合 first_audio_ms（历史口径：filler 计入）与 first_content_audio_ms（只算正文）。
 *
 * 用法：node scripts/aggregate-turn-latency.mjs --db <path> [--limit <n>]
 * - 结果 JSON 输出到 stdout；错误走 stderr 并以非 0 退出。
 * - 不提供 --db（或空串）时直接报错退出：分析脚本不内置生产库默认路径。
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// pnpm 布局下根 node_modules 不直接暴露 better-sqlite3；
// 以 storage 包源文件为锚点 require，与其内部解析结果一致。
const requireFromStorage = createRequire(resolve(here, '../packages/storage/src/sqlite.ts'));
const Database = requireFromStorage('better-sqlite3');

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { db: '', limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      out.db = argv[i + 1] ?? '';
      i++;
    } else if (argv[i] === '--limit') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) fail(2, '--limit 需要正整数');
      out.limit = n;
      i++;
    } else {
      fail(2, `未知参数：${argv[i]}（支持 --db <path> 与 --limit <n>）`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) fail(2, '缺少 --db <path>：本脚本不内置生产库默认路径，请显式指定 call_turns 所在 SQLite 文件');

let db;
try {
  db = new Database(args.db, { readonly: true });
} catch (error) {
  fail(1, `无法打开数据库 ${args.db}：${error.message}`);
}

let rows;
try {
  rows = db
    .prepare(
      `SELECT first_audio_ms, first_content_audio_ms FROM call_turns
       ORDER BY created_at DESC, rowid DESC ${args.limit ? 'LIMIT ?' : ''}`
    )
    .all(...(args.limit ? [args.limit] : []));
} catch (error) {
  db.close();
  fail(1, `读取 call_turns 失败（${args.db} 是否为 Siren 库？）：${error.message}`);
}
db.close();

if (!rows || rows.length === 0) {
  fail(1, `call_turns 无数据行（${args.db}）：空表无法聚合，请确认库文件`);
}

/** nearest-rank 百分位：升序第 ceil(q/100 * n) 个值（1-based） */
function percentile(sorted, q) {
  const n = sorted.length;
  const rank = Math.max(1, Math.ceil((q / 100) * n));
  return sorted[rank - 1];
}

function summary(column) {
  const values = rows
    .map((row) => row[column])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) return { count: 0, p50: null, p95: null };
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

const output = {
  db: resolve(args.db),
  limit: args.limit,
  sampled_rows: rows.length,
  first_audio_ms: summary('first_audio_ms'),
  first_content_audio_ms: summary('first_content_audio_ms'),
  notes: [
    '冷热轮不分：全部轮次（含首轮冷启动与后续热轮）合并统计',
    'null 不计入对应字段样本（NULL=该轮无此口径数据，如只有 filler 的轮次 first_content_audio_ms 为空）',
    'p50/p95 为 nearest-rank：升序第 ceil(q/100*n) 个值'
  ]
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
