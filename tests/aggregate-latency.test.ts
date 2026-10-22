/**
 * C11/C16：aggregate-turn-latency.mjs 聚合脚本。
 * - 临时 SQLite 造 100 行合成数据（含 null），断言 nearest-rank p50/p95 数值正确
 * - --limit 取最近 n 行
 * - 空表 / 缺 --db / 文件不存在 → 非 0 退出
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@siren/storage';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/aggregate-turn-latency.mjs');
const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });

interface AggResult {
  db: string;
  limit: number | null;
  sampled_rows: number;
  first_audio_ms: { count: number; p50: number | null; p95: number | null };
  first_content_audio_ms: { count: number; p50: number | null; p95: number | null };
}

/** 100 行：first_audio_ms = 1..100（全非空）；first_content_audio_ms = 1..90 + 10 个 null。
 * created_at 随 i 递增 → --limit n 取最后 n 行。 */
async function seededDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'siren-agg-latency-'));
  scratch.push(dir);
  const path = join(dir, 'latency.db');
  const db = openDatabase(path);
  db.prepare(`INSERT INTO call_sessions (id, conversation_id, voice_profile, started_at, ended_at,
    status, asr_provider, tts_provider, created_at)
    VALUES ('call-agg', NULL, 'main', NULL, NULL, 'ended', NULL, NULL, 0)`).run();
  const insert = db.prepare(`INSERT INTO call_turns (id, call_id, turn_index, user_text, assistant_text,
    started_at, ended_at, interrupted, asr_latency_ms, llm_first_token_ms, tts_first_audio_ms,
    first_audio_ms, first_content_audio_ms, created_at)
    VALUES (@id, 'call-agg', @i, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, @first, @content, @created)`);
  const tx = db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run({
        id: `turn-${i}`,
        i: i + 1,
        first: i + 1, // 1..100
        content: i < 95 ? i + 1 : null, // 1..95 + 5 null
        created: 1_700_000_000_000 + i
      });
    }
  });
  tx();
  db.close();
  return path;
}

async function aggregate(args: string[]) {
  const { stdout } = await run(process.execPath, [script, ...args]);
  return JSON.parse(stdout) as AggResult;
}

describe('aggregate-turn-latency（C11 首音 p50/p95）', () => {
  it('100 行合成数据：p50/p95 nearest-rank 数值正确，null 只影响 content 样本数', async () => {
    const path = await seededDb();
    const result = await aggregate(['--db', path]);
    expect(result.sampled_rows).toBe(100);
    // first_audio_ms = 1..100：p50 = 第 50 小 = 50；p95 = 第 95 小 = 95
    expect(result.first_audio_ms).toEqual({ count: 100, p50: 50, p95: 95 });
    // first_content_audio_ms = 1..95（5 个 null 不计入）：p50 = ceil(47.5)=48；p95 = ceil(90.25)=91
    expect(result.first_content_audio_ms).toEqual({ count: 95, p50: 48, p95: 91 });
    expect(result.limit).toBeNull();
  });

  it('--limit 10 只取最近 10 行（created_at 倒序）并重新计算', async () => {
    const path = await seededDb();
    const result = await aggregate(['--db', path, '--limit', '10']);
    expect(result.sampled_rows).toBe(10);
    // 最近 10 行 = i 90..99 → first_audio_ms = 91..100：p50 = 95；p95 = 100
    expect(result.first_audio_ms).toEqual({ count: 10, p50: 95, p95: 100 });
    // 其中 i=90..94 的 content 非空（= 91..95）：count 5；p50 = 第 3 小 = 93；p95 = 第 5 小 = 95
    expect(result.first_content_audio_ms).toEqual({ count: 5, p50: 93, p95: 95 });
    expect(result.limit).toBe(10);
  });

  it('空表：非 0 退出且不输出 JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'siren-agg-empty-'));
    scratch.push(dir);
    const path = join(dir, 'empty.db');
    const db = openDatabase(path); // 只建 schema，不插行
    db.close();
    const result = await run(process.execPath, [script, '--db', path]).catch((error) => error);
    expect(result.code).not.toBe(0);
    expect(() => JSON.parse(result.stdout ?? '')).toThrow();
  });

  it('缺 --db：非 0 退出（不内置生产库默认路径）', async () => {
    const result = await run(process.execPath, [script]).catch((error) => error);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--db');
  });

  it('库文件不存在：非 0 退出', async () => {
    const result = await run(process.execPath, [script, '--db', '/nonexistent/siren-agg.db']).catch((error) => error);
    expect(result.code).not.toBe(0);
  });
});
