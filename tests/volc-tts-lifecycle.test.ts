/**
 * 火山双向流式 TTS 连接生命周期（v1.1.1 审计修复）：
 * - ConnectionStarted 门控（StartSession 不抢跑）
 * - 就绪超时必须关闭 socket（不积累孤儿连接）
 * - dispose 打断 in-flight 建连（连接不复活、socket 被关闭、后续调用拒绝）
 */
import { describe, expect, it, afterAll } from 'vitest';
import { makeProvider, request, startFakeServer, type FakeServerHandle } from './volc-tts-fake-server.ts';

const servers: FakeServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

describe('VolcBidirectionalTtsProvider 连接生命周期（v1.1.1 审计修复）', () => {
  it('审计回归：StartConnection 未收到 ConnectionStarted 前不发 StartSession（门控）', async () => {
    const server = await startFakeServer({ audioChunks: 1, noStartAck: true });
    servers.push(server);
    const tts = makeProvider(server.port, { connectTimeoutMs: 400, sessionTimeoutMs: 2000 });
    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('不该开始'))) void _chunk;
    }).rejects.toThrowError(/timeout|connection/i);
    // 关键断言：连接未就绪时 StartSession 从未发出
    expect(server.seen.startSessionPayloads.length).toBe(0);
  });

  it('v1.1.1 审计回归：ConnectionStarted 超时必须关闭 socket（不积累孤儿连接）', async () => {
    const server = await startFakeServer({ audioChunks: 1, noStartAck: true });
    servers.push(server);
    const tts = makeProvider(server.port, { connectTimeoutMs: 300, sessionTimeoutMs: 2000 });

    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('超时句'))) void _chunk;
    }).rejects.toThrowError(/timeout|connection/i);
    // 超时路径 kill 了 socket：服务端观察到客户端断开（旧实现只 settleReady，socket 悬挂）
    await new Promise((r) => setTimeout(r, 150));
    expect(server.seen.clientCloses).toBe(1);

    // 二次调用同样失败，且同样关闭——连续失败不积累僵尸连接
    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('再超时'))) void _chunk;
    }).rejects.toThrowError(/timeout|connection/i);
    expect(server.seen.connections).toBe(2); // 每次各建一条
    await new Promise((r) => setTimeout(r, 150));
    expect(server.seen.clientCloses).toBe(2); // 但每条都被关闭
  });

  it('v1.1.1 审计回归：dispose 打断 in-flight 建连，连接不复活、socket 被关闭', async () => {
    const server = await startFakeServer({ audioChunks: 2, startAckDelayMs: 120 });
    servers.push(server);
    const tts = makeProvider(server.port, { connectTimeoutMs: 3000, sessionTimeoutMs: 2000 });

    // 建连进行中（服务端延迟 120ms 才回 ConnectionStarted）时 dispose
    const pending = (async () => {
      for await (const _chunk of tts.synthesizeStream(request('来不及了'))) void _chunk;
    })();
    await new Promise((r) => setTimeout(r, 30)); // WS 已建立、ready 未回
    tts.dispose();
    await expect(pending).rejects.toThrowError(/disposed/i);

    // in-flight 连接 resolve 后被 kill（不写回 provider）：服务端看到断开
    await new Promise((r) => setTimeout(r, 300));
    expect(server.seen.clientCloses).toBe(1);
    // dispose 后新调用直接拒绝
    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('已关停'))) void _chunk;
    }).rejects.toThrowError(/disposed/i);
  });
});
