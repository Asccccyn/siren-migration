import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.ts';

describe('唯一入口与最终静态缓存头', () => {
  it('编码路径同样no-cache，HTML别名不能绕过根页身份注入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-static-boundaries-'));
    const siren = await buildTestApp({ DATA_ROOT: root });
    try {
      for (const url of ['/assets/siren.css', '/ass%65ts/siren.css', '/assets/%73iren.css']) {
        const response = await siren.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-cache');
      }
      for (const url of ['/assets/voicebox.html', '/ass%65ts/voicebox.html', '/assets/voicebox%2ehtml']) {
        expect((await siren.app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect((await siren.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    } finally { await siren.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
