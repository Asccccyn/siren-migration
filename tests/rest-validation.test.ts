import { describe, expect, it } from 'vitest';
import { buildTestApp, waitFor } from './helpers.ts';

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

  it('联合审计 A01：真实 HTTP 客户端断开 → 取消直达 provider；正常请求不被误取消', async () => {
    const seen: Array<{ signal: AbortSignal | undefined; abortedAtReturn: boolean }> = [];
    let hold = false;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const siren = await buildTestApp({}, (providers) => {
      const mock = providers.asyncTts;
      providers.asyncTts = {
        synthesize: async (request, signal) => {
          const record = { signal, abortedAtReturn: false };
          seen.push(record);
          if (hold) {
            entered();
            await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
            record.abortedAtReturn = signal?.aborted ?? false;
            signal?.throwIfAborted();
          }
          const result = await mock.synthesize(request, signal);
          record.abortedAtReturn = signal?.aborted ?? false;
          return result;
        }
      };
    });
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = siren.app.server!.address() as { port: number };
    const url = `http://127.0.0.1:${port}/v1/voice/synthesize`;
    try {
      const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '正常合成。' }) });
      expect(ok.status).toBe(200);
      expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(seen[0]!.signal).toBeDefined();
      expect(seen[0]!.abortedAtReturn).toBe(false); // 请求体正常读完不等于取消

      hold = true;
      const client = new AbortController();
      const pending = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '断开前在合成。' }), signal: client.signal }).catch((error: unknown) => error);
      await providerEntered;
      client.abort();
      await waitFor(() => seen[1]?.abortedAtReturn === true);
      expect(await pending).toBeInstanceOf(Error);
      expect(seen).toHaveLength(2); // 断开不触发任何补偿重合成
    } finally {
      await siren.dispose();
    }
  });

  it('联合审计 A01-F02/F04：operation_id 合成——生成即持久；同键重放同一资产不重付；异参冲突；独立发言不合并', async () => {
    let synthCount = 0;
    const siren = await buildTestApp({}, (providers) => {
      const mock = providers.asyncTts;
      providers.asyncTts = {
        synthesize: async (request, signal) => {
          synthCount++;
          return mock.synthesize(request, signal);
        }
      };
    });
    const opKey = 'voice-say:aaaaaaaaaaaaaaaaaaaaaaaa';
    try {
      const first = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: '同一个操作。', operation_id: opKey }
      });
      expect(first.statusCode).toBe(200);
      expect(synthCount).toBe(1);
      expect(first.headers['x-siren-replayed']).toBe('false');
      const assetId = first.headers['x-siren-voice-asset-id'];
      expect(typeof assetId).toBe('string');
      // 生成即持久：资产已可按操作身份查回（响应丢失前就处于该状态）
      const listed = await siren.app.inject({ method: 'GET', url: `/v1/voice/messages?message_id=${opKey}` });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { items: Array<{ id: string }> }).items.some((i) => i.id === assetId)).toBe(true);
      // F02：响应在 est 保存前丢失 → 同操作恢复拿到同一资产同一字节，provider 不再调用
      const second = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: '同一个操作。', operation_id: opKey }
      });
      expect(second.statusCode).toBe(200);
      expect(second.headers['x-siren-replayed']).toBe('true');
      expect(second.headers['x-siren-voice-asset-id']).toBe(assetId);
      expect(second.body).toEqual(first.body);
      expect(synthCount).toBe(1);
      // 同键异参（speed 变了）：明确冲突，不静默返回不匹配音频，不再合成
      const conflict = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: '同一个操作。', operation_id: opKey, speed: 1.5 }
      });
      expect(conflict.statusCode).toBe(409);
      expect((conflict.json() as { error: string }).error).toBe('operation_conflict');
      expect((conflict.json() as { differs: string[] }).differs).toContain('speed');
      expect(synthCount).toBe(1);
      // F04：两次独立同文语音各有独立身份——不按文本 hash 全局去重
      const other = await siren.app.inject({
        method: 'POST',
        url: '/v1/voice/synthesize',
        payload: { text: '同一个操作。', operation_id: 'voice-say:bbbbbbbbbbbbbbbbbbbbbbbb' }
      });
      expect(other.statusCode).toBe(200);
      expect(other.headers['x-siren-voice-asset-id']).not.toBe(assetId);
      expect(synthCount).toBe(2);
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

  it('P1-6：transcribe 用文件 part 的 mimetype 推断格式（m4a 不再误判为 webm）', async () => {
    const siren = await buildTestApp();
    await siren.app.listen({ host: '127.0.0.1', port: 0 });
    const address = siren.app.server!.address() as { port: number };
    try {
      const form = new FormData();
      form.append(
        'audio',
        new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mp4' }),
        'voice.m4a'
      );
      form.append('store', 'true');
      form.append('message_id', 'msg-m4a-1');

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/voice/transcribe`, {
        method: 'POST',
        body: form
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { voice_message_id?: string };
      expect(payload.voice_message_id).toBeTruthy();

      const message = await fetch(`http://127.0.0.1:${address.port}/v1/voice/messages/${payload.voice_message_id}`);
      // part mimetype=audio/mp4 -> m4a（旧实现会把 multipart 主 content-type 误判成 webm）
      expect(await message.json()).toMatchObject({ audio_format: 'm4a' });
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
        payload: { conversation_id: 'conv-auth' },
        headers: {}
      });
      expect(denied.statusCode).toBe(401);

      const healthOpen = await siren.app.inject({ method: 'GET', url: '/health' });
      expect(healthOpen.statusCode).toBe(200);

      const allowed = await siren.app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: { conversation_id: 'conv-auth' },
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
