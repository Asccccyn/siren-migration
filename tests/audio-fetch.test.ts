/**
 * F03 / F21（2026-09-27 审计）：MCP voice_transcribe 的音频下载边界。
 * - F03：SSRF——回环/私网/链路本地/保留地址一律拒绝（含 DNS 解析结果与每一跳重定向）
 * - F21：大小限制在下载阶段流式生效——Content-Length 提前拒绝 + 实际字节中途取消，
 *        不允许先 arrayBuffer 全量入内存再检查
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl, downloadWithLimits, isBlockedAddress } from '../apps/server/src/mcp/tools/audio-fetch.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('回环/私网字面 IP：不发起任何 fetch 直接拒绝', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
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
    expect(spy).not.toHaveBeenCalled();
  });

  it('重定向到内网地址：每一跳都重新校验，第二跳被拒', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => Response.redirect('http://127.0.0.1:9988/inner.wav', 302))
      .mockImplementation(async () => new Response('{}'));
    await expect(
      downloadWithLimits('http://93.184.216.34/a.wav', { maxBytes: 1000, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'blocked_url' });
    expect(spy).toHaveBeenCalledTimes(1); // 第二跳的校验在 fetch 之前完成
  });

  it('Content-Length 声明超限：提前拒绝，不读 body', async () => {
    let bodyRead = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      bodyRead = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('body should not be consumed'));
          }
        }),
        { status: 200, headers: { 'content-length': String(26 * 1024 * 1024) } }
      );
    });
    // 旧实现：先 arrayBuffer 分配全部 26MiB 再检查（F21 复现：27,262,976 字节全量分配）
    await expect(
      downloadWithLimits('http://93.184.216.34/big.wav', { maxBytes: 25 * 1024 * 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bodyRead).toBe(true); // fetch 发生（声明即拒），但 body 从未被消费
  });

  it('无 Content-Length 的超量流式 body：累计越界即取消', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const chunk = new Uint8Array(1024 * 1024);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 30; i++) controller.enqueue(chunk); // 30 MiB，无长度声明
            controller.close();
          }
        }),
        { status: 200 }
      );
    });
    await expect(
      downloadWithLimits('http://93.184.216.34/chunked.wav', { maxBytes: 25 * 1024 * 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('正常下载：返回完整音频与 content-type', async () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Uint8Array(payload), { status: 200, headers: { 'content-type': 'audio/wav' } })
    );
    const result = await downloadWithLimits('http://93.184.216.34/ok.wav', { maxBytes: 1024, timeoutMs: 1000 });
    expect(Buffer.compare(result.audio, payload)).toBe(0);
    expect(result.bytes).toBe(5);
    expect(result.contentType).toBe('audio/wav');
  });

  it('多跳重定向（公网 -> 公网）允许且逐跳校验；HTTP 错误明确失败', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => Response.redirect('http://1.1.1.1/final.wav', 302))
      .mockImplementationOnce(async () => new Response(new Uint8Array([9, 9]), { status: 200 }))
      .mockImplementation(async () => new Response('nope', { status: 502 }));
    const ok = await downloadWithLimits('http://8.8.8.8/start.wav', { maxBytes: 1024, timeoutMs: 1000 });
    expect(ok.bytes).toBe(2);
    await expect(
      downloadWithLimits('http://8.8.8.8/bad.wav', { maxBytes: 1024, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'download_failed' });
  });
});
