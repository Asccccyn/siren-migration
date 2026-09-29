/**
 * P1-2：ElevenLabs 输出格式显式映射（不再 MP3 bytes 伪装 wav/pcm）
 * + 官方 /stream 端点增量读取 + AbortSignal。
 */
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsProvider } from '@siren/provider-elevenlabs';
import type { TtsRequest, VoiceProfile } from '@siren/contracts';

const PROFILE: VoiceProfile = {
  id: 'el',
  displayName: '测试',
  language: 'zh-CN',
  provider: 'elevenlabs',
  voiceId: 'voice-1',
  defaultEmotion: 'neutral',
  defaultSpeed: 1.0
};

function request(format: 'mp3' | 'wav' | 'pcm', sampleRate?: number): TtsRequest {
  return { text: '你好', profile: PROFILE, style: { emotion: 'neutral' }, format, sampleRate };
}

function provider(): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider({
    apiKey: 'k',
    modelId: 'm',
    baseUrl: 'https://el.test',
    timeoutMs: 5000
  });
}

function mockFetchOnce(handler: (url: string) => { status: number; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    const url = String((input as RequestInfo).toString());
    const { status, body } = handler(url);
    return new Response(body as BodyInit, { status });
  });
}

describe('ElevenLabs 格式映射（P1-2）', () => {
  it('请求 mp3：output_format=mp3_44100_128，返回如实 mp3/44100', async () => {
    const spy = mockFetchOnce(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
    const result = await provider().synthesize(request('mp3'));
    expect(result.format).toBe('mp3');
    expect(result.sampleRate).toBe(44100);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('output_format=mp3_44100_128');
    spy.mockRestore();
  });

  it('请求 wav/pcm：映射到 pcm_{rate}，如实返回 pcm（不再伪装 wav）', async () => {
    const spy = mockFetchOnce(() => ({ status: 200, body: new Uint8Array(3200) }));
    const wav = await provider().synthesize(request('wav', 24000));
    expect(wav.format).toBe('pcm'); // 不是伪装的 wav
    expect(wav.sampleRate).toBe(24000);
    expect(wav.durationMs).toBeGreaterThan(0);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('output_format=pcm_24000');
    spy.mockRestore();
  });

  it('不支持的 pcm 采样率直接 unsupported_format，不伪装', async () => {
    await expect(provider().synthesize(request('pcm', 11025))).rejects.toThrowError(/unsupported|11025/);
  });

  it('流式：官方 /stream 端点 + 增量读取 + chunk 携带真实采样率 + abort', async () => {
    const pcm = new Uint8Array(480 * 2 * 5); // 5 帧 @24k 20ms
    const spy = mockFetchOnce((url) => {
      expect(url).toContain('/v1/text-to-speech/voice-1/stream');
      expect(url).toContain('output_format=pcm_24000');
      return { status: 200, body: pcm };
    });
    const chunks = [];
    for await (const chunk of provider().synthesizeStream(request('pcm', 24000))) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.sampleRate === 24000)).toBe(true);
    spy.mockRestore();

    // abort：fetch signal 取消 -> 迭代抛错
    const abortSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _chunk of provider().synthesizeStream(request('pcm', 24000), controller.signal)) {
        void _chunk;
      }
    }).rejects.toThrow();
    abortSpy.mockRestore();
  });

  it('F17：speed 传官方 voice_settings.speed（0.7–1.2），不再误写 stability', async () => {
    const bodies: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array(480 * 2), { status: 200 });
    });

    await provider().synthesize({ ...request('pcm', 24000), style: { emotion: 'warm', speed: 0.7 } });
    await provider().synthesize({ ...request('pcm', 24000), style: { emotion: 'warm', speed: 1.5 } });
    spy.mockRestore();

    const first = bodies[0] as { voice_settings: Record<string, number> };
    const second = bodies[1] as { voice_settings: Record<string, number> };
    // speed=0.7 落在允许区间：原样传 speed；stability 保持情绪预设（warm=0.55）
    expect(first.voice_settings.speed).toBe(0.7);
    expect(first.voice_settings.stability).toBe(0.55);
    // 超出官方区间（0.7–1.2）静默收敛到边界，而不是覆盖 stability
    expect(second.voice_settings.speed).toBe(1.2);
    expect(second.voice_settings.stability).toBe(0.55);
  });

  it('F16：网络故障（fetch rejection / reader 异常）归类为 ProviderError tts_failed，不再透传 TypeError', async () => {
    const netFail = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    // 批量路径
    await expect(provider().synthesize(request('pcm', 24000))).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'tts_failed'
    });
    // 流式路径
    await expect(async () => {
      for await (const _chunk of provider().synthesizeStream(request('pcm', 24000))) void _chunk;
    }).rejects.toMatchObject({ name: 'ProviderError', code: 'tts_failed' });
    netFail.mockRestore();

    // reader 中途异常（body 半途损坏）同样归类
    const brokenBody = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(480 * 2));
            controller.error(new Error('stream broken'));
          }
        }),
        { status: 200 }
      )
    );
    await expect(async () => {
      for await (const _chunk of provider().synthesizeStream(request('pcm', 24000))) void _chunk;
    }).rejects.toMatchObject({ name: 'ProviderError', code: 'tts_failed' });
    brokenBody.mockRestore();
  });
});
