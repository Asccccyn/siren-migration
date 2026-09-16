/**
 * 短生命周期 Call Token（规范第 36 节）。
 * Token 绑定 call_id + conversation_id + expires_at，WebSocket 握手必须校验。
 * v1 单进程：内存存储即可（多实例部署时换 Redis，接口不变）。
 */
import { randomBytes } from 'node:crypto';

export interface CallTokenPayload {
  callId: string;
  conversationId: string | null;
  expiresAtMs: number;
}

export class CallTokenStore {
  private readonly tokens = new Map<string, CallTokenPayload>();

  constructor(private readonly ttlSeconds: number) {
    // 定期清扫过期 token，防止泄漏
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  issue(callId: string, conversationId: string | null): { token: string; expiresAt: string } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
    this.tokens.set(token, { callId, conversationId, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  verify(callId: string, token: string): { ok: boolean; reason?: string; payload?: CallTokenPayload } {
    const payload = this.tokens.get(token);
    if (!payload) return { ok: false, reason: 'unknown_token' };
    if (payload.expiresAtMs < Date.now()) {
      this.tokens.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (payload.callId !== callId) return { ok: false, reason: 'call_mismatch' };
    return { ok: true, payload };
  }

  /** 通话结束后立即吊销 */
  revokeByCall(callId: string): void {
    for (const [token, payload] of this.tokens) {
      if (payload.callId === callId) this.tokens.delete(token);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, payload] of this.tokens) {
      if (payload.expiresAtMs < now) this.tokens.delete(token);
    }
  }
}
