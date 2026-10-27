// JV-12 / JV-13（联合审计 2026-10-26）整改验证：
// - JV-12：真实 buildProviders（volc 双件套 realtime 分支）+ 本地 HTTP 外部供应商桩——
//   realtimeTts.synthesize 的批量兜底透传 AbortSignal；abort 后供应商请求被实际取消
//   （桩观测到未响应即断开），不再"丢参后合成继续"。
// - JV-13：服务间 GET /v1/voice-assets/:id/audio 依赖 ObjectStore.get 本身——
//   非 Local 实现（MemoryObjectStore）同样可取回 bytes（修复前 app 装配只给
//   LocalObjectStore 接线，非 Local 一律 404）。
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Fastify from 'fastify';
import { MemoryObjectStore } from '@siren/storage';
import { buildProviders } from '@siren/voice-core';
import { silentLogger, testConfig } from './helpers.ts';
import { registerVoiceAssetAudioRoute } from '../apps/server/src/routes/voice-asset-audio.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('JV-12 批量兜底透传取消（真实 buildProviders + 本地 HTTP 供应商）', () => {
  it('abort 后 synthesize 拒绝且供应商请求被实际取消', async () => {
    const requestArrived = deferred<void>();
    let clientAborted = false;
    // 本地 volc v1/tts 兼容桩：收到请求即挂起，观测客户端取消（未响应先断开）
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { requestArrived.resolve(); });
      req.on('close', () => { clientAborted = true; });
      // 不写响应：挂起等取消
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as { port: number }).port;
    const cfg = testConfig({});
    (cfg as unknown as { providers: Record<string, unknown> }).providers.tts = 'volc';
    // 双件套（appId+accessToken、无 apiKey）→ realtime 批量兜底 = 真实 VolcBatchTtsProvider
    const volc = (cfg as unknown as { volc: Record<string, unknown> }).volc;
    volc.appId = 'test-app';
    volc.accessToken = 'test-token';
    volc.apiKey = '';
    volc.ttsUrl = `http://127.0.0.1:${port}/api/v1/tts`;
    const bundle = buildProviders(cfg, silentLogger);
    try {
      const controller = new AbortController();
      const p = bundle.realtimeTts.synthesize({
        text: '一句测试', format: 'mp3',
        style: { emotion: 'warm', speed: 1 },
        profile: { id: 'main', displayName: 'x', language: 'zh-CN', provider: 'volc', voiceId: 'test-voice', defaultEmotion: 'warm', defaultSpeed: 1, emotionMap: {} }
      } as never, controller.signal);
      // 等供应商请求真实到达，再取消
      const timer = setTimeout(() => controller.abort(), 3000);
      await Promise.race([requestArrived.promise, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('供应商请求未到达桩')), 5000))]);
      controller.abort();
      clearTimeout(timer);
      await expect(p).rejects.toThrow();
      // 供应商侧确实看到请求被取消（fetch abort 断开 socket）
      await new Promise<void>((r) => setTimeout(r, 150));
      expect(clientAborted).toBe(true);
    } finally {
      bundle.dispose?.();
      upstream.close();
    }
  });
});

describe('JV-13 服务间原声 GET（非 Local ObjectStore）', () => {
  it('MemoryObjectStore 保存的资产可经公开 GET 取回 bytes', async () => {
    const store = new MemoryObjectStore();
    const bytes = Buffer.from('fake-wav-bytes');
    await store.put('voice/calls/c1/audio.wav', bytes, 'audio/wav');
    const app = Fastify();
    registerVoiceAssetAudioRoute(app, {
      assetsRepo: { findById: () => ({ id: 'a1', objectKey: 'voice/calls/c1/audio.wav', audioFormat: 'wav' }) } as never,
      store
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/voice-assets/a1/audio' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.rawPayload.equals(bytes)).toBe(true);
    await app.close();
  });
});

afterEach(() => { /* 资源在各用例内清理 */ });
