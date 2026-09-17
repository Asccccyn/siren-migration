/** WebSocket 端到端：真实 Fastify + 真实 ws 客户端 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp, waitFor } from './helpers.ts';

interface Collected {
  texts: Record<string, unknown>[];
  binaries: number;
}

function collect(socket: WebSocket): Collected {
  const out: Collected = { texts: [], binaries: 0 };
  socket.on('message', (data, isBinary) => {
    if (isBinary) out.binaries++;
    else out.texts.push(JSON.parse(String(data)));
  });
  return out;
}

describe('实时通话 WebSocket e2e', () => {
  it('完整通话协议：token 握手 -> start/end -> asr/pcm/pcm_end -> close 清理', async () => {
    const siren = await buildTestApp();
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const address = siren.app.server!.address() as { port: number };
    try {
      const createRes = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-e2e' }
      });
      const { call_id: callId, token } = createRes.json() as { call_id: string; token: string };

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${callId}?token=${token}`);
      const frames = collect(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });

      socket.send(JSON.stringify({ t: 'ready' }));
      socket.send(JSON.stringify({ t: 'start' }));
      socket.send(Buffer.alloc(3200, 1)); // 100ms PCM16
      socket.send(Buffer.alloc(3200, 1));
      socket.send(JSON.stringify({ t: 'end' }));
      await waitFor(() => frames.texts.some((m) => m.t === 'pcm_end'), 10000);
      await waitFor(() =>
        frames.texts.some((m) => m.t === 'state' && m.state === 'listening' && frames.texts.some((x) => x.t === 'pcm_end'))
      );

      const types = frames.texts.map((m) => m.t);
      expect(types).toContain('asr');
      expect(types).toContain('state');
      expect(types).toContain('pcm');
      expect(types).toContain('reply');
      expect(types).toContain('metrics');
      expect(frames.binaries).toBeGreaterThan(5);

      // 关闭后会话清理（约束 25/29：close 后无残留）
      socket.close(1000);
      await waitFor(() => siren.callCenter.activeCount === 0);
    } finally {
      await siren.dispose();
    }
  });

  it('过期 / 无效 token：关闭码 4001', async () => {
    const siren = await buildTestApp({ CALL_TOKEN_TTL_S: '0' });
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const address = siren.app.server!.address() as { port: number };
    try {
      const createRes = await siren.app.inject({ method: 'POST', url: '/v1/calls', payload: { conversation_id: 'conv-token' } });
      const { call_id: callId, token } = createRes.json() as { call_id: string; token: string };
      await new Promise((resolve) => setTimeout(resolve, 20)); // 让 ttl=0 过期

      const closed = new Promise<{ code: number }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${callId}?token=${token}`);
        socket.on('close', (code) => resolve({ code }));
      });
      const { code } = await closed;
      expect(code).toBe(4001);

      // 知道 URL 但没有 token 也连不上（约束 36）
      const noToken = new Promise<{ code: number }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${callId}`);
        socket.on('close', (code) => resolve({ code }));
      });
      expect((await noToken).code).toBe(4001);
    } finally {
      await siren.dispose();
    }
  });

  it('Barge-in over WebSocket：abort 后收到 interrupted 并回 listening', async () => {
    const siren = await buildTestApp();
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const address = siren.app.server!.address() as { port: number };
    try {
      const createRes = await siren.app.inject({ method: 'POST', url: '/v1/calls', payload: { conversation_id: 'conv-token' } });
      const { call_id: callId, token } = createRes.json() as { call_id: string; token: string };
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${callId}?token=${token}`);
      const frames = collect(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });

      socket.send(JSON.stringify({ t: 'start' }));
      socket.send(Buffer.alloc(3200, 1));
      socket.send(JSON.stringify({ t: 'end' }));
      await waitFor(() => frames.texts.some((m) => m.t === 'pcm'));
      socket.send(JSON.stringify({ t: 'abort' }));

      await waitFor(() => frames.texts.some((m) => m.t === 'interrupted'));
      await waitFor(() =>
        frames.texts.some((m) => m.t === 'state' && m.state === 'listening' && frames.texts.some((x) => x.t === 'interrupted'))
      );
      socket.close(1000);
      await waitFor(() => siren.callCenter.activeCount === 0);
    } finally {
      await siren.dispose();
    }
  });

  it('P0-5：token 冻结上下文，握手 query 无法改写 conversation / profile', async () => {
    const siren = await buildTestApp();
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const address = siren.app.server!.address() as { port: number };
    try {
      const createRes = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-frozen', voice_profile: 'main' }
      });
      const created = createRes.json() as { call_id: string; token: string; conversation_id: string; voice_profile: string };
      expect(created.conversation_id).toBe('conv-frozen');
      expect(createRes.statusCode).toBe(201);

      // 客户端尝试用 query 改写 conversation / profile —— 必须被忽略
      const url = `ws://127.0.0.1:${address.port}/ws/call/${created.call_id}` +
        `?token=${created.token}&conversation_id=conv-hijack&voice_profile=other`;
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const session = siren.callCenter.getSession(created.call_id);
      expect(session?.conversationId).toBe('conv-frozen');

      // 同一 callId 第二次连接按设计拒绝（4002）
      const second = new Promise<{ code: number }>((resolve) => {
        const dup = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${created.call_id}?token=${created.token}`);
        dup.on('close', (code) => resolve({ code }));
      });
      expect((await second).code).toBe(4002);

      socket.close(1000);
      // 挂断后 token 吊销，重放被拒（4001）
      await waitFor(() => siren.callCenter.activeCount === 0);
      const replay = new Promise<{ code: number }>((resolve) => {
        const dup = new WebSocket(`ws://127.0.0.1:${address.port}/ws/call/${created.call_id}?token=${created.token}`);
        dup.on('close', (code) => resolve({ code }));
      });
      expect((await replay).code).toBe(4001);
    } finally {
      await siren.dispose();
    }
  });

  it('P0-4.5：缺少 conversation_id 的建呼被拒绝（400）', async () => {
    const siren = await buildTestApp();
    try {
      const res = await siren.app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_body');
    } finally {
      await siren.dispose();
    }
  });
});
