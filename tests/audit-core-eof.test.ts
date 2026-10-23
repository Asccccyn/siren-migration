import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpCoreBridge } from '@siren/core-bridge';

afterEach(() => vi.unstubAllGlobals());

describe('independent audit: Core stream requires a logical terminal', () => {
  it.each([
    ['{"type":"delta","text":"半截"}\n', 'core_stream_incomplete'],
    ['{"type":"delta","text":"半截"}\nnot-json\n{"type":"done"}\n', 'core_invalid_response']
  ])('rejects incomplete/corrupt NDJSON without silently completing', async (body, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const bridge = new HttpCoreBridge({ baseUrl: 'https://fake.invalid' });
    const received: string[] = [];
    await expect((async () => {
      for await (const delta of bridge.streamReply({ callId: 'c', turnId: 't', text: 'audit', modality: 'voice_call' })) received.push(delta.text);
    })()).rejects.toMatchObject({ code });
    expect(received).toEqual(['半截']);
  });
});
