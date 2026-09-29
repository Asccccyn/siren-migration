/**
 * 网页登录（人类入口）：POST /v1/web/login { password }。
 * 密码由部署者在 SIREN_WEB_PASSWORD 自行设置；正确则换取 internal token
 * （作为后续 API 的 Bearer）。与机器用的 SIREN_INTERNAL_TOKEN 体系解耦——
 * 人不用面对 48 位随机串。
 * 公网可达，故带简单的内存级失败限速（每 IP 每分钟 10 次）。
 */
import type { FastifyInstance } from 'fastify';
import type { SirenConfig } from '@siren/voice-core';

export interface WebAuthRoutesDeps {
  config: SirenConfig;
}

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
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

export function registerWebAuthRoute(app: FastifyInstance, deps: WebAuthRoutesDeps): void {
  app.post('/v1/web/login', async (request, reply) => {
    if (!deps.config.webPassword || !deps.config.internalToken) {
      await reply.code(503).send({ error: 'web_login_disabled', hint: 'SIREN_WEB_PASSWORD 未设置' });
      return;
    }
    const ip = request.ip ?? 'unknown';
    if (rateLimited(ip)) {
      await reply.code(429).send({ error: 'too_many_attempts' });
      return;
    }
    const body = (request.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    // 恒定时间比较，避免计时侧信道
    const a = Buffer.from(password);
    const b = Buffer.from(deps.config.webPassword);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      await reply.code(401).send({ error: 'wrong_password' });
      return;
    }
    attempts.delete(ip);
    await reply.send({ token: deps.config.internalToken });
  });
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
