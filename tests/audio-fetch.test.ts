/**
 * F03 / F21 / S1011-003：MCP voice_transcribe 的音频下载边界。
 * - F03：SSRF——回环/私网/链路本地/保留地址一律拒绝（含 DNS 解析结果与每一跳重定向）
 * - F21：大小限制在下载阶段流式生效——Content-Length 提前拒绝 + 实际字节中途取消
 * - S1011-003：DNS 重绑定防护——连接用自定义 lookup 钉住校验时的解析结果，
 *   校验后解析变化（重绑定）不影响实际连接地址
 *
 * 网络层全部走桩：vi.mock node:http / node:dns/promises（ESM 具名导入经模块工厂替换）。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, request: vi.fn(actual.request) };
});
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

import * as http from 'node:http';
import * as dns from 'node:dns/promises';
import { assertPublicHttpUrl, downloadWithLimits, isBlockedAddress } from '../apps/server/src/mcp/tools/audio-fetch.ts';

beforeEach(() => {
  vi.mocked(http.request).mockReset();
  vi.mocked(dns.lookup).mockReset();
});

/**IncomingMessage 桩：headers/statusCode + 异步迭代 body + destroy */
class FakeRes extends EventEmitter {
  readonly headers: Record<string, string>;
  readonly statusCode: number;
  destroyed = false;
  private readonly chunks: Buffer[];
  private readError: Error | null = null;
  constructor(options: { statusCode?: number; headers?: Record<string, string>; chunks?: Buffer[]; readError?: Error }) {
    super();
    this.statusCode = options.statusCode ?? 200;
    this.headers = options.headers ?? {};
    this.chunks = options.chunks ?? [];
    this.readError = options.readError ?? null;
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.readError) throw this.readError;
    for (const chunk of this.chunks) yield chunk;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

/**ClientRequest 桩：end() 立即投递 response */
function stubRequest(res: FakeRes): void {
  vi.mocked(http.request).mockImplementation((() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.end = () => {
      queueMicrotask(() => req.emit('response', res));
    };
    req.destroy = (error?: Error) => {
      queueMicrotask(() => req.emit('error', error ?? new Error('aborted')));
    };
    return req;
  }) as unknown as typeof http.request);
}

