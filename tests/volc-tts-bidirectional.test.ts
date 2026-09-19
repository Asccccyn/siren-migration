/**
 * 火山双向流式 TTS（P0-9）：假火山服务器上验证握手 headers、
 * StartSession/TaskRequest 事件流、音频流式产出、连接复用与多路复用、
 * CancelSession(101) 真取消（服务端停止生产）、SessionFailed 上抛。
 * 连接生命周期（门控/超时清理/dispose）见 volc-tts-lifecycle.test.ts。
 */
import { describe, expect, it, afterAll } from 'vitest';
import type { PcmChunk } from '@siren/contracts';
import {
  makeProvider,
  request,
  startFakeServer,
  waitForSeen,
  type FakeServerHandle
} from './volc-tts-fake-server.ts';

const servers: FakeServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

describe('VolcBidirectionalTtsProvider（P0-9 真流式）', () => {
  it('完整事件流：握手 headers -> StartSession(speaker/audio_params) -> TaskRequest -> 音频流 -> FinishSession', async () => {
    const server = await startFakeServer({ audioChunks: 5 });
    servers.push(server);
    const tts = makeProvider(server.port);

    const chunks: PcmChunk[] = [];
    for await (const chunk of tts.synthesizeStream(request('你好，世界。'))) {
      chunks.push(chunk);
    }

    // 鉴权走 HTTP headers（不进 URL）
    expect(server.seen.headers['x-api-app-key']).toBe('app-1');
    expect(server.seen.headers['x-api-access-key']).toBe('token-1');
    expect(server.seen.headers['x-api-resource-id']).toBe('volc.service_type.10029');
    expect(server.seen.headers['x-api-connect-id']).toBeTruthy();

    // StartSession payload：speaker + audio_params（pcm/24k）
    expect(server.seen.startSessionPayloads.length).toBe(1);
    const payload = server.seen.startSessionPayloads[0].payload as {
      req_params: { speaker: string; audio_params: Record<string, unknown> };
    };
    expect(payload.req_params.speaker).toBe('zh_test_voice');
    expect(payload.req_params.audio_params).toMatchObject({ format: 'pcm', sample_rate: 24000 });

    expect(server.seen.taskRequests.map((t) => t.text)).toEqual(['你好，世界。']);
    expect(server.seen.finishSessions.length).toBe(1);

    // 音频以 provider 级流式产出（5 块），chunk 携带真实采样率
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.sampleRate === 24000)).toBe(true);
    expect(chunks[0].audio[0]).toBe(1);
    expect(chunks[4].audio[0]).toBe(5);
  });

  it('连接复用：第二次 synthesizeStream 不再重新握手（同一连接两个 session）', async () => {
    const server = await startFakeServer({ audioChunks: 2 });
    servers.push(server);
    const tts = makeProvider(server.port);

    for await (const _chunk of tts.synthesizeStream(request('第一句。'))) void _chunk;
    for await (const _chunk of tts.synthesizeStream(request('第二句。'))) void _chunk;

    expect(server.seen.startSessionPayloads.length).toBe(2);
    expect(server.seen.taskRequests.map((t) => t.text)).toEqual(['第一句。', '第二句。']);
  });

  it('并发两个 session 在同一连接上多路复用（音频不串流）', async () => {
    const server = await startFakeServer({ audioChunks: 3, chunkDelayMs: 10 });
    servers.push(server);
    const tts = makeProvider(server.port);

    const collect = async (text: string): Promise<number> => {
      let count = 0;
      for await (const _chunk of tts.synthesizeStream(request(text))) count++;
      return count;
    };
    const [a, b] = await Promise.all([collect('并发A。'), collect('并发B。')]);
    expect(a).toBe(3);
    expect(b).toBe(3);
    expect(server.seen.startSessionPayloads.length).toBe(2);
  });

  it('abort 立即终止：不再产出后续 chunk，provider 报取消，服务端停止生产', async () => {
    const server = await startFakeServer({ audioChunks: 20, chunkDelayMs: 15 });
    servers.push(server);
    const tts = makeProvider(server.port);

    const controller = new AbortController();
    const received: number[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of tts.synthesizeStream(request('长句子'), controller.signal)) {
        received.push(chunk.audio.length);
        if (received.length >= 2) controller.abort();
      }
    } catch (caught) {
      error = caught;
    }
    expect(received.length).toBeLessThan(20); // 提前终止
    expect(error).toBeTruthy(); // provider 真正抛错（而不是悄悄结束）
    // v1.1.1（审计修复）：取消走 CancelSession(101)，服务端停止剩余合成
    await waitForSeen(() => server.seen.cancelSessions.length === 1);
    const cancelledSession = server.seen.cancelSessions[0];
    await waitForSeen(() => (server.seen.serverSentChunks.get(cancelledSession) ?? 0) > 0);
    const sentAtCancel = server.seen.serverSentChunks.get(cancelledSession) ?? 0;
    await new Promise((r) => setTimeout(r, 60)); // 越过多个 chunk 周期
    expect(server.seen.serverSentChunks.get(cancelledSession)).toBe(sentAtCancel); // 不再增长
    expect(sentAtCancel).toBeLessThan(20);
  });

  it('SessionFailed 上抛为 tts_failed', async () => {
    const server = await startFakeServer({ audioChunks: 1, failSession: true });
    servers.push(server);
    const tts = makeProvider(server.port);
    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('失败句'))) void _chunk;
    }).rejects.toThrowError(/tts session failed|speaker/i);
  });

  it('审计回归：并发 A+B -> abort A -> B 完整继续（CancelSession 真取消，不杀共享连接）', async () => {
    const server = await startFakeServer({ audioChunks: 8, chunkDelayMs: 12 });
    servers.push(server);
    const tts = makeProvider(server.port);

    const controller = new AbortController();
    const aTaskIndex = server.seen.taskRequests.length; // 记录 A 的起始位置
    const collectA = (async (): Promise<number> => {
      let count = 0;
      try {
        for await (const _chunk of tts.synthesizeStream(request('通话A被抢话。'), controller.signal)) {
          count++;
          if (count >= 2) controller.abort(); // A 被 barge-in
        }
      } catch {
        // A 的取消错误
      }
      return count;
    })();
    const collectB = (async (): Promise<number> => {
      let count = 0;
      for await (const _chunk of tts.synthesizeStream(request('通话B继续说话。'))) count++;
      return count;
    })();

    const [aCount, bCount] = await Promise.all([collectA, collectB]);
    expect(aCount).toBeLessThan(8); // A 提前终止
    expect(bCount).toBe(8); // B 完整收到全部音频（连接没有被 A 的 abort 杀掉）

    const aSessionId = server.seen.taskRequests[aTaskIndex]?.sessionId;
    expect(aSessionId).toBeTruthy();
    // v1.1.1（审计修复）：取消走 CancelSession(101)，服务端真正停止 A 的剩余合成
    await waitForSeen(() => server.seen.cancelSessions.length >= 1);
    expect(server.seen.cancelSessions).toEqual([aSessionId]);
    await waitForSeen(() => server.seen.sessionCanceledAcks.length >= 1);
    expect(server.seen.sessionCanceledAcks).toEqual([aSessionId]);
    // 服务端实际停止生产 A 的音频：远小于完整 8 块，且不再增长
    await waitForSeen(() => (server.seen.serverSentChunks.get(aSessionId) ?? 0) > 0);
    const aServerChunks = server.seen.serverSentChunks.get(aSessionId) ?? 0;
    expect(aServerChunks).toBeLessThan(8);
    await new Promise((r) => setTimeout(r, 60)); // 越过若干 chunk 周期
    expect(server.seen.serverSentChunks.get(aSessionId)).toBe(aServerChunks);
    // B 在服务端完整产出
    const bSessionId = server.seen.taskRequests.find((t) => t.sessionId !== aSessionId)?.sessionId;
    expect(server.seen.serverSentChunks.get(bSessionId as string)).toBe(8);

    // FinishSession 只有 2 次：A 正常路径 1（TaskRequest 后）+ B 1；取消发 101 不再补发 102
    expect(server.seen.finishSessions.length).toBe(2);
    expect(server.seen.connections).toBe(1); // 共享连接保持存活

    // 连接仍然可用：第三个调用复用同一连接
    let third = 0;
    for await (const _chunk of tts.synthesizeStream(request('第三个通话。'))) third++;
    expect(third).toBe(8);
    expect(server.seen.connections).toBe(1);
  });

  it('审计回归：并发首次调用只建立一条连接（建连互斥，无孤儿连接）', async () => {
    const server = await startFakeServer({ audioChunks: 2, chunkDelayMs: 5 });
    servers.push(server);
    const tts = makeProvider(server.port);

    const collect = async (): Promise<number> => {
      let count = 0;
      for await (const _chunk of tts.synthesizeStream(request('并发首连。'))) count++;
      return count;
    };
    const [a, b] = await Promise.all([collect(), collect()]);
    expect(a + b).toBe(4);
    expect(server.seen.connections).toBe(1); // 没有第二个孤儿连接
  });
});
