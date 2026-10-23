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
      `SELECT first_audio_ms, first_content_audio_ms, outcome FROM call_turns
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
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return { count: 0, p50: null, p95: null };
  return { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

function quality(column) {
  const values = rows.map((row) => row[column]);
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  return {
    total: rows.length,
    missing: values.filter((value) => value === null || value === undefined).length,
    invalid: values.filter((value) => value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)).length,
    max: valid.length ? valid.reduce((max, value) => Math.max(max, value), 0) : null
  };
}

/** R7（2026-10-23，她 D6 裁定）：outcome 分布与三口径分母——
 *  接纳轮（accepted）=全部行：整体技术失败率的分母；
 *  识别轮（recognized）=进入回复链（completed/interrupted/core_failed/tts_failed）：
 *    回复链延迟统计的分母；asr_empty/asr_failed/asr_timeout 不在回复链；
 *  asr_empty=中性（空转写），单独计数，不算故障不进识别轮。 */
const OUTCOMES = ['completed', 'interrupted', 'core_failed', 'tts_failed', 'asr_failed', 'asr_timeout', 'asr_empty'];
const outcomeCounts = {};
for (const row of rows) {
  const key = OUTCOMES.includes(row.outcome) ? row.outcome : 'unknown_or_null';
  outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
}
const recognizedOutcomes = new Set(['completed', 'interrupted', 'core_failed', 'tts_failed']);
const replyRows = rows.filter((row) => recognizedOutcomes.has(row.outcome));
const technicalFailures = rows.filter((row) => row.outcome === 'asr_failed' || row.outcome === 'asr_timeout' || row.outcome === 'core_failed' || row.outcome === 'tts_failed').length;
const outcome = {
  distribution: outcomeCounts,
  accepted_turns: rows.length,
  recognized_turns: replyRows.length,
  asr_empty_turns: outcomeCounts['asr_empty'] ?? 0,
  technical_failure_rate: technicalFailures === 0 && rows.length === 0 ? null : Number((technicalFailures / rows.length).toFixed(4)),
  denominator_note: 'accepted=全部行（技术失败率分母）；recognized=进入回复链（completed/interrupted/core_failed/tts_failed，延迟统计分母）；asr_empty 中性不计故障'
};

const output = {
  db: resolve(args.db),
  limit: args.limit,
  sampled_rows: rows.length,
  first_audio_ms: summary('first_audio_ms'),
  first_content_audio_ms: summary('first_content_audio_ms'),
  outcome,
  measurement_basis: 'server_end_received_to_pcm_send_request',
  quality: {
    first_audio_ms: quality('first_audio_ms'),
    first_content_audio_ms: quality('first_content_audio_ms')
  },
  notes: [
    '服务端接到 end 至请求发送 PCM；不是用户真实停声、浏览器播放或设备实际可听延迟',
    '冷热轮不分：全部轮次（含首轮冷启动与后续热轮）合并统计',
    'null/非法值不参与百分位；quality 保留其数量和完整分母，缺失不是零延迟或成功',
    'R7 起新行带 outcome；历史行 outcome=NULL 计入 unknown_or_null，不回填不补造',
    '延迟 summary 的分母仍是全部采样行（含识别前轮）；按 outcome 分层的延迟分布见 outcome.distribution 自行交叉',
    'p50/p95 为 nearest-rank：升序第 ceil(q/100*n) 个值；小样本 p95 不稳定'
  ]
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
