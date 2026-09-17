/**
 * 短生命周期 Call Token（规范第 36 节 / v1.1 P0-5）。
 * Token 在 POST /v1/calls 时冻结完整上下文（callId + conversationId + voiceProfileId），
 * WebSocket 握手只允许携带 callId + token，服务端从 reservation 恢复上下文，
 * 客户端不得重新定义 conversation / voice profile。
 * v1 单进程：内存存储即可（多实例部署时换 Redis，接口不变）。
 */
import { randomBytes } from 'node:crypto';

export interface CallTokenPayload {
  callId: string;
  conversationId: string | null;
  voiceProfileId: string;
  expiresAtMs: number;
}

/** verify() 的成功结果：握手层唯一被允许使用的上下文真相源 */
export interface VerifiedCallToken {
  callId: string;
  conversationId: string | null;
  voiceProfileId: string;
  expiresAt: string;
}

export type VerifyTokenResult =
  | { ok: true; payload: CallTokenPayload }
  | { ok: false; reason: 'unknown_token' | 'expired' | 'call_mismatch' };

export class CallTokenStore {
  private readonly tokens = new Map<string, CallTokenPayload>();

  constructor(private readonly ttlSeconds: number) {
    // 定期清扫过期 token，防止泄漏
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  issue(
    callId: string,
    conversationId: string | null,
    voiceProfileId: string
  ): { token: string; expiresAt: string } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
    this.tokens.set(token, { callId, conversationId, voiceProfileId, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  verify(callId: string, token: string): VerifyTokenResult {
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
