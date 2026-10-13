import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpCoreBridge, type CoreTurnInput } from '@siren/core-bridge';

afterEach(() => vi.unstubAllGlobals());
const input: CoreTurnInput = { callId: 'audit-call', turnId: 'audit-turn', text: 'synthetic', modality: 'voice_call' };

function openBody(lines: unknown[]) {
  let canceled = 0;
  let signal: AbortSignal | undefined;
  let posted: Record<string, unknown> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join('\n') + '\n')); },
    cancel() { canceled++; }
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    posted = JSON.parse(String(init.body));
    return new Response(body);
  }));
  return { body, canceled: () => canceled, aborted: () => signal?.aborted, posted: () => posted };
}

describe('Core HTTP response ownership', () => {
  it('done retires an open HTTP body and ignores later frames', async () => {
    const response = openBody([{ type: 'delta', text: 'before' }, { type: 'done' }, { type: 'delta', text: 'after' }, { type: 'error', message: 'ignored' }]);
    const bridge = new HttpCoreBridge({ baseUrl: 'https://never-called.invalid' });
    const texts = [];
    for await (const delta of bridge.streamReply(input)) texts.push(delta.text);
    expect(texts).toEqual(['before']);
    expect(response.canceled()).toBe(1);
    expect(response.aborted()).toBe(true);
    expect(response.body.locked).toBe(false);
  });

  it('consumer return and Core error release the same body ownership', async () => {
    for (const fail of [false, true]) {
      const response = openBody(fail ? [{ type: 'error', message: 'synthetic' }] : [{ type: 'delta', text: 'prefix' }]);
      const bridge = new HttpCoreBridge({ baseUrl: 'https://never-called.invalid' });
      const iterator = bridge.streamReply(input);
      if (fail) await expect(iterator.next()).rejects.toMatchObject({ code: 'core_stream_error' });
      else { await iterator.next(); await iterator.return(undefined); }
      expect(response.canceled()).toBe(1);
      expect(response.body.locked).toBe(false);
      expect(response.aborted()).toBe(true);
    }
  });

  it('forwards interruption context with explicitly client-reported playback, not heard text', async () => {
    const response = openBody([{ type: 'done' }]);
    const bridge = new HttpCoreBridge({ baseUrl: 'https://never-called.invalid' });
    for await (const delta of bridge.streamReply({ ...input, interruptedTurn: { turnId: 'old-turn', inputId: 'old-input', outputStreamId: 'old-stream', playback: { basis: 'client_reported', playedMs: 35 } } })) void delta;
    expect(response.posted()?.interrupted_turn).toEqual({ turn_id: 'old-turn', input_id: 'old-input', output_stream_id: 'old-stream', playback: { basis: 'client_reported', played_ms: 35 } });
  });
});
