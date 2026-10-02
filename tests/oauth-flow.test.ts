/**
 * OAuth 2.1 授权服务器（oauth/index.ts）：
 * - 发现端点（protected-resource / authorization-server 元数据）公开可达
 * - 动态注册（DCR）→ 授权码 + PKCE(S256) → access/refresh token 全链路
 * - 密码门：错密码不发放 code；授权码一次性；错 verifier 拒绝
 * - OAuth access token 与静态 SIREN_INTERNAL_TOKEN 在受保护路径同等放行（存量客户端无需重连）
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.ts';
import { pkceS256, signToken, verifyToken } from '../apps/server/src/oauth/tokens.ts';

const PASSWORD = 'pw-test';

async function buildOauthApp() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'siren-oauth-'));
  return buildTestApp({
    SIREN_INTERNAL_TOKEN: 'secret-1',
    SIREN_WEB_PASSWORD: PASSWORD,
    DATA_ROOT: dataRoot
  });
}

const formPost = {
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' }
};
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe('OAuth：发现与注册', () => {
  it('两个 well-known 端点公开可达且互相自洽', async () => {
    const siren = await buildOauthApp();
    try {
      const pr = await siren.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
      expect(pr.statusCode).toBe(200);
      const prBody = pr.json() as { resource: string; authorization_servers: string[] };
      expect(prBody.authorization_servers).toContain(prBody.resource);

      const as = await siren.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
      expect(as.statusCode).toBe(200);
      const asBody = as.json() as Record<string, unknown>;
      expect(asBody.issuer).toBe(prBody.resource);
      expect(asBody.authorization_endpoint).toBe(`${prBody.resource}/oauth/authorize`);
      expect(asBody.registration_endpoint).toBe(`${prBody.resource}/oauth/register`);
      expect(asBody.code_challenge_methods_supported).toContain('S256');
    } finally {
      await siren.app.close();
    }
  });

  it('/mcp 未带凭证的 401 带 RFC 9727 资源元数据指针', async () => {
    const siren = await buildOauthApp();
    try {
      const res = await siren.app.inject({ method: 'POST', url: '/mcp' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
    } finally {
      await siren.app.close();
    }
  });

  it('动态注册返回 client_id（无 secret，公共客户端）', async () => {
    const siren = await buildOauthApp();
    try {
      const res = await siren.app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        payload: { client_name: 'gpt-connector', redirect_uris: ['https://client.example/cb'] }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { client_id: string; token_endpoint_auth_method: string };
      expect(body.client_id).toMatch(/^siren-/);
      expect(body.token_endpoint_auth_method).toBe('none');
    } finally {
      await siren.app.close();
    }
  });

  it('缺 redirect_uris 的注册被拒', async () => {
    const siren = await buildOauthApp();
    try {
      const res = await siren.app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        payload: { client_name: 'x' }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await siren.app.close();
    }
  });
});

describe('OAuth：授权码 + PKCE 全链路', () => {
  it('正确密码换 code，code 换 access/refresh，access token 过 Bearer 鉴权', async () => {
    const siren = await buildOauthApp();
    try {
      const reg = await siren.app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        payload: { client_name: 'gpt-connector', redirect_uris: ['https://client.example/cb'] }
      });
      const clientId = (reg.json() as { client_id: string }).client_id;
      const redirectUri = 'https://client.example/cb';
      const verifier = randomBytes(32).toString('base64url');
      const challenge = pkceS256(verifier);
      const query = `client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=st-1&code_challenge=${challenge}&code_challenge_method=S256`;

      // 授权页可打开
      const page = await siren.app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('授权');

      // 错密码：不重定向、不发放 code
      const wrong = await siren.app.inject({ ...formPost, url: '/oauth/authorize', payload: formPost2(query, 'wrong-pw') });
      expect(wrong.statusCode).toBe(200);
      expect(wrong.body).toContain('密码不对');

      // 对密码：302 带 code + state
      const ok = await siren.app.inject({ ...formPost, url: '/oauth/authorize', payload: formPost2(query, PASSWORD) });
      expect(ok.statusCode).toBe(302);
      const location = ok.headers.location ?? '';
      expect(location.startsWith(`${redirectUri}?code=`)).toBe(true);
      expect(location).toContain('state=st-1');
      const code = new URLSearchParams(location.split('?')[1] ?? '').get('code') ?? '';

      // code 换 token
      const token = await siren.app.inject({
        ...formPost,
        url: '/oauth/token',
        payload: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier
        })
      });
      expect(token.statusCode).toBe(200);
      const tb = token.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
      expect(tb.token_type).toBe('Bearer');
      expect(tb.refresh_token).toBeTruthy();

      // access token 通过受保护路径（与静态 internal token 同权）
      const api = await siren.app.inject({
        method: 'GET',
        url: '/v1/voice/messages',
        headers: { authorization: `Bearer ${tb.access_token}` }
      });
      expect(api.statusCode).toBe(200);

      // 授权码一次性：重放被拒
      const replay = await siren.app.inject({
        ...formPost,
        url: '/oauth/token',
        payload: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })
      });
      expect(replay.statusCode).toBe(400);

      // refresh token 换新 access token
      const refresh = await siren.app.inject({
        ...formPost,
        url: '/oauth/token',
        payload: form({ grant_type: 'refresh_token', refresh_token: tb.refresh_token, client_id: clientId })
      });
      expect(refresh.statusCode).toBe(200);
      const at2 = (refresh.json() as { access_token: string }).access_token;
      const api2 = await siren.app.inject({
        method: 'GET',
        url: '/v1/voice/messages',
        headers: { authorization: `Bearer ${at2}` }
      });
      expect(api2.statusCode).toBe(200);
    } finally {
      await siren.app.close();
    }
  });

  it('错 verifier 的 code 兑换被拒', async () => {
    const siren = await buildOauthApp();
    try {
      const reg = await siren.app.inject({
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        payload: { redirect_uris: ['https://client.example/cb'] }
      });
      const clientId = (reg.json() as { client_id: string }).client_id;
      const redirectUri = 'https://client.example/cb';
      const challenge = pkceS256('real-verifier-abcdef');
      const query = `client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`;
      const ok = await siren.app.inject({ ...formPost, url: '/oauth/authorize', payload: formPost2(query, PASSWORD) });
      const code = new URLSearchParams((ok.headers.location ?? '').split('?')[1] ?? '').get('code') ?? '';

      const bad = await siren.app.inject({
        ...formPost,
        url: '/oauth/token',
        payload: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: 'wrong-verifier' })
      });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string }).error).toBe('invalid_grant');
    } finally {
      await siren.app.close();
    }
  });

  it('静态 internal token（存量 Claude 等 Bearer 客户端）不受影响', async () => {
    const siren = await buildOauthApp();
    try {
      const api = await siren.app.inject({
        method: 'GET',
        url: '/v1/voice/messages',
        headers: { authorization: 'Bearer secret-1' }
      });
      expect(api.statusCode).toBe(200);
    } finally {
      await siren.app.close();
    }
  });
});

describe('OAuth：令牌签名单元', () => {
  it('签名可验、过期拒、篡改拒、类型混用拒、吊销拒', () => {
    const secret = 'test-secret';
    const revoked = new Set<string>();
    const at = signToken(secret, 'at', 'client-a', 60);
    expect(verifyToken(secret, at, 'at', revoked)?.c).toBe('client-a');
    // 过期
    const expired = signToken(secret, 'at', 'client-a', -1);
    expect(verifyToken(secret, expired, 'at', revoked)).toBeNull();
    // 篡改
    expect(verifyToken(secret, `${at}x`, 'at', revoked)).toBeNull();
    expect(verifyToken('other-secret', at, 'at', revoked)).toBeNull();
    // 类型混用（refresh 当 access 用）
    const rt = signToken(secret, 'rt', 'client-a', 60);
    expect(verifyToken(secret, rt, 'at', revoked)).toBeNull();
    // 吊销
    revoked.add(createHash('sha256').update(at).digest('hex'));
    expect(verifyToken(secret, at, 'at', revoked)).toBeNull();
  });
});

/** authorize 的 POST body：隐藏字段 + 密码 */
function formPost2(query: string, password: string): string {
  const fields = Object.fromEntries(new URLSearchParams(query));
  return new URLSearchParams({ ...fields, password }).toString();
}
