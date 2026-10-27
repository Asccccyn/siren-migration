import { afterEach, describe, expect, it } from 'vitest';
import { MockAsrProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import type { TtsProvider } from '@siren/contracts';
import { openDatabase, CallSessionsRepository, CallTurnsRepository, VoiceAssetsRepository } from '@siren/storage';
import { CallSession, CascadeRealtimeProvider, FillerManager } from '@siren/voice-core';
import { TEST_PROFILE, silentLogger, testConfig, waitFor } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(tts: TtsProvider, opts: { final?: string; beforePut?: (key: string) => Promise<void> } = {}) {
  const db = openDatabase(':memory:');
  const assets = new VoiceAssetsRepository(db);
  const turns = new CallTurnsRepository(db);
  new CallSessionsRepository(db).insert({ id: 'p03', conversation_id: 'primary', voice_profile: TEST_PROFILE.id,
    started_at: Date.now(), ended_at: null, status: 'active', asr_provider: 'mock', tts_provider: 'controlled', created_at: Date.now() });
  const frames: Array<Record<string, unknown>> = [];
  const audioOut: Buffer[] = [];
  const stored = new Map<string, Buffer>();
  const session = new CallSession({
    config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '2000' }), logger: silentLogger,
    callId: 'p03', conversationId: 'primary', profile: TEST_PROFILE,
    voice: new CascadeRealtimeProvider({ name: 'controlled', asr: new MockAsrProvider({ final: opts.final ?? '她的话', finalDelayMs: 1 }), tts }),
    core: new MockCoreBridge({ reply: '我在。你慢慢说。', intervalMs: 1, charsPerDelta: 100 }),
    fillers: new FillerManager('/unused-fillers', false, silentLogger),
    turnsRepo: turns,
    userAudio: { assetsRepo: assets, store: { put: async (key, bytes) => { await opts.beforePut?.(key); stored.set(key, bytes); } } },
    send: (data: unknown, binary?: Buffer) => { if (binary) { audioOut.push(binary); return; } frames.push(JSON.parse(String(data))); },
    bufferedAmount: () => 0, close: () => undefined,
  });
  cleanups.push(async () => { session.destroy('test-cleanup'); await session.settled(); db.close(); });
  session.handleMessage({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true, playback_drain: true } });
  const start = () => {
    session.handleMessage({ t: 'start', input_id: 'in_a' });
    session.handleBinary(Buffer.alloc(640, 1));
    session.handleMessage({ t: 'end', input_id: 'in_a' });
  };
  const reply = () => assets.findByMessageId('call-p03-t1-r');
  const drain = () => session.handleMessage({ t: 'playback_drained', stream_id: frames.find(f => f.t === 'pcm_end')!.stream_id as string });
  return { session, frames, audioOut, assets, turns, stored, start, reply, drain };
}

const completeTts: TtsProvider = {
  synthesize: () => { throw new Error('unexpected batch'); },
  async *synthesizeStream(request) {
    yield { audio: Buffer.alloc(960, request.text.startsWith('我') ? 3 : 7), sampleRate: 24000 };
  },
};

describe('回复音频、已发送和已播放是不同事实', () => {
  it('正常完成：真实落库、按句顺序保存，drain 才证明客户端播完', async () => {
    const h = harness(completeTts);
    h.start();
    await waitFor(() => h.frames.some(f => f.t === 'pcm_end') && !!h.reply());
    expect(h.turns.listByCall('p03')).toHaveLength(0);
    h.drain();
    await h.session.settled();
    const rec = h.reply()!;
    expect(rec.text).toBe('我在。你慢慢说。');
    expect(rec.transcript).toBe('我在。你慢慢说。');
    expect(rec.completeness).toBe('complete');
    const turn = h.turns.listAudioByCall('p03')[0]!;
    expect(turn.turn_id).toBe(rec.turnId);
    expect(turn.user_audio!.asset_id).toBe(h.assets.findByMessageId('call-p03-t1-u')!.id);
    expect(turn.reply_audio!.asset_id).toBe(rec.id);
    expect(turn.sent_audio_ms).toBe(rec.durationMs);
    expect(turn.filler_audio_ms).toBe(0);
    expect(turn.playback).toEqual({ basis: 'client_drained' });
    const wav = h.stored.get(rec.objectKey)!;
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav[44]).toBe(3);
    expect(wav[44 + 960]).toBe(7);
  });

  it('TTS 中断：保存部分 PCM，全文不能冒充部分音频的转写', async () => {
    const h = harness({
      synthesize: () => { throw new Error('unexpected batch'); },
      async *synthesizeStream() { yield { audio: Buffer.alloc(960, 3), sampleRate: 24000 }; throw new Error('controlled transport failure'); },
    });
    h.start();
    await waitFor(() => h.frames.some(f => f.t === 'pcm_end') && !!h.reply());
    h.drain();
    await h.session.settled();
    expect(h.reply()!.completeness).toBe('partial');
    expect(h.reply()!.transcript).toBeNull();
    expect(h.reply()!.text).toBe('我在。你慢慢说。');
    expect(h.turns.listByCall('p03')[0]!.outcome).toBe('tts_failed');
  });

  it('合成期间打断：立即接新输入，回收旧合成后保留部分音频和播放报告', async () => {
    const h = harness({
      synthesize: () => { throw new Error('unexpected batch'); },
      async *synthesizeStream(_request, signal) {
        yield { audio: Buffer.alloc(960, 3), sampleRate: 24000 };
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
      },
    });
    h.start();
    await waitFor(() => h.audioOut.length > 0);
    const streamId = h.frames.find(f => f.t === 'pcm')!.stream_id as string;
    const sent = h.audioOut.length;
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'in_a', new_input_id: 'in_b', playback: { stream_id: streamId, played_ms: 5 } });
    expect(h.frames.some(f => f.t === 'input_started' && f.input_id === 'in_b')).toBe(true);
    await h.session.settled();
    expect(h.reply()!.completeness).toBe('partial');
    expect(h.reply()!.transcript).toBeNull();
    expect(h.audioOut.length).toBe(sent);
    expect(h.turns.listAudioByCall('p03')[0]!.playback).toEqual({ basis: 'client_reported', played_ms: 5 });
  });

  it('发完但尚未 drain 时打断：音频仍完整，不能把生成完整误写成播放完成', async () => {
    const h = harness(completeTts);
    h.start();
    await waitFor(() => h.frames.some(f => f.t === 'pcm_end') && !!h.reply());
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'in_a', new_input_id: 'in_b' });
    await h.session.settled();
    expect(h.reply()!.completeness).toBe('complete');
    expect(h.turns.listAudioByCall('p03')[0]!.playback).toEqual({ basis: 'unknown' });
    expect(h.turns.listByCall('p03')[0]!.outcome).toBe('interrupted');
  });

  it('空 ASR 仍保留原声；挂断等待正在进行的保存后才允许关库', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(completeTts, { final: '', beforePut: () => gate });
    cleanups.unshift(async () => release());
    h.start();
    await waitFor(() => h.frames.some(f => f.t === 'notice' && f.code === 'empty_transcript'));
    h.session.destroy('client_closed');
    let settled = false;
    const saving = h.session.settled().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await saving;
    expect(h.assets.findByMessageId('call-p03-t1-u')!.transcript).toBeNull();
    expect(h.turns.listAudioByCall('p03')[0]!.user_audio).not.toBeNull();
    expect(h.reply()).toBeUndefined();
  });
});
