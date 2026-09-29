import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { LocalObjectStore } from '@siren/storage';
import { loadConfig } from '@siren/voice-core';
import { registerAssetsRoute } from '../apps/server/src/routes/assets.ts';

describe('本地签名音频资产 Range', () => {
  it('Range 请求返回 206 / Content-Range / 精确字节片段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-range-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      SIREN_SIGNING_SECRET: 'range-secret'
    });
    const store = new LocalObjectStore({
      rootDir: root,
      publicBaseUrl: 'http://siren.test',
      signingSecret: config.signingSecret
    });
    const key = 'voice/test/audio.wav';
    await store.put(key, Buffer.from('0123456789'), 'audio/wav');

    const app = Fastify();
    registerAssetsRoute(app, { config, store });
    const signed = new URL(await store.signedUrl(key, 60));

    const partial = await app.inject({
      method: 'GET',
      url: `${signed.pathname}${signed.search}`,
      headers: { range: 'bytes=2-5' }
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['accept-ranges']).toBe('bytes');
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.headers['content-length']).toBe('4');
    expect(partial.rawPayload.equals(Buffer.from('2345'))).toBe(true);

    const invalid = await app.inject({
      method: 'GET',
      url: `${signed.pathname}${signed.search}`,
      headers: { range: 'bytes=99-100' }
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');

    await app.close();
  });
});
