/**
 * OAuth 2.1 授权服务器（单资源属主：部署者本人，即 SIREN_WEB_PASSWORD 持有者）。
 * 为只支持 OAuth 的 MCP 客户端（ChatGPT 连接器 / Claude 远程 MCP 等）提供标准接入：
 * 发现（protected-resource / authorization-server 元数据）→ 动态注册（RFC 7591）
 * → 授权码 + PKCE(S256) 换 access/refresh token。
 * access token 为 HMAC 签名无状态令牌（tokens.ts），在 auth.ts 与静态 internal token 同等放行；
 * 原有 Bearer 客户端不受影响，无需重连。
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SirenConfig } from '@siren/voice-core';
import type { Logger } from '@siren/telemetry';
import { escapeHtml } from '../routes/html.ts';
import { OAuthClientStore, RegistrationCapacityError, type OAuthClient } from './client-store.ts';
import { RevocationList } from './revocation.ts';
import { OAuthRateLimit } from './rate-limit.ts';
import { OAuthStateError } from './state-file.ts';
import {
  constantTimeEqualString,
  isCanonicalToken,
  peekTokenClaims,
  pkceS256,
  signToken,
  tokenHash,
  verifyToken
} from './tokens.ts';

const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 180 * 24 * 3600;
const CODE_TTL_MS = 10 * 60 * 1000;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface OAuthModule {
  registerRoutes(app: FastifyInstance): Promise<void>;
  /** auth.ts 回调：Bearer 是否为本模块签发的有效 access token */
  acceptBearer(token: string): boolean;
}

