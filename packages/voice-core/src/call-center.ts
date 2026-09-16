/**
 * CallCenter：实时通话的创建 / 鉴权 / 会话注册。
 * - POST /v1/calls 在这里发短生命周期 token
 * - WebSocket 握手在这里校验 token 并装配 CallSession
 * - 会话注册表保证 close 后不残留任务、同 call_id 不允许双连接
 */
import { randomUUID } from 'node:crypto';
import type { AsrProvider, TtsProvider } from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type { CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import { CallSession } from './call-session.ts';
import { CallTokenStore } from './call-token.ts';
import type { SirenConfig } from './config.ts';
import type { FillerManager } from './filler-manager.ts';
import type { VoiceProfileRegistry } from './voice-profile.ts';

export interface CallCenterDeps {
  config: SirenConfig;
  logger: Logger;
  realtimeAsr: AsrProvider;
  realtimeTts: TtsProvider;
  core: CoreBridge;
  fillers: FillerManager;
  profiles: VoiceProfileRegistry;
  sessionsRepo?: CallSessionsRepository;
  turnsRepo?: CallTurnsRepository;
  /** 元数据用：实际生效的 provider 名（写入 call_sessions） */
  asrName?: string;
  ttsName?: string;
}

export interface CreateCallResult {
  callId: string;
  wsUrl: string;
  token: string;
  expiresAt: string;
}

export class CallCenter {
  private readonly tokens: CallTokenStore;
  private readonly sessions = new Map<string, CallSession>();

  constructor(private readonly deps: CallCenterDeps) {
    this.tokens = new CallTokenStore(deps.config.callTokenTtlS);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async createCall(params: { conversationId?: string; voiceProfileId?: string }): Promise<CreateCallResult> {
    const callId = randomUUID();
    const fallback = this.deps.profiles.defaultProfileId() ?? 'main';
    const profile = this.deps.profiles.get(params.voiceProfileId ?? undefined, fallback);
    const { token, expiresAt } = this.tokens.issue(callId, params.conversationId ?? null);
    this.deps.sessionsRepo?.insert({
      id: callId,
      conversation_id: params.conversationId ?? null,
      voice_profile: profile.id,
      started_at: null,
      ended_at: null,
      status: 'active',
      asr_provider: this.deps.asrName ?? null,
      tts_provider: this.deps.ttsName ?? null,
      created_at: Date.now()
    });
    const wsBase = this.deps.config.publicUrl.replace(/^http/, 'ws');
    this.deps.logger.info('call_created', { call_id: callId, voice_profile: profile.id });
    return { callId, wsUrl: `${wsBase}/ws/call/${callId}`, token, expiresAt };
  }

  verifyToken(callId: string, token: string): boolean {
    return this.tokens.verify(callId, token).ok;
  }

  /** WS 握手成功后装配会话；同 call_id 已有活跃会话时返回 null（调用方关闭 4002） */
  createSession(params: {
    callId: string;
    conversationId: string | null;
    voiceProfileId?: string;
    send: (data: string, binary?: Buffer) => void;
    bufferedAmount: () => number;
    close: (code: number, reason: string) => void;
  }): CallSession | null {
    if (this.sessions.has(params.callId)) return null;
    const fallback = this.deps.profiles.defaultProfileId() ?? 'main';
    const baseProfile = this.deps.profiles.get(params.voiceProfileId ?? undefined, fallback);
    const profile = { ...baseProfile, voiceId: this.deps.profiles.resolveVoiceId(baseProfile) };
    const session = new CallSession({
      config: this.deps.config,
      logger: this.deps.logger,
      callId: params.callId,
      conversationId: params.conversationId,
      profile,
      asr: this.deps.realtimeAsr,
      tts: this.deps.realtimeTts,
      core: this.deps.core,
      fillers: this.deps.fillers,
      turnsRepo: this.deps.turnsRepo,
      sessionsRepo: this.deps.sessionsRepo,
      send: params.send,
      bufferedAmount: params.bufferedAmount,
      close: params.close,
      onDestroyed: (s) => {
        this.sessions.delete(s.callId);
        this.tokens.revokeByCall(s.callId);
      }
    });
    this.sessions.set(params.callId, session);
    return session;
  }

  getSession(callId: string): CallSession | undefined {
    return this.sessions.get(callId);
  }

  /** 服务关停：终止全部通话（规范第 47 节第 25 条） */
  destroyAll(reason = 'server_shutdown'): void {
    for (const session of [...this.sessions.values()]) {
      session.destroy(reason);
    }
    this.sessions.clear();
  }
}
