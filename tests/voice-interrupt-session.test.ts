import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, parseClientWsMessage, type StreamAsrProvider, type TtsProvider } from '@siren/contracts';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge, type CoreBridge, type CoreTurnInput } from '@siren/core-bridge';
import type { CallTurnsRepository } from '@siren/storage';
import { CallCenter, CallSession, CascadeRealtimeProvider, FillerManager } from '@siren/voice-core';
import { TEST_PROFILE, silentLogger, testConfig, testProfiles, waitFor } from './helpers.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const sessions: CallSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.destroy('test-cleanup'); });

function harness(options: { asr?: StreamAsrProvider; core?: CoreBridge; tts?: TtsProvider } = {}) {
  const frames: Record<string, unknown>[] = [];
  const audio: Buffer[] = [];
  const records: Parameters<CallTurnsRepository['insert']>[0][] = [];
  const session = new CallSession({
    config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '200' }), logger: silentLogger,
    callId: 'identity-audit', conversationId: 'shared-conversation', profile: TEST_PROFILE,
    voice: new CascadeRealtimeProvider({ name: 'controlled', asr: options.asr ?? new MockAsrProvider({ final: '新输入', finalDelayMs: 1 }), tts: options.tts ?? new MockTtsProvider() }),
    core: options.core ?? new MockCoreBridge({ reply: '回复。', intervalMs: 1 }),
    fillers: new FillerManager('/unused-fillers', false, silentLogger),
    turnsRepo: { insert: (record: Parameters<CallTurnsRepository['insert']>[0]) => { records.push(record); } } as unknown as CallTurnsRepository,
    send: (data, binary) => binary ? audio.push(binary) : frames.push(JSON.parse(data)),
    bufferedAmount: () => 0, close: () => undefined
  });
  sessions.push(session);
  session.handleMessage({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } });
  return { session, frames, audio, records };
}