export function createOAuth(config: SirenConfig, logger: Logger): OAuthModule {
  const issuer = config.publicUrl;
  const store = new OAuthClientStore(config.dataDir);
  const storeReady = store.load();
  const revocation = new RevocationList(config.dataDir);
  const revocationReady = revocation.load();
  const codes = new Map<string, AuthCodeEntry>();
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const registrations = new OAuthRateLimit(10, 60);
  const revocations = new OAuthRateLimit(60, 600);

  function rateLimited(ip: string): boolean {
    const now = Date.now();
    // S1011-007：限速表定期清扫，无节制的 IP 集不再长期滞留
    if (attempts.size > 1000) {
      for (const [key, entry] of attempts) {
        if (now > entry.resetAt) attempts.delete(key);
      }
    }
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
  }

  function rememberCode(code: string, entry: AuthCodeEntry): void {
    // S1011-007：授权码表按过期时间回收
    if (codes.size > 100) {
      const now = Date.now();
      for (const [key, value] of codes) {
        if (value.expiresAt <= now) codes.delete(key);
      }
    }
    codes.set(code, entry);
  }

  function clientOf(formData: Record<string, unknown>): OAuthClient | null {
    const clientId = typeof formData.client_id === 'string' ? formData.client_id : '';
    const client = store.find(clientId);
    if (!client) return null;
    const secret = typeof formData.client_secret === 'string' ? formData.client_secret : undefined;
    if (!store.verifySecret(client, secret)) return null;
    return client;
  }

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    // OAuth 标准客户端以 form-urlencoded 调 token 端点
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    await Promise.all([storeReady, revocationReady]);
    app.addHook('onClose', async () => {
      await Promise.all([store.flush(), revocation.flush()]);
    });

    // 状态写入失败不可伪装成授权/撤销成功；错误响应不带磁盘路径或上游原文。
    app.addHook('onError', async (_request, _reply, error) => {
      if (error instanceof OAuthStateError) logger.error('oauth_state_unavailable');
    });

    // 新授权管理面仅限静态维护者凭据，voice scope 不授予管理其他客户端的权限。
    const ownerOnly = {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const supplied = request.headers.authorization?.replace(/^Bearer /, '').trim() ?? '';
        if (!config.internalToken || !constantTimeEqualString(supplied, config.internalToken)) {
          await reply.code(403).send({ error: 'owner_token_required' });
        }
      }
    };
    app.get('/v1/oauth/clients', ownerOnly, async () => ({ items: store.list() }));
    app.post('/v1/oauth/clients/:clientId/remove', ownerOnly, async (request, reply) => {
      const { clientId } = request.params as { clientId: string };
      try {
        await reply.send({ removed: await store.remove(clientId) });
      } catch {
        logger.error('oauth_state_unavailable');
        await reply.code(503).send({ error: 'oauth_storage_unavailable' });
      }
    });

    app.get('/.well-known/oauth-protected-resource', async (_req, reply) => {
      await reply
        .header('access-control-allow-origin', '*')
        .send({ resource: issuer, authorization_servers: [issuer] });
    });

    app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
      await reply
        .header('access-control-allow-origin', '*')
        .send({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['voice']
        });
    });

    app.post('/oauth/register', { bodyLimit: 16 * 1024 }, async (request, reply) => {
      if (!registrations.allow(request.ip)) {
        await reply.header('retry-after', registrations.retryAfter()).code(429).send({ error: 'too_many_requests' });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 8 ||
          !body.redirect_uris.every((uri) => typeof uri === 'string' && uri.length > 0 && Buffer.byteLength(uri) <= 2048)) {
        await reply.code(400).send({ error: 'invalid_redirect_uri', error_description: '需要 1–8 个回调地址，每个不超过 2048 字节' });
        return;
      }
      const redirectUris = body.redirect_uris as string[];
      if (body.client_name !== undefined && (typeof body.client_name !== 'string' || Buffer.byteLength(body.client_name) > 256)) {
        await reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'client_name 不超过 256 字节' });
        return;
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none' &&
          body.token_endpoint_auth_method !== 'client_secret_post') {
        await reply.code(400).send({ error: 'invalid_client_metadata', error_description: '不支持的 token_endpoint_auth_method' });
        return;
      }
      // S1011-010：结构校验——可解析、http(s)、无 fragment（存储仍按原文精确匹配）
      for (const uri of redirectUris) {
        let parsed: URL;
        try {
          parsed = new URL(uri);
        } catch {
          await reply.code(400).send({ error: 'invalid_redirect_uri', error_description: '回调地址无法解析' });
          return;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          await reply.code(400).send({ error: 'invalid_redirect_uri', error_description: '仅允许 http/https' });
          return;
        }
        if (uri.includes('#') || parsed.username || parsed.password) {
          await reply.code(400).send({ error: 'invalid_redirect_uri', error_description: '不允许携带 fragment' });
          return;
        }
      }
      const method = body.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none';
      let client: OAuthClient;
      try {
        client = await store.register({
          clientName: typeof body.client_name === 'string' && body.client_name ? body.client_name : 'mcp-client',
          redirectUris,
          tokenEndpointAuthMethod: method
        });
      } catch (error) {
        const code = error instanceof RegistrationCapacityError ? 'registration_capacity_reached' : 'oauth_storage_unavailable';
        logger.error(code);
        await reply.code(503).send({ error: code });
        return;
      }
      logger.info('oauth_client_registered', { client_id: client.clientId, method });
      const resp: Record<string, unknown> = {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      };
      if (client.clientSecret) {
        resp.client_secret = client.clientSecret;
        resp.client_secret_expires_at = 0;
      }
      await reply.code(201).send(resp);
    });

    const authorizePage = (opts: { clientName: string; hidden: string; error?: string }) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Siren 语音授权</title><link rel="stylesheet" href="/assets/siren.css"></head>
