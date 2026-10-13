import { afterEach, describe, expect, it, vi } from 'vitest';
import { VolcBatchTtsProvider, VolcBidirectionalTtsProvider } from '@siren/provider-volc-tts';
import { ElevenLabsTtsProvider } from '@siren/provider-elevenlabs';
import { buildProviders } from '@siren/voice-core';
import type { BatchTtsProvider, TtsRequest } from '@siren/contracts';
import { TEST_PROFILE, silentLogger, testConfig } from './helpers.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request: TtsRequest = { text: '受控测试', profile: TEST_PROFILE, style: { emotion: 'warm', speed: 1 }, format: 'pcm', sampleRate: 24000 };

describe('batch operations own a caller cancellation signal', () => {
  it.each(['volc', 'elevenlabs'])('%s batch HTTP aborts the actual fetch', async (kind) => {
    let actualSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      actualSignal = init.signal ?? undefined;
      actualSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const provider: BatchTtsProvider = kind === 'volc'
      ? new VolcBatchTtsProvider({ appId: 'fake', accessToken: 'fake', cluster: 'fake', endpointUrl: 'https://never-called.invalid', timeoutMs: 15000 })
      : new ElevenLabsTtsProvider({ apiKey: 'fake', modelId: 'fake', baseUrl: 'https://never-called.invalid', timeoutMs: 15000 });
    const caller = new AbortController();
    const pending = provider.synthesize(request, caller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(actualSignal?.aborted).toBe(false);
    caller.abort();
    expect(actualSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
  });

  it('API-key batch aggregation forwards the same signal to the bidi session', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.spyOn(VolcBidirectionalTtsProvider.prototype, 'synthesizeStream').mockImplementation(async function* (_request, signal) {
      seenSignal = signal;
      yield* [];
      signal?.throwIfAborted();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('session canceled')), { once: true }));
    });
    const config = testConfig({ VOLC_API_KEY: 'synthetic', ASR_PROVIDER: 'mock', ASYNC_TTS_PROVIDER: 'volc', REALTIME_TTS_PROVIDER: 'volc', SIREN_CORE_BRIDGE: 'mock' });
    const providers = buildProviders(config, silentLogger);
    const caller = new AbortController();
    try {
      const pending = providers.asyncTts.synthesize(request, caller.signal);
      expect(seenSignal).toBe(caller.signal);
      caller.abort();
      expect(seenSignal?.aborted).toBe(true);
      await expect(pending).rejects.toThrow(/aborted|session canceled/);
    } finally { providers.dispose?.(); }
  });
});
