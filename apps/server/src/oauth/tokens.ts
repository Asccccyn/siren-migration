/**
 * OAuth 无状态令牌（HMAC 签名，密钥复用 SirenConfig.signingSecret）。
 * 格式：<random>.<payload-b64url>.<hmac-b64url>，payload = { t, e, c }（类型/过期/客户端）。
 * 令牌不落库；吊销与 refresh 消费记录须由持久名单提交，正常重启保持有效。
 *
 * 规范形态（S1011-001 修复）：验证只接受严格规范编码——三段均为无填充、
 * 可逆往返一致的 base64url。等价编码变体（尾缀字符、'=' 填充等）一律拒绝，
 * 由此每个令牌只有唯一合法字符串表示，denylist 按原文哈希即为稳定吊销身份。
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

/** 严格 base64url 规范形态：非空、字符集合内、无 '='、解码再编码与原文一致（挡尾缀比特变体） */
function isCanonicalBase64Url(part: string): boolean {
  if (part.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return false;
  return Buffer.from(part, 'base64url').toString('base64url') === part;
}

/** 令牌是否为规范形态（吊销登记用：非规范形态永远过不了验签，无需登记） */
export function isCanonicalToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every((part) => isCanonicalBase64Url(part));
}

export function signToken(secret: string, type: TokenType, clientId: string, ttlSec: number, now = Date.now()): string {
  const random = randomBytes(24).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ t: type, e: Math.floor(now / 1000) + ttlSec, c: clientId }),
    'utf8'
  ).toString('base64url');
  return `${random}.${payload}.${mac(secret, random, payload).toString('base64url')}`;
}

/** 吊销查询接口：Set<string> 与 RevocationList 均满足 */
export interface RevocationLookup {
  has(hash: string): boolean;
}

export function verifyToken(
  secret: string,
  token: string,
  expectType: TokenType,
  revoked: RevocationLookup,
  now = Date.now()
): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  // 规范形态先行：非规范编码（含一切等价签名变体）不进入验签与吊销查询
  if (!parts.every((part) => isCanonicalBase64Url(part))) return null;
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

/** 校验签名并读 claims，但忽略过期（吊销登记用：已过期令牌无需入册，未过期令牌按其到期时间回收） */
export function peekTokenClaims(secret: string, token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (!parts.every((part) => isCanonicalBase64Url(part))) return null;
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
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return null;
  }
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