describe('isBlockedAddress（F03：地址判定）', () => {
  it.each([
    '127.0.0.1', // 回环
    '127.255.255.254',
    '10.0.0.5', // RFC1918
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // 链路本地（云元数据）
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // 组播
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1', // 链路本地 v6
    'fc00::1', // ULA
    'ff02::1', // 组播 v6
    '::ffff:127.0.0.1', // v4-mapped
    '::ffff:169.254.169.254',
    '2001:db8::1' // 文档段
  ])('%s 被禁止', (host) => {
    expect(isBlockedAddress(host)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2400:cb00:2049::1'])(
    '%s 放行（公网单播）',
    (host) => {
      expect(isBlockedAddress(host)).toBe(false);
    }
  );
});

describe('assertPublicHttpUrl / downloadWithLimits（F03+F21）', () => {
  it('非 http(s) 协议被拒', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'blocked_url' });
    await expect(assertPublicHttpUrl('ftp://example.com/a.wav')).rejects.toMatchObject({ code: 'blocked_url' });
  });

  it('回环/私网字面 IP：不发起任何请求直接拒绝', async () => {
    stubRequest(new FakeRes({ chunks: [Buffer.alloc(1)] }));
    for (const url of [
      'http://127.0.0.1:8080/audio.wav',
      'http://10.0.0.5/audio.wav',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/audio.wav',
      'http://[::ffff:127.0.0.1]/audio.wav'
    ]) {
      await expect(downloadWithLimits(url, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({
        code: 'blocked_url'
      });
    }
    expect(http.request).not.toHaveBeenCalled();
  });

  it('重定向到内网地址：每一跳都重新校验，第二跳被拒', async () => {
    stubRequest(new FakeRes({ statusCode: 302, headers: { location: 'http://127.0.0.1:9988/inner.wav' } }));
    await expect(
      downloadWithLimits('http://93.184.216.34/a.wav', { maxBytes: 1000, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'blocked_url' });
    expect(http.request).toHaveBeenCalledTimes(1); // 第二跳的校验在请求之前完成
  });

  it('Content-Length 声明超限：提前拒绝，不读 body', async () => {
    stubRequest(
      new FakeRes({
        statusCode: 200,
        headers: { 'content-length': String(26 * 1024 * 1024) },
        readError: new Error('body should not be consumed')
      })
    );
    await expect(
      downloadWithLimits('http://93.184.216.34/big.wav', { maxBytes: 25 * 1024 * 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('无 Content-Length 的超量流式 body：累计越界即取消', async () => {
    stubRequest(
      new FakeRes({
        statusCode: 200,
        chunks: [Buffer.alloc(1024 * 1024 * 30)] // 30 MiB，无长度声明
      })
    );
    await expect(
      downloadWithLimits('http://93.184.216.34/chunked.wav', { maxBytes: 25 * 1024 * 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('正常下载：返回完整音频与 content-type', async () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    stubRequest(new FakeRes({ statusCode: 200, headers: { 'content-type': 'audio/wav' }, chunks: [payload] }));
    const result = await downloadWithLimits('http://93.184.216.34/ok.wav', { maxBytes: 1024, timeoutMs: 1000 });
    expect(Buffer.compare(result.audio, payload)).toBe(0);
    expect(result.bytes).toBe(5);
    expect(result.contentType).toBe('audio/wav');
  });

  it('多跳重定向（公网 -> 公网）允许且逐跳校验；HTTP 错误明确失败', async () => {
    const resps = [
      new FakeRes({ statusCode: 302, headers: { location: 'http://1.1.1.1/final.wav' } }),
      new FakeRes({ statusCode: 200, chunks: [Buffer.from([9, 9])] }),
      new FakeRes({ statusCode: 502, chunks: [Buffer.from('nope')] })
    ];
    let call = 0;
    vi.mocked(http.request).mockImplementation((() => {
      const res = resps[call]!;
      call += 1;
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      req.end = () => queueMicrotask(() => req.emit('response', res));
      req.destroy = (e?: Error) => queueMicrotask(() => req.emit('error', e ?? new Error('aborted')));
      return req;
    }) as unknown as typeof http.request);
    const ok = await downloadWithLimits('http://8.8.8.8/start.wav', { maxBytes: 1024, timeoutMs: 1000 });
    expect(ok.bytes).toBe(2);
    await expect(
      downloadWithLimits('http://8.8.8.8/bad.wav', { maxBytes: 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'download_failed' });
  });
});

describe('S1011-003：DNS 解析钉住（重绑定防护）', () => {
  it('连接 lookup 用校验时的解析结果；校验后解析变化不影响连接地址', async () => {
    const validated = [{ address: '93.184.216.34', family: 4 }];
    vi.mocked(dns.lookup).mockResolvedValue(validated as never);
    let captured: { lookup?: unknown } = {};
    vi.mocked(http.request).mockImplementation((((
      _url: unknown,
      options: { lookup?: unknown }
    ) => {
      captured = options;
      const res = new FakeRes({ statusCode: 200, chunks: [Buffer.from([7])] });
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
      req.end = () => queueMicrotask(() => req.emit('response', res));
      req.destroy = (e?: Error) => queueMicrotask(() => req.emit('error', e ?? new Error('aborted')));
      return req;
    }) as unknown) as typeof http.request);

    const result = await downloadWithLimits('http://media.example-a.test/a.wav', {
      maxBytes: 1024,
      timeoutMs: 1000
    });
    expect(result.bytes).toBe(1);

    // 校验后攻击者把 DNS 改指私网（重绑定）——连接器 lookup 仍只返回已校验地址
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    expect(typeof captured.lookup).toBe('function');
    let got: unknown = null;
    (captured.lookup as unknown as (h: string, o: unknown, cb: (e: Error | null, a: unknown) => void) => void)(
      'media.example-a.test',
      {},
      (_err, addresses) => {
        got = addresses;
      }
    );
    expect(got).toEqual(validated);
    // 字面 IP 目标不注入 lookup（连接天然绑定）
    await downloadWithLimits('http://8.8.8.8/x.wav', { maxBytes: 16, timeoutMs: 1000 }).catch(() => undefined);
    expect(http.request).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ lookup: expect.anything() })
    );
  });

  it('解析出私网地址：拒绝且不发起请求', async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '192.168.1.5', family: 4 }] as never);
    stubRequest(new FakeRes({ chunks: [Buffer.alloc(1)] }));
    await expect(
      downloadWithLimits('http://media.example-b.test/a.wav', { maxBytes: 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'blocked_url' });
    expect(http.request).not.toHaveBeenCalled();
  });
});
