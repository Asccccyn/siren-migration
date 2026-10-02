/**
 * OAuth 2.1 授权服务器（单资源属主：部署者本人，即 SIREN_WEB_PASSWORD 持有者）。
 * 为只支持 OAuth 的 MCP 客户端（ChatGPT 连接器 / Claude 远程 MCP 等）提供标准接入：
 * 发现（protected-resource / authorization-server 元数据）→ 动态注册（RFC 7591）
 * → 授权码 + PKCE(S256) 换 access/refresh token。
 * access token 为 HMAC 签名无状态令牌（tokens.ts），在 auth.ts 与静态 internal token 同等放行；
 * 原有 Bearer 客户端不受影响，无需重连。
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SirenConfig } from '@siren/voice-core';
import type { Logger } from '@siren/telemetry';
import { escapeHtml } from '../routes/html.ts';
import { OAuthClientStore, type OAuthClient } from './client-store.ts';
import {
  constantTimeEqualString,
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
  const codes = new Map<string, AuthCodeEntry>();
  const revoked = new Set<string>();
  const attempts = new Map<string, { count: number; resetAt: number }>();

  function rateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
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
    await storeReady;

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

    app.post('/oauth/register', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];
      if (redirectUris.length === 0) {
        await reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris 必填' });
        return;
      }
      const method = body.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none';
      const client = await store.register({
        clientName: typeof body.client_name === 'string' && body.client_name ? body.client_name : 'mcp-client',
        redirectUris,
        tokenEndpointAuthMethod: method
      });
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
      attempts.delete(ip);
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        clientId: v.client.clientId,
        redirectUri: v.redirectUri,
        codeChallenge: v.codeChallenge,
        expiresAt: Date.now() + CODE_TTL_MS
      });
      logger.info('oauth_code_issued', { client_id: v.client.clientId });
      const stateQuery = v.state ? `&state=${encodeURIComponent(v.state)}` : '';
      await reply.redirect(`${v.redirectUri}?code=${encodeURIComponent(code)}${stateQuery}`, 302);
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
        const claims = verifyToken(config.signingSecret, token, 'rt', revoked);
        if (!claims || claims.c !== client.clientId) {
          await reply.code(400).send({ error: 'invalid_grant' });
          return;
        }
        const accessToken = signToken(config.signingSecret, 'at', client.clientId, ACCESS_TTL_SEC);
        logger.info('oauth_token_refreshed', { client_id: client.clientId });
        await reply.send({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TTL_SEC,
          refresh_token: token,
          scope: 'voice'
        });
        return;
      }

      await reply.code(400).send({ error: 'unsupported_grant_type' });
    });

    app.post('/oauth/revoke', async (request, reply) => {
      const form = (request.body ?? {}) as Record<string, unknown>;
      const token = typeof form.token === 'string' ? form.token : '';
      if (token) revoked.add(tokenHash(token));
      await reply.send({});
    });
  }

  return {
    registerRoutes,
    acceptBearer: (token) => verifyToken(config.signingSecret, token, 'at', revoked) !== null
  };
}
