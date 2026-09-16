import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HttpCoreBridge, MockCoreBridge, type CoreDelta } from '@siren/core-bridge';
import { silentLogger } from './helpers.ts';

async function collect(iterable: AsyncIterable<CoreDelta>): Promise<string> {
  let text = '';
  for await (const delta of iterable) {
    text += delta.text;
  }
  return text;
}

describe('Core Bridge', () => {
  it('MockCoreBridge 流式输出完整句子', async () => {
    const bridge = new MockCoreBridge({ reply: '嗯，我在听。你说。', intervalMs: 1, charsPerDelta: 2 });
    const text = await collect(bridge.streamReply({ conversationId: 'c', callId: 'call', turnId: 't1', text: 'hi', modality: 'voice_call' }));
    expect(text).toBe('嗯，我在听。你说。');
  });

  it('HttpCoreBridge 解析 NDJSON delta 流', async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe('/v1/chat/stream');
      expect(request.method).toBe('POST');
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ type: 'delta', text: '你好' }) + '\n');
      response.write(JSON.stringify({ type: 'delta', text: '，' }) + '\n');
      response.write(JSON.stringify({ type: 'delta', text: '世界。' }) + '\n');
      response.write(JSON.stringify({ type: 'done' }) + '\n');
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const bridge = new HttpCoreBridge({ baseUrl: `http://127.0.0.1:${port}`, logger: silentLogger });
      const text = await collect(
        bridge.streamReply({ conversationId: 'c', callId: 'call', turnId: 't2', text: 'hi', modality: 'voice_call' })
      );
      expect(text).toBe('你好，世界。');
    } finally {
      server.close();
    }
  });

  it('HttpCoreBridge：core 流错误透传为 CoreBridgeError', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ type: 'delta', text: '开头' }) + '\n');
      response.write(JSON.stringify({ type: 'error', message: 'core exploded' }) + '\n');
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const bridge = new HttpCoreBridge({ baseUrl: `http://127.0.0.1:${port}`, logger: silentLogger });
      await expect(
        collect(bridge.streamReply({ callId: 'call', turnId: 't3', text: 'hi', modality: 'voice_call' }))
      ).rejects.toMatchObject({ code: 'core_stream_error' });
    } finally {
      server.close();
    }
  });

  it('HttpCoreBridge：不可达时报 core_unreachable', async () => {
    const bridge = new HttpCoreBridge({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, logger: silentLogger });
    await expect(
      collect(bridge.streamReply({ callId: 'call', turnId: 't4', text: 'hi', modality: 'voice_call' }))
    ).rejects.toMatchObject({ code: 'core_unreachable' });
  });

  it('cancel：中断进行中的流', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let sent = 0;
      const timer = setInterval(() => {
        response.write(JSON.stringify({ type: 'delta', text: '字' }) + '\n');
        sent++;
        if (sent > 100) {
          clearInterval(timer);
          response.end();
        }
      }, 20);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const bridge = new HttpCoreBridge({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 30000, logger: silentLogger });
    try {
      const promise = collect(bridge.streamReply({ callId: 'call', turnId: 't5', text: 'hi', modality: 'voice_call' }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await bridge.cancel('t5');
      // 取消后迭代结束（不抛 core 错误）
      const text = await promise;
      expect(text.length).toBeLessThan(100);
    } finally {
      server.close();
    }
  });
});
