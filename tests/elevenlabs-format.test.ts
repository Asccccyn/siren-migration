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
});
