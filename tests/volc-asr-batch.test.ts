/**
 * F06（2026-09-27 审计）：火山批量 ASR 必须整套对齐官方「大模型录音文件识别·极速版」
 * （POST /api/v3/auc/bigmodel/recognize/flash）：
 * - 鉴权头 X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Request-Id / X-Api-Sequence
 * - 成败看响应头 X-Api-Status-Code=20000000（HTTP 可能恒 200），不是 body code
 * - 文本在 result.text；时长取 result.utterances[].end_time（毫秒）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VolcBatchAsrProvider } from '@siren/provider-volc-asr';

const config = {
  appId: 'app-1',
  accessToken: 'token-1',
  resourceId: 'volc.bigasr.auc_turbo',
  endpointUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
  timeoutMs: 5000
};

const audio = Buffer.alloc(3200, 1);

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; headers?: Record<string, string>; body?: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String((input as RequestInfo).toString());
    const { status, headers, body } = handler(url, init);
    return new Response(JSON.stringify(body ?? {}), { status, headers });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VolcBatchAsrProvider（F06：v3 极速版协议对齐）', () => {
  it('成功路径：请求头/请求体符合 v3 flash，文本取 result.text，时长取 utterance end_time', async () => {
    const spy = mockFetch(() => ({
      status: 200,
      headers: { 'x-api-status-code': '20000000' },
      body: {
        result: {
          text: '你好，世界。',
          utterances: [
            { text: '你好，', start_time: 0, end_time: 800 },
            { text: '世界。', start_time: 800, end_time: 1250 }
          ]
        }
      }
    }));

    const result = await new VolcBatchAsrProvider(config).transcribe({ audio, format: 'wav' });
    expect(result.text).toBe('你好，世界。');
    expect(result.durationMs).toBe(1250);
    expect(result.language).toBe('zh-CN');

    const init = (spy.mock.calls[0]?.[1] ?? {}) as RequestInit & { headers: Record<string, string> };
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Api-App-Key']).toBe('app-1');
    expect(headers['X-Api-Access-Key']).toBe('token-1');
    expect(headers['X-Api-Resource-Id']).toBe('volc.bigasr.auc_turbo');
    expect(headers['X-Api-Sequence']).toBe('-1');
    expect(headers['Authorization']).toBeUndefined(); // v1 的 Bearer;token 不再发送
    const body = JSON.parse(String(init.body)) as {
      user: { uid: string };
      audio: { data: string; format: string };
      request: { model_name: string; show_utterances: boolean };
    };
    expect(body.user.uid).toBeTruthy();
    expect(body.audio.data).toBe(audio.toString('base64'));
    expect(body.audio.format).toBe('wav');
    expect(body.request.model_name).toBe('bigmodel');
    expect(body.request.show_utterances).toBe(true);
  });

  it('F06+：新版单 API Key 模式走 X-Api-Key 单头，不再发 App-Key/Access-Key', async () => {
    const spy = mockFetch(() => ({
      status: 200,
      headers: { 'x-api-status-code': '20000000' },
      body: { result: { text: 'ok' } }
    }));
    await new VolcBatchAsrProvider({ ...config, appId: '', accessToken: '', apiKey: 'new-style-key' }).transcribe({
      audio,
      format: 'wav'
    });
    const init = (spy.mock.calls[0]?.[1] ?? {}) as RequestInit & { headers: Record<string, string> };
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('new-style-key');
    expect(headers['X-Api-App-Key']).toBeUndefined();
    expect(headers['X-Api-Access-Key']).toBeUndefined();
    expect(headers['X-Api-Resource-Id']).toBe('volc.bigasr.auc_turbo');
  });

  it('业务失败：响应头 X-Api-Status-Code != 20000000 报 asr_failed（HTTP 200 也不算成功）', async () => {
    mockFetch(() => ({
      status: 200,
      headers: { 'x-api-status-code': '40000004', 'x-api-message': 'invalid resource id' },
      body: {}
    }));
    // 旧实现注入官方成功响应会被当业务错误（成功码写死 1000000/0）
    await expect(
      new VolcBatchAsrProvider(config).transcribe({ audio, format: 'wav' })
    ).rejects.toMatchObject({ code: 'asr_failed' });
  });

  it('成功状态码缺失 / 空 payload / HTTP 错误均明确 asr_failed', async () => {
    mockFetch(() => ({ status: 200, body: {} }));
    await expect(
      new VolcBatchAsrProvider(config).transcribe({ audio, format: 'wav' })
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'asr_failed' });

    mockFetch(() => ({ status: 200, headers: { 'x-api-status-code': '20000000' }, body: {} }));
    await expect(
      new VolcBatchAsrProvider(config).transcribe({ audio, format: 'wav' })
    ).rejects.toMatchObject({ code: 'asr_failed' });

    mockFetch(() => ({ status: 503, body: {} }));
    await expect(
      new VolcBatchAsrProvider(config).transcribe({ audio, format: 'wav' })
    ).rejects.toMatchObject({ code: 'asr_failed' });
  });

  it('空音频 invalid_audio；webm/opus 等容器如实透传', async () => {
    await expect(
      new VolcBatchAsrProvider(config).transcribe({ audio: Buffer.alloc(0), format: 'wav' })
    ).rejects.toMatchObject({ code: 'invalid_audio' });

    const spy = mockFetch(() => ({
      status: 200,
      headers: { 'x-api-status-code': '20000000' },
      body: { result: { text: 'ok' } }
    }));
    await new VolcBatchAsrProvider(config).transcribe({ audio, format: 'webm;codecs=opus' });
    const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body)) as { audio: { format: string } };
    expect(body.audio.format).toBe('webm');
  });
});
