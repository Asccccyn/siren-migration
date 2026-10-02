/**
 * OAuth 无状态令牌（HMAC 签名，密钥复用 SirenConfig.signingSecret）。
 * 格式：<random>.<payload-b64url>.<hmac-b64url>，payload = { t, e, c }（类型/过期/客户端）。
 * 不落库：重启不失效；吊销走进程内 denylist（best-effort，重启后旧 denylist 清空）。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenType = 'at' | 'rt';

export interface TokenClaims {
  /** at=access token，rt=refresh token */
  t: TokenType;
  /** 过期时间（epoch 秒） */
  e: number;
  /** client_id */
  c: string;
}

function mac(secret: string, random: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${random}.${payload}`).digest();
}

export function signToken(secret: string, type: TokenType, clientId: string, ttlSec: number, now = Date.now()): string {
  const random = randomBytes(24).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ t: type, e: Math.floor(now / 1000) + ttlSec, c: clientId }),
    'utf8'
  ).toString('base64url');
  return `${random}.${payload}.${mac(secret, random, payload).toString('base64url')}`;
}

export function verifyToken(
  secret: string,
  token: string,
  expectType: TokenType,
  revoked: Set<string>,
  now = Date.now()
): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [random, payload, digest] = parts as [string, string, string];
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = mac(secret, random, payload);
    actual = Buffer.from(digest, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return null;
  }
  if (claims.t !== expectType) return null;
  if (typeof claims.e !== 'number' || claims.e * 1000 <= now) return null;
  if (revoked.has(tokenHash(token))) return null;
  return claims;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** PKCE S256：BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function constantTimeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.min(ab.length, bb.length); i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
