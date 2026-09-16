import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.ts';

describe('REST 校验与鉴权', () => {
  it('POST /v1/voice/synthesize：非法 body 返回 400', async () => {
    const siren = await buildTestApp();
    try {
      const empty = await siren.app.inject({ method: 'POST', url: '/v1/voice/synthesize', payload: {} });
      expect(empty.statusCode).toBe(400);
      const tooLong = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: 'x'.repeat(5000) }
      });
      expect(tooLong.statusCode).toBe(400);
      const badEmotion = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: 'hi', emotion: 'angry-ness' }
      });
      expect(badEmotion.statusCode).toBe(400);
    } finally {
      await siren.dispose();
    }
  });

  it('POST /v1/voice/synthesize：正常返回音频与头', async () => {
    const siren = await buildTestApp();
    try {
      const res = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: '你好，世界。', emotion: 'warm', speed: 1.0 }
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('audio/');
      expect(Number(res.headers['x-siren-duration-ms'])).toBeGreaterThan(0);
      expect(res.body.length).toBeGreaterThan(0);
    } finally {
      await siren.dispose();
    }
  });

  it('GET /health 返回 200 与 provider 信息', async () => {
    const siren = await buildTestApp();
    try {
      const res = await siren.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const payload = res.json() as Record<string, unknown>;
      expect(payload.status).toBe('ok');
      expect(payload.providers).toBeTruthy();
    } finally {
      await siren.dispose();
    }
  });

  it('配置 SIREN_INTERNAL_TOKEN 后未带 token 的写操作 401，带 token 放行', async () => {
    const siren = await buildTestApp({ SIREN_INTERNAL_TOKEN: 'secret-1' });
    try {
      const denied = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: {},
        headers: {}
      });
      expect(denied.statusCode).toBe(401);

      const healthOpen = await siren.app.inject({ method: 'GET', url: '/health' });
      expect(healthOpen.statusCode).toBe(200);

      const allowed = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: {},
        headers: { authorization: 'Bearer secret-1' }
      });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await siren.dispose();
    }
  });

  it('POST /v1/calls：非法 body 400，正常 201 且返回 ws_url/token', async () => {
    const siren = await buildTestApp();
    try {
      const bad = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 123 }
      });
      expect(bad.statusCode).toBe(400);

      const ok = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-rest' }
      });
      expect(ok.statusCode).toBe(201);
      const payload = ok.json() as Record<string, unknown>;
      expect(String(payload.call_id)).toBeTruthy();
      expect(String(payload.ws_url)).toContain('/ws/call/');
      expect(String(payload.token).length).toBeGreaterThan(10);
      expect(String(payload.expires_at)).toBeTruthy();
    } finally {
      await siren.dispose();
    }
  });

  it('GET /v1/voice/messages：非法 query 400，正常返回列表', async () => {
    const siren = await buildTestApp();
    try {
      const bad = await siren.app.inject({ method: 'GET', url: '/v1/voice/messages?limit=abc' });
      expect(bad.statusCode).toBe(400);
      const ok = await siren.app.inject({ method: 'GET', url: '/v1/voice/messages?conversation_id=nope' });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await siren.dispose();
    }
  });
});
