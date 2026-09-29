/**
 * 2026-09-27 审计 P1 修复回归：
 * - F01：URL 编码（/%76%31/calls、//v1/calls、/m%63p 等）不再绕过内部鉴权；
 *        显式开放路径（/health、/v1/assets、/ws）保持开放；带 token 的编码路径仍能命中路由
 * - F02：WebSocket 合法 JSON 但非法消息（null / 数字 / 缺字段）只关闭当前连接
 *        （PROTOCOL_ERROR + error 帧），进程与其他会话不受影响
 * - F04：常见大小（256 KiB）multipart 上传在时限内完成；超限上传 413
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp, waitFor } from './helpers.ts';
import type { FastifyInstance } from 'fastify';
import type { SirenApp } from '../apps/server/src/app.ts';

async function listen(siren: SirenApp & { app: FastifyInstance }): Promise<number> {
  await siren.app.listen({ host: '127.0.0.1', port: 0 });
  return (siren.app.server!.address() as { port: number }).port;
}

describe('F01：鉴权路径归一化（默认拒绝）', () => {
  it('URL 编码的受保护路径不再绕过 Bearer 鉴权', async () => {
    const siren = await buildTestApp({ SIREN_INTERNAL_TOKEN: 'secret-1' });
    try {
      // 编码 /v1 与 /mcp：不带 token 全部 401（旧实现 201/200 直接过）
      const encodedCalls = await siren.app.inject({
        method: 'POST',
        url: '/%76%31/calls',
        payload: { conversation_id: 'conv-enc' }
      });
      expect(encodedCalls.statusCode).toBe(401);

      const encodedMcp = await siren.app.inject({ method: 'POST', url: '/m%63p' });
      expect(encodedMcp.statusCode).toBe(401);

      const encodedList = await siren.app.inject({ method: 'GET', url: '/%76%31/voice/messages' });
      expect(encodedList.statusCode).toBe(401);

      // 双斜杠 / 混合编码变体
      const doubleSlash = await siren.app.inject({
        method: 'POST',
        url: '//v1/calls',
        payload: { conversation_id: 'conv-enc' }
      });
      expect(doubleSlash.statusCode).toBe(401);
      const encodedSlash = await siren.app.inject({ method: 'GET', url: '/v1%2fvoice/messages' });
      expect(encodedSlash.statusCode).toBe(401);

      // 带 token 的编码路径仍命中原路由（修复不能靠"拒绝路由"实现）
      const allowed = await siren.app.inject({
        method: 'POST',
        url: '/%76%31/calls',
        payload: { conversation_id: 'conv-enc' },
        headers: { authorization: 'Bearer secret-1' }
      });
      expect(allowed.statusCode).toBe(201);

      // 开放路径不受影响
      expect((await siren.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await siren.app.inject({ method: 'GET', url: '/v1/assets/x.wav' })).statusCode).not.toBe(401);
    } finally {
      await siren.dispose();
    }
  });

  it('未配置 token 时不启用鉴权（开发默认行为不变）', async () => {
    const siren = await buildTestApp();
    try {
      const res = await siren.app.inject({
        method: 'POST',
        url: '/%76%31/calls',
        payload: { conversation_id: 'conv-open' }
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await siren.dispose();
    }
  });
});

describe('F02：WebSocket 消息运行时校验', () => {
  it.each([
    ['null', 'null'],
    ['数字', '123'],
    ['数组', '["start"]'],
    ['缺 t', '{"stream_id":"out_1"}'],
    ['非法 t', '{"t":"make_coffee"}'],
    ['playback_drained 缺 stream_id', '{"t":"playback_drained"}']
  ])('非法消息 %s：error 帧 + 关闭码 4004，进程存活', async (_name, raw) => {
    const siren = await buildTestApp();
    const port = await listen(siren);
    try {
      const created = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-f02' }
      });
      const { call_id: callId, token } = created.json() as { call_id: string; token: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/call/${callId}?token=${token}`);
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (data) => frames.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(raw);
      const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
      expect(await closed).toBe(4004);
      await waitFor(() => frames.some((m) => m.t === 'error' && m.code === 'invalid_message'));
      // 会话已被清理
      await waitFor(() => siren.callCenter.activeCount === 0);
    } finally {
      await siren.dispose();
    }
  });

  it('合法 JSON 帧不受影响（ready/start/ping 仍正常）', async () => {
    const siren = await buildTestApp();
    const port = await listen(siren);
    try {
      const created = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-f02-ok' }
      });
      const { call_id: callId, token } = created.json() as { call_id: string; token: string };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/call/${callId}?token=${token}`);
      const frames: Record<string, unknown>[] = [];
      socket.on('message', (data) => frames.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } }));
      socket.send(JSON.stringify({ t: 'ping' }));
      await waitFor(() => frames.some((m) => m.t === 'pong'));
      expect(frames.some((m) => m.t === 'ready')).toBe(true);
      socket.close(1000);
    } finally {
      await siren.dispose();
    }
  });
});

describe('F04：multipart 上传流式落盘', () => {
  it('256 KiB 录音上传在 5s 内完成（旧实现 256KiB 起挂起）', async () => {
    const siren = await buildTestApp();
    const port = await listen(siren);
    try {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array(256 * 1024)], { type: 'audio/wav' }), 'voice.wav');
      const startedAt = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/v1/voice/transcribe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(5000) // 旧实现在这里超时
      });
      expect(response.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      const payload = (await response.json()) as { text?: string };
      expect(payload.text).toBeTruthy();
    } finally {
      await siren.dispose();
    }
  });

  it('超过 MAX_UPLOAD_BYTES 的上传 413 快速失败', async () => {
    const siren = await buildTestApp({ MAX_UPLOAD_MB: '1' });
    const port = await listen(siren);
    try {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'audio/wav' }), 'big.wav');
      const response = await fetch(`http://127.0.0.1:${port}/v1/voice/transcribe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(5000)
      });
      expect(response.status).toBe(413);
      const payload = (await response.json()) as { error?: string };
      expect(payload.error).toBe('audio_too_large');
    } finally {
      await siren.dispose();
    }
  });
});