describe('targeted voice interruption', () => {
  it('validates bounded identities and finite client playback evidence', () => {
    expect(parseClientWsMessage({ t: 'interrupt', target_input_id: 'old', new_input_id: 'new', playback: { stream_id: 'out', played_ms: 120 } })).not.toBeNull();
    expect(parseClientWsMessage({ t: 'interrupt', target_input_id: 'old' })).toBeNull();
    expect(parseClientWsMessage({ t: 'end', input_id: 'x'.repeat(129) })).toBeNull();
    expect(parseClientWsMessage({ t: 'abort', input_id: 'old', playback: { stream_id: 'out', played_ms: Infinity } })).toBeNull();
  });

  it('accepts the next input before old cleanup, rejects stale cancellation and drops a late first PCM', async () => {
    const oldAudio = deferred<void>();
    const oldCleanup = deferred<void>();
    let streamCalls = 0;
    const inputs: CoreTurnInput[] = [];
    const cancel = vi.fn(() => oldCleanup.promise);
    const core: CoreBridge = {
      async *streamReply(input) { inputs.push(input); yield { text: '一句回复。' }; }, cancel
    };
    const tts: TtsProvider = {
      synthesize: () => Promise.reject(new Error('unexpected batch')),
      async *synthesizeStream() {
        streamCalls++;
        if (streamCalls === 1) await oldAudio.promise; // Deliberately late upstream output.
        yield { audio: Buffer.alloc(960), sampleRate: 24000 };
      }
    };
    const h = harness({ core, tts });
    try {
      h.session.handleMessage({ t: 'start', input_id: 'old' });
      h.session.handleMessage({ t: 'end', input_id: 'old' });
      await waitFor(() => streamCalls === 1);
      h.session.handleMessage({ t: 'interrupt', target_input_id: 'old', new_input_id: 'new' });
      expect(h.frames).toContainEqual({ t: 'input_started', input_id: 'new' });
      expect(h.session.state).toBe('listening');
      expect(cancel).toHaveBeenCalledTimes(1);
      h.session.handleMessage({ t: 'abort', input_id: 'old' });
      h.session.handleMessage({ t: 'end', input_id: 'old' });
      h.session.handleMessage({ t: 'interrupt', target_input_id: 'old', new_input_id: 'other' });
      expect(h.session.state).toBe('listening');
      h.session.handleMessage({ t: 'interrupt', target_input_id: 'old', new_input_id: 'new' });
      expect(cancel).toHaveBeenCalledTimes(1); // Retry only repeats acceptance.
      h.session.handleBinary(Buffer.alloc(640));
      h.session.handleMessage({ t: 'end', input_id: 'new' });
      oldAudio.resolve();
      await waitFor(() => h.frames.some((frame) => frame.t === 'pcm_end' && frame.input_id === 'new'));
      expect(h.frames.filter((frame) => frame.t === 'pcm').map((frame) => frame.input_id)).toEqual(['new']);
      expect(inputs[1].interruptedTurn).toMatchObject({ inputId: 'old', playback: { basis: 'unknown' } });
      expect(h.frames.filter((frame) => ['partial', 'asr', 'reply', 'pcm', 'pcm_end', 'metrics', 'interrupted'].includes(String(frame.t))).every((frame) => typeof frame.input_id === 'string')).toBe(true);
    } finally { oldAudio.resolve(); oldCleanup.resolve(); }
  });

  it('isolates an old ENDING final from a new input and accepts after manual cancellation', async () => {
    const final = deferred<{ text: string; language: string; durationMs: number }>();
    let calls = 0;
    const feeds: Buffer[][] = [];
    const asr: StreamAsrProvider = { async createStream(_options, handlers) {
      const index = calls++; feeds[index] = [];
      return { feed: (b) => { feeds[index].push(b); if (index === 0) handlers.onPartial?.('unfinalized draft'); }, abort() {}, end: () => index === 0 ? final.promise : Promise.resolve({ text: 'new', language: 'en', durationMs: 20 }) };
    } };
    const h = harness({ asr });
    h.session.handleMessage({ t: 'start', input_id: 'first' });
    h.session.handleBinary(Buffer.from([3, 4]));
    await Promise.resolve(); await Promise.resolve();
    h.session.handleMessage({ t: 'end', input_id: 'first' });
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'first', new_input_id: 'second' });
    h.session.handleBinary(Buffer.from([1, 2]));
    final.resolve({ text: 'stale final', language: 'en', durationMs: 20 });
    await Promise.resolve(); await Promise.resolve();
    expect(h.frames.some((frame) => frame.text === 'stale final')).toBe(false);
    expect(h.records[0]).toMatchObject({ user_text: 'unfinalized draft', interrupted: 1 });
    expect(feeds[1][0]).toEqual(Buffer.from([1, 2]));
    h.session.handleMessage({ t: 'abort', input_id: 'second' });
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'second', new_input_id: 'third' });
    expect(h.frames).toContainEqual({ t: 'input_started', input_id: 'third' });
  });

  it('requires negotiated targeting and cannot downgrade via repeated ready', () => {
    const h = harness();
    h.session.handleMessage({ t: 'start', input_id: 'keep' });
    h.session.handleMessage({ t: 'ready', capabilities: {} });
    h.session.handleMessage({ t: 'abort' });
    expect(h.frames.some((frame) => frame.code === 'input_id_required')).toBe(true);
    h.session.handleMessage({ t: 'start', input_id: 'unrelated' });
    expect(h.frames.some((frame) => frame.code === 'input_active')).toBe(true);
    expect(h.session.state).toBe('listening');
  });

  it('attributes client progress only to the targeted output and ignores old drain acknowledgements', async () => {
    const inputs: CoreTurnInput[] = [];
    const h = harness({ core: { async *streamReply(input) { inputs.push(input); yield { text: '答复。' }; }, async cancel() {} } });
    h.session.handleMessage({ t: 'ready', capabilities: { voice_interrupt: true, playback_drain: true } });
    h.session.handleMessage({ t: 'start', input_id: 'one' });
    h.session.handleMessage({ t: 'end', input_id: 'one' });
    await waitFor(() => h.frames.some((frame) => frame.t === 'pcm_end'));
    const stream = h.frames.find((frame) => frame.t === 'pcm_end')!.stream_id as string;
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'one', new_input_id: 'two', playback: { stream_id: stream, played_ms: 40 } });
    h.session.handleMessage({ t: 'playback_drained', stream_id: stream });
    expect(h.frames.filter((frame) => frame.t === 'metrics' && frame.input_id === 'one')).toHaveLength(1);
    h.session.handleMessage({ t: 'end', input_id: 'two' });
    await waitFor(() => inputs.length === 2);
    expect(inputs[1].interruptedTurn?.playback).toEqual({ basis: 'client_reported', playedMs: 40 });
  });

  it('preserves an errored half sentence with exactly one reply', async () => {
    const core: CoreBridge = { async *streamReply() { yield { text: '没有标点的半句' }; throw new Error('synthetic core failure'); }, async cancel() {} };
    const h = harness({ core });
    h.session.handleMessage({ t: 'start', input_id: 'half' });
    h.session.handleMessage({ t: 'end', input_id: 'half' });
    await waitFor(() => h.frames.some((frame) => frame.t === 'metrics'));
    expect(h.frames.filter((frame) => frame.t === 'reply')).toEqual([{ t: 'reply', text: '没有标点的半句', emotion: TEST_PROFILE.defaultEmotion, input_id: 'half' }]);
  });

  it('propagates turn cancellation into a batch fallback that has actually started', async () => {
    let batchSignal: AbortSignal | undefined;
    const tts: TtsProvider = {
      async *synthesizeStream() {
        yield* [];
        throw new ProviderError('tts_failed', 'controlled', 'stream failed before audio');
      },
      synthesize: (_request, signal) => new Promise((_resolve, reject) => {
        batchSignal = signal;
        signal?.addEventListener('abort', () => reject(new DOMException('canceled', 'AbortError')), { once: true });
      })
    };
    const h = harness({ tts });
    h.session.handleMessage({ t: 'start', input_id: 'batch' });
    h.session.handleMessage({ t: 'end', input_id: 'batch' });
    await waitFor(() => batchSignal !== undefined);
    h.session.handleMessage({ t: 'abort', input_id: 'batch' });
    expect(batchSignal!.aborted).toBe(true);
    expect(h.session.state).toBe('listening');
    expect(h.audio).toHaveLength(0);
  });
});

describe('resource admission', () => {
  it('checks capacity when pre-issued reservations become sessions and releases it on destroy', async () => {
    const center = new CallCenter({ config: testConfig({ MAX_CONCURRENT_CALLS: '1' }), logger: silentLogger, realtimeAsr: new MockAsrProvider(), realtimeTts: new MockTtsProvider(), core: new MockCoreBridge(), fillers: new FillerManager('/unused', false, silentLogger), profiles: testProfiles() });
    const first = await center.createCall({ conversationId: 'one' });
    const second = await center.createCall({ conversationId: 'two' });
    const connect = (call: typeof first) => center.createSession({ callId: call.callId, reservation: center.verifyToken(call.callId, call.token)!, send() {}, bufferedAmount: () => 0, close() {} });
    try {
      const active = connect(first)!;
      expect(() => connect(second)).toThrow('call_capacity_reached');
      expect(center.activeCount).toBe(1);
      active.destroy();
      expect(connect(second)).not.toBeNull();
      expect(center.activeCount).toBe(1);
    } finally { center.destroyAll(); }
  });
});