<body><main class="auth-card"><h1>Siren 语音</h1>
<p>「${escapeHtml(opts.clientName)}」请求接入你的语音服务。</p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${opts.hidden}
<input type="password" name="password" placeholder="网页登录密码" autocomplete="current-password" required>
<button type="submit">授权</button></form></main></body></html>`;

    const hiddenFields = (q: Record<string, string>): string =>
      ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method']
        .filter((k) => q[k])
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q[k]!)}">`)
        .join('\n');

    const validateAuthorize = (q: Record<string, unknown>): { ok: true; client: OAuthClient; redirectUri: string; codeChallenge: string; state: string } | { ok: false; status: number; error: string; description: string } => {
      const clientId = typeof q.client_id === 'string' ? q.client_id : '';
      const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
      const responseType = typeof q.response_type === 'string' ? q.response_type : '';
      const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
      const method = typeof q.code_challenge_method === 'string' ? q.code_challenge_method : 'S256';
      const state = typeof q.state === 'string' ? q.state : '';
      const client = store.find(clientId);
      if (!client) return { ok: false, status: 400, error: 'invalid_client', description: '未登记的 client_id' };
      if (!client.redirectUris.includes(redirectUri)) {
        return { ok: false, status: 400, error: 'invalid_redirect_uri', description: 'redirect_uri 未登记' };
      }
      if (responseType !== 'code') return { ok: false, status: 400, error: 'unsupported_response_type', description: '仅支持 code' };
      if (!codeChallenge || method !== 'S256') {
        return { ok: false, status: 400, error: 'invalid_request', description: '必须携带 PKCE S256' };
      }
      return { ok: true, client, redirectUri, codeChallenge, state };
    };

    app.get('/oauth/authorize', async (request, reply) => {
      const v = validateAuthorize(request.query as Record<string, unknown>);
      if (!v.ok) {
        await reply.code(v.status).send({ error: v.error, error_description: v.description });
        return;
      }
      await reply.header('content-type', 'text/html; charset=utf-8').send(
        authorizePage({ clientName: v.client.clientName, hidden: hiddenFields(request.query as Record<string, string>) })
      );
    });

    app.post('/oauth/authorize', async (request, reply) => {
      const form = (request.body ?? {}) as Record<string, unknown>;
      const v = validateAuthorize(form);
      if (!v.ok) {
        await reply.code(v.status).send({ error: v.error, error_description: v.description });
        return;
      }
      if (!config.webPassword) {
        await reply.code(503).send({ error: 'server_misconfigured', error_description: 'SIREN_WEB_PASSWORD 未设置' });
        return;
      }
      const ip = request.ip ?? 'unknown';
      if (rateLimited(ip)) {
        await reply.code(429).send({ error: 'too_many_attempts' });
        return;
      }
      const password = typeof form.password === 'string' ? form.password : '';
      if (!constantTimeEqualString(password, config.webPassword)) {
        logger.warn('oauth_authorize_denied', { client_id: v.client.clientId });
        await reply.header('content-type', 'text/html; charset=utf-8').send(
          authorizePage({
            clientName: v.client.clientName,
            hidden: hiddenFields(form as Record<string, string>),
            error: '密码不对，再试一次'
          })
        );
        return;
      }
      try {
        if (!(await store.authorize(v.client.clientId))) {
          await reply.code(400).send({ error: 'invalid_client' });
          return;
        }
      } catch {
        logger.error('oauth_state_unavailable');
        await reply.code(503).send({ error: 'oauth_storage_unavailable' });
        return;
      }
      attempts.delete(ip);
      const code = randomBytes(24).toString('base64url');
      rememberCode(code, {
        clientId: v.client.clientId,
        redirectUri: v.redirectUri,
        codeChallenge: v.codeChallenge,
        expiresAt: Date.now() + CODE_TTL_MS
      });
      logger.info('oauth_code_issued', { client_id: v.client.clientId });
      // S1011-010：经 URL 对象追加参数——保留合法回调地址自身的 query，不做裸字符串拼接
      const redirect = new URL(v.redirectUri);
      redirect.searchParams.set('code', code);
      if (v.state) redirect.searchParams.set('state', v.state);
      await reply.redirect(redirect.toString(), 302);
    });

    app.post('/oauth/token', async (request, reply) => {
      const form = (request.body ?? {}) as Record<string, unknown>;
      reply.header('cache-control', 'no-store');
      const grantType = typeof form.grant_type === 'string' ? form.grant_type : '';

      if (grantType === 'authorization_code') {
        const client = clientOf(form);
        if (!client) {
          await reply.code(401).send({ error: 'invalid_client' });
          return;
        }
        const code = typeof form.code === 'string' ? form.code : '';
        const redirectUri = typeof form.redirect_uri === 'string' ? form.redirect_uri : '';
        const verifier = typeof form.code_verifier === 'string' ? form.code_verifier : '';
        const entry = codes.get(code);
        codes.delete(code); // 授权码一次性
        if (
          !entry ||
          entry.expiresAt <= Date.now() ||
          entry.clientId !== client.clientId ||
          entry.redirectUri !== redirectUri ||
          !verifier ||
          !constantTimeEqualString(pkceS256(verifier), entry.codeChallenge)
        ) {
          logger.warn('oauth_code_exchange_rejected', { client_id: client.clientId });
          await reply.code(400).send({ error: 'invalid_grant' });
          return;
        }
        const accessToken = signToken(config.signingSecret, 'at', client.clientId, ACCESS_TTL_SEC);
        const refreshToken = signToken(config.signingSecret, 'rt', client.clientId, REFRESH_TTL_SEC);
        logger.info('oauth_token_issued', { client_id: client.clientId });
        await reply.send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TTL_SEC,
          refresh_token: refreshToken,
          scope: 'voice'
        });
        return;
      }

      if (grantType === 'refresh_token') {
        const client = clientOf(form);
        if (!client) {
          await reply.code(401).send({ error: 'invalid_client' });
          return;
        }
        const token = typeof form.refresh_token === 'string' ? form.refresh_token : '';
        const claims = verifyToken(config.signingSecret, token, 'rt', revocation);
        if (!claims || claims.c !== client.clientId) {
          await reply.code(400).send({ error: 'invalid_grant' });
          return;
        }
        // S1011-011：刷新令牌一次性轮换——旧 RT 立即入吊销名单（按其到期时间回收），
        // 重放旧 RT 按无效拒绝；新 RT 随本次响应发放
        try {
          await revocation.add(tokenHash(token), claims.e * 1000);
        } catch {
          logger.error('oauth_state_unavailable');
          await reply.code(503).send({ error: 'oauth_storage_unavailable' });
          return;
        }
        const accessToken = signToken(config.signingSecret, 'at', client.clientId, ACCESS_TTL_SEC);
        const refreshToken = signToken(config.signingSecret, 'rt', client.clientId, REFRESH_TTL_SEC);
        logger.info('oauth_token_refreshed', { client_id: client.clientId, rotated: true });
        await reply.send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TTL_SEC,
          refresh_token: refreshToken,
          scope: 'voice'
        });
        return;
      }

      await reply.code(400).send({ error: 'unsupported_grant_type' });
    });

    app.post('/oauth/revoke', async (request, reply) => {
      if (!revocations.allow(request.ip)) {
        await reply.header('retry-after', revocations.retryAfter()).code(429).send({ error: 'too_many_requests' });
        return;
      }
      const form = (request.body ?? {}) as Record<string, unknown>;
      const token = form.token;
      // S1011-001/007/011：只登记验签通过且未过期的规范令牌，按到期时间入持久名单
      if (isCanonicalToken(token)) {
        const claims = peekTokenClaims(config.signingSecret, token);
        if (claims) {
          try {
            await revocation.add(tokenHash(token), claims.e * 1000);
          } catch {
            logger.error('oauth_state_unavailable');
            await reply.code(503).send({ error: 'oauth_storage_unavailable' });
            return;
          }
        }
      }
      await reply.send({});
    });
  }

  return {
    registerRoutes,
    acceptBearer: (token) => {
      const claims = verifyToken(config.signingSecret, token, 'at', revocation);
      return claims !== null && store.find(claims.c) !== null;
    }
  };
}
