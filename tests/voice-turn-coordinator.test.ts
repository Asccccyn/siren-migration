import { describe, expect, it, vi } from 'vitest';
import { VoiceTurnCoordinator } from '../apps/web/src/voice-turn-coordinator.ts';

function harness(options: { limit?: number; timeout?: number } = {}) {
  const events: string[] = [];
  const json: Record<string, unknown>[] = [];
  const frames: ArrayBuffer[] = [];
  const failures: string[] = [];
  const turns = new VoiceTurnCoordinator({
    idPrefix: 'test', maxPendingBytes: options.limit, ackTimeoutMs: options.timeout,
    sendJson: (m) => { json.push(m); events.push(String(m.t)); },
    sendFrame: (f) => { frames.push(f); events.push('pcm'); },
    invalidateOutput: () => { events.push('invalidate-and-stop'); return { stream_id: 'old', played_ms: 25 }; },
    onFailure: (r) => failures.push(r)
  });
  turns.negotiate(true);
  return { turns, events, json, frames, failures };
}

describe('client input handoff ownership', () => {
  it('buffers input until its ACK, preserving PCM-before-end ordering', () => {
    const h = harness();
    h.turns.begin();
    h.turns.sendFrame(new Uint8Array([1, 2]).buffer);
    h.turns.finish();
    expect(h.frames).toHaveLength(0);
    expect(h.turns.accept({ t: 'input_started', input_id: 'test_0' })).toBe(false);
    h.turns.accept({ t: 'input_started', input_id: 'test_1' });
    expect(h.events).toEqual(['invalidate-and-stop', 'start', 'pcm', 'end']);
    expect(h.turns.accept({ t: 'input_started', input_id: 'test_1' })).toBe(false);
    expect(h.frames).toHaveLength(1);
    h.turns.reset();
  });

  it('invalidates a thinking turn before the new interrupt, even before any old PCM exists', () => {
    const h = harness();
    h.turns.begin();
    h.turns.accept({ t: 'input_started', input_id: 'test_1' });
    h.turns.begin();
    expect(h.events.slice(-2)).toEqual(['invalidate-and-stop', 'interrupt']);
    expect(h.json.at(-1)).toMatchObject({ target_input_id: 'test_1', new_input_id: 'test_2' });
    for (const t of ['pcm', 'state', 'asr', 'partial', 'reply', 'interrupted', 'metrics']) {
      expect(h.turns.accept({ t, input_id: 'test_1', state: 'listening' })).toBe(false);
    }
    expect(h.turns.accept({ t: 'pcm', input_id: 'test_2' })).toBe(true);
    h.turns.reset();
  });

  it('manual abort blocks late output, retains the target for the next handoff', () => {
    const h = harness();
    h.turns.begin();
    h.turns.abort();
    expect(h.turns.accept({ t: 'input_started', input_id: 'test_1' })).toBe(false);
    expect(h.turns.accept({ t: 'pcm', input_id: 'test_1' })).toBe(false);
    expect(h.turns.accept({ t: 'state', input_id: 'test_1', state: 'listening' })).toBe(true);
    h.turns.begin();
    expect(h.json.at(-1)).toMatchObject({ target_input_id: 'test_1', new_input_id: 'test_2' });
    h.turns.reset();
  });

  it('has bounded pending audio and a terminal ACK timeout, reset leaves no timers', () => {
    vi.useFakeTimers();
    try {
      const over = harness({ limit: 2 });
      over.turns.begin(); over.turns.sendFrame(new ArrayBuffer(4));
      expect(over.failures).toEqual(['input_buffer_overflow']);
      expect(over.json.at(-1)?.t).toBe('abort');
      const slow = harness({ timeout: 10 });
      slow.turns.begin(); vi.advanceTimersByTime(11);
      expect(slow.failures).toEqual(['input_ack_timeout']);
      slow.turns.reset(); over.turns.reset();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
