import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../packages/voice-core/src/config.ts';
import { createLogger } from '../packages/telemetry/src/logger.ts';
import { createOAuth } from '../apps/server/src/oauth/index.ts';
import { registerAuthHook } from '../apps/server/src/auth.ts';
import { OAuthClientStore } from '../apps/server/src/oauth/client-store.ts';
import { RevocationList } from '../apps/server/src/oauth/revocation.ts';
import { signToken, tokenHash } from '../apps/server/src/oauth/tokens.ts';

vi.mock('../apps/server/src/oauth/state-file.ts', async (original) => {
  const actual = await original<typeof import('../apps/server/src/oauth/state-file.ts')>();
  return { ...actual, writeOAuthState: vi.fn(actual.writeOAuthState) };
});
import { OAuthStateError, writeOAuthState } from '../apps/server/src/oauth/state-file.ts';
const realWrite = (await vi.importActual<typeof import('../apps/server/src/oauth/state-file.ts')>('../apps/server/src/oauth/state-file.ts')).writeOAuthState;
const secret = 'synthetic-oauth-state-secret';
const internal = 'synthetic-owner-token';
const registration = { redirect_uris: ['https://client.example.invalid/cb'] };
const input = { clientName: 'audit', redirectUris: registration.redirect_uris, tokenEndpointAuthMethod: 'none' as const };
const directories: string[] = [];
const apps: FastifyInstance[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'siren-state-test-'));
  directories.push(path);
  return path;
}
async function appAt(path: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  const config = loadConfig({ NODE_ENV: 'test', DATA_ROOT: path, SIREN_INTERNAL_TOKEN: internal, SIREN_SIGNING_SECRET: secret });
  const oauth = createOAuth(config, createLogger({ sink: () => undefined }));
  registerAuthHook(app, config, oauth.acceptBearer);
  await oauth.registerRoutes(app);
  app.get('/private', async () => ({ ok: true }));
  return app;
}
function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
}
function access(app: FastifyInstance, token: string) {
  return app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${token}` } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => { vi.mocked(writeOAuthState).mockReset().mockImplementation(realWrite); });
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OAuth durable state', () => {
  it('撤销响应和flush等待提交；成功后重建模块仍拒绝原token', async () => {
    const path = await directory(); const app = await appAt(path);
    const client = (await post(app, '/oauth/register', registration)).json();
    const token = signToken(secret, 'at', client.client_id, 3600);
    expect((await access(app, token)).statusCode).toBe(200);
    const entered = deferred(), release = deferred();
    vi.mocked(writeOAuthState).mockImplementationOnce(async (file, value) => {
      entered.resolve(); await release.promise; await realWrite(file, value);
    });
    let answered = false;
    const response = post(app, '/oauth/revoke', { token }).then((r) => { answered = true; return r; });
    await entered.promise;
    expect(answered).toBe(false);
    expect((await access(app, token)).statusCode).toBe(401);
    release.resolve();
    expect((await response).statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(path, 'oauth-revoked.json'), 'utf8'))).toHaveProperty(tokenHash(token));
    expect((await access(await appAt(path), token)).statusCode).toBe(401);
  });

  it('写入失败返回503，不发新refresh；失败也不让本进程旧token复活', async () => {
    const path = await directory(); const app = await appAt(path);
    const client = (await post(app, '/oauth/register', registration)).json();
    const token = signToken(secret, 'rt', client.client_id, 3600);
    vi.mocked(writeOAuthState).mockRejectedValueOnce(new OAuthStateError());
    const response = await post(app, '/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'oauth_storage_unavailable' });
    expect((await post(app, '/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token })).statusCode).toBe(400);
    // 管理端可重试撤销，将保守的内存拒绝可靠提交。
    expect((await post(app, '/oauth/revoke', { token })).statusCode).toBe(200);
    const restarted = await appAt(path);
    expect((await post(restarted, '/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token })).statusCode).toBe(400);
  });

  it.each(['{broken', '[]', '{"invalid-hash":9999999999999}'])('名单损坏%s阻止启用OAuth', async (body) => {
    const path = await directory(); await writeFile(join(path, 'oauth-revoked.json'), body);
    await expect(appAt(path)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it('同一refresh并发只成功一次，返回成功即已持久化', async () => {
    const path = await directory(); const app = await appAt(path);
    const client = (await post(app, '/oauth/register', registration)).json();
    const token = signToken(secret, 'rt', client.client_id, 3600);
    const payload = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token };
    const responses = await Promise.all([post(app, '/oauth/token', payload), post(app, '/oauth/token', payload)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect((await post(await appAt(path), '/oauth/token', payload)).statusCode).toBe(400);
  });

  it('flush等待未完成提交，写失败对关闭者可见', async () => {
    const list = new RevocationList(await directory()); await list.load();
    const entered = deferred(), release = deferred();
    vi.mocked(writeOAuthState).mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new OAuthStateError(); });
    const addition = list.add('a'.repeat(64), Date.now() + 60_000);
    const rejected = expect(addition).rejects.toBeInstanceOf(OAuthStateError);
    await entered.promise;
    let flushed = false;
    const flushing = list.flush().finally(() => { flushed = true; });
    const flushRejected = expect(flushing).rejects.toBeInstanceOf(OAuthStateError);
    await Promise.resolve(); expect(flushed).toBe(false);
    release.resolve(); await rejected; await flushRejected;
  });
});

describe('DCR admission and recoverable capacity', () => {
  it('失败注册不发布内存状态，后续并发提交与重载一致', async () => {
    const path = await directory(); const store = new OAuthClientStore(path); await store.load();
    vi.mocked(writeOAuthState).mockRejectedValueOnce(new OAuthStateError());
    await expect(store.register(input)).rejects.toBeInstanceOf(OAuthStateError);
    expect(store.size).toBe(0);
    const clients = await Promise.all(Array.from({ length: 12 }, () => store.register(input)));
    const reloaded = new OAuthClientStore(path); await reloaded.load();
    expect(reloaded.size).toBe(12);
    for (const client of clients) expect(reloaded.find(client.clientId)).not.toBeNull();
  });

  it('容量回收只淘汰pending；已授权/旧档案保护，未授权注册可到期', async () => {
    const path = await directory(); const now = Date.now();
    const clients = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`client-${i}`, {
      clientId: `client-${i}`, clientSecret: null, tokenEndpointAuthMethod: 'none', redirectUris: registration.redirect_uris,
      clientName: 'fixture', createdAt: new Date(now - i * 1000).toISOString(), ...(i === 0 ? {} : { authorizedAt: null })
    }]));
    await writeFile(join(path, 'oauth-clients.json'), JSON.stringify({ clients }));
    const store = new OAuthClientStore(path); await store.load();
    await store.authorize('client-199');
    const fresh = await store.register(input);
    expect(store.size).toBe(200);
    expect(store.find('client-0')).not.toBeNull();
    expect(store.find('client-199')).not.toBeNull();
    expect(store.find('client-198')).toBeNull();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 3600_000);
    expect(store.find(fresh.clientId)).toBeNull();
    expect(store.find('client-199')).not.toBeNull();
    nowSpy.mockRestore();
  });

  it('每IP与全局限速有界，并返回Retry-After；合法标准注册仍可用', async () => {
    const app = await appAt(await directory());
    for (let i = 0; i < 10; i++) expect((await post(app, '/oauth/register', registration)).statusCode).toBe(201);
    const denied = await post(app, '/oauth/register', registration);
    expect(denied.statusCode).toBe(429); expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    for (let ip = 1; ip <= 5; ip++) {
      for (let n = 0; n < 10; n++) expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: registration, remoteAddress: `192.0.2.${ip}` })).statusCode).toBe(201);
    }
    expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: registration, remoteAddress: '192.0.2.99' })).statusCode).toBe(429);
  });

  it('限制元数据字节和URI数量，不回显非法URI或秘密', async () => {
    const app = await appAt(await directory());
    for (const payload of [
      { ...registration, client_name: '人'.repeat(86) },
      { redirect_uris: Array(9).fill('https://client.example.invalid/cb') },
      { redirect_uris: ['https://client.example.invalid/' + 'a'.repeat(2048)] },
      { redirect_uris: ['https://user:private-secret@client.example.invalid/'] }
    ]) {
      const response = await post(app, '/oauth/register', payload);
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain('private-secret');
    }
    expect((await post(app, '/oauth/register', { ...registration, extra: 'x'.repeat(17 * 1024) })).statusCode).toBe(413);
  });

  it('管理接口须Bearer、不返回secret；删除使access及refresh失效并跨重启保持', async () => {
    const path = await directory(); const app = await appAt(path);
    const client = (await post(app, '/oauth/register', { ...registration, token_endpoint_auth_method: 'client_secret_post' })).json();
    const token = signToken(secret, 'at', client.client_id, 3600);
    expect((await access(app, token)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/oauth/clients' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/oauth/clients', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    const headers = { authorization: `Bearer ${internal}` };
    const listing = await app.inject({ method: 'GET', url: '/v1/oauth/clients', headers });
    expect(listing.statusCode).toBe(200); expect(listing.body).not.toContain(client.client_secret);
    expect((await post(app, `/v1/oauth/clients/${client.client_id}/remove`, {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/oauth/clients/${client.client_id}/remove`, headers })).json()).toEqual({ removed: true });
    expect((await access(app, token)).statusCode).toBe(401);
    expect((await access(await appAt(path), token)).statusCode).toBe(401);
  });
});
