/**
 * C11：filler 不计正文首音。
 * - LatencyTracker：first_content_audio_ms 只看首个正文（非 filler）音频；
 *   只有 filler 时为 null（不虚构），历史口径 total_first_audio_ms 保留
 * - ReplyPipeline：filler 帧与正文帧分别标记；经 CallSession 全链路验证 metrics 帧
 * - call_turns：first_audio_ms / first_content_audio_ms 两列落库（迁移 002）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LatencyTracker } from '@siren/telemetry';
import { CallSessionsRepository, CallTurnsRepository, openDatabase } from '@siren/storage';
import { FillerManager, type SirenConfig } from '@siren/voice-core';
import type { TtsProvider } from '@siren/contracts';
import { ProviderError } from '@siren/contracts';
import { buildSessionHarness, silentLogger, testConfig, waitFor } from './helpers.ts';

const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** 预生成一个 filler 目录（1s PCM16 24k 静音音频即可——标记与内容无关）。
 * TEST_PROFILE 情绪为 warm -> positive 分类 */
async function fillersWithOneClip(): Promise<FillerManager> {
  const root = await mkdtemp(join(tmpdir(), 'siren-latency-filler-'));
  scratch.push(root);
  const dir = join(root, 'main', 'positive');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '01.pcm'), Buffer.alloc(48000));
  const manager = new FillerManager(root, true, silentLogger);
  await manager.preload();
  expect(manager.available).toBe(true);
  return manager;
}

function slowContentTts(contentDelayMs: number): TtsProvider {
  return {
    async *synthesizeStream(): AsyncGenerator<{ audio: Buffer; sampleRate: number }> {
      await new Promise((resolve) => setTimeout(resolve, contentDelayMs));
      yield { audio: Buffer.alloc(480, 1), sampleRate: 24000 };
    },
    synthesize: () => Promise.reject(new Error('batch not expected'))
  };
}

function neverContentTts(): TtsProvider {
  return {
    // eslint-disable-next-line require-yield -- filler 后正文 TTS 失败（无任何正文音频）
    synthesizeStream: async function* (): AsyncGenerator<{ audio: Buffer; sampleRate: number }> {
      throw new ProviderError('tts_failed', 'controlled', 'content tts down');
    },
    synthesize: () => Promise.reject(new Error('batch not expected'))
  };
}

describe('LatencyTracker：first_content_audio_ms 独立口径（C11）', () => {
  it('只有 filler：first_content_audio_ms=null，历史口径 total_first_audio_ms 有值', () => {
    const tracker = new LatencyTracker();
    tracker.mark('speech_end', 1_000);
    tracker.mark('audio_play_request', 1_120); // filler 首帧
    tracker.setFillerPlayed();
    const metrics = tracker.compute();
    expect(metrics.total_first_audio_ms).toBe(120); // filler 计入的历史口径
    expect(metrics.first_content_audio_ms).toBeNull(); // 不虚构
    expect(metrics.filler_played).toBe(true);
  });

  it('filler 后正文：两者都有值且 total_first_audio_ms ≤ first_content_audio_ms', () => {
    const tracker = new LatencyTracker();
    tracker.mark('speech_end', 1_000);
    tracker.mark('audio_play_request', 1_120); // filler
    tracker.mark('content_audio_play_request', 1_400); // 正文首帧
    const metrics = tracker.compute();
    expect(metrics.total_first_audio_ms).toBe(120);
    expect(metrics.first_content_audio_ms).toBe(400);
    expect(metrics.total_first_audio_ms).toBeLessThanOrEqual(metrics.first_content_audio_ms!);
  });

  it('无 filler 直达正文：两者相等；无任何音频：两者皆 null', () => {
    const direct = new LatencyTracker();
    direct.mark('speech_end', 0);
    direct.mark('audio_play_request', 80);
    direct.mark('content_audio_play_request', 80);
    const m = direct.compute();
    expect(m.total_first_audio_ms).toBe(80);
    expect(m.first_content_audio_ms).toBe(80);
    expect(m.filler_played).toBe(false);

    const silent = new LatencyTracker();
    silent.mark('speech_end', 0);
    const none = silent.compute();
    expect(none.total_first_audio_ms).toBeNull();
    expect(none.first_content_audio_ms).toBeNull();
  });

  it('toDbColumns：first_audio_ms 映射历史口径，first_content_audio_ms 只算正文', () => {
    const tracker = new LatencyTracker();
    tracker.mark('speech_end', 1_000);
    tracker.mark('audio_play_request', 1_120);
    tracker.mark('content_audio_play_request', 1_400);
    const columns = tracker.toDbColumns();
    expect(columns.first_audio_ms).toBe(120);
    expect(columns.first_content_audio_ms).toBe(400);
  });
});

describe('ReplyPipeline 全链路：filler 帧不占正文首音（C11）', () => {
  async function runTurn(options: { tts: TtsProvider; config?: SirenConfig }) {
    const fillers = await fillersWithOneClip();
    const db = openDatabase(':memory:');
    const turnsRepo = new CallTurnsRepository(db);
    const sessionsRepo = new CallSessionsRepository(db);
    // call_turns.call_id 外键指向 call_sessions：先落会话行
    sessionsRepo.insert({
      id: 'call-test-1',
      conversation_id: 'conv-test',
      voice_profile: 'main',
      started_at: null,
      ended_at: null,
      status: 'active',
      asr_provider: 'mock',
      tts_provider: 'mock',
      created_at: Date.now()
    });
    const harness = buildSessionHarness({ tts: options.tts, fillers, turnsRepo, sessionsRepo, config: options.config });
    try {
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'metrics'), 8000);
      const metrics = (harness.texts().filter((m) => m.t === 'metrics').at(-1) as { metrics: Record<string, unknown> }).metrics;
      return { metrics, rows: turnsRepo.listByCall('call-test-1') };
    } finally {
      harness.session.destroy('test');
      db.close();
    }
  }

  it('filler 后正文：metrics 与 call_turns 两列都有值且 filler 首音 ≤ 正文首音', async () => {
    const { metrics, rows } = await runTurn({ tts: slowContentTts(5) });
    expect(metrics.filler_played).toBe(true);
    expect(metrics.total_first_audio_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.first_content_audio_ms).not.toBeNull();
    expect(metrics.total_first_audio_ms as number).toBeLessThanOrEqual(metrics.first_content_audio_ms as number);
    // 落库（迁移 002 后的两列）
    expect(rows).toHaveLength(1);
    expect(rows[0].first_audio_ms).not.toBeNull();
    expect(rows[0].first_content_audio_ms).not.toBeNull();
    expect(rows[0].first_audio_ms!).toBeLessThanOrEqual(rows[0].first_content_audio_ms!);
  });

  it('只有 filler（正文 TTS 失败）：first_content_audio_ms=null 且 first_audio_ms 有值', async () => {
    const { metrics, rows } = await runTurn({ tts: neverContentTts(), config: testConfig() });
    expect(metrics.filler_played).toBe(true);
    expect(metrics.total_first_audio_ms).not.toBeNull(); // filler 计入历史口径
    expect(metrics.first_content_audio_ms).toBeNull(); // 没有正文音频，不虚构
    expect(rows).toHaveLength(1);
    expect(rows[0].first_audio_ms).not.toBeNull();
    expect(rows[0].first_content_audio_ms).toBeNull();
  });
});
