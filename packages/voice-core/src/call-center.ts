/**
 * CallCenter：实时通话的创建 / 鉴权 / 会话注册。
 * - POST /v1/calls 在这里发短生命周期 token，并冻结 conversation / voice profile（P0-5）
 * - WebSocket 握手只校验 callId + token，上下文一律从 reservation 恢复
 * - 会话注册表保证 close 后不残留任务、同 call_id 不允许双连接
 */
import { randomUUID } from 'node:crypto';
import type { AsrProvider, RealtimeVoiceProvider, TtsProvider } from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type { CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import { CallSession } from './call-session.ts';
import { CallTokenStore, type VerifiedCallToken } from './call-token.ts';
import type { SirenConfig } from './config.ts';
import type { FillerManager } from './filler-manager.ts';
import { CascadeRealtimeProvider } from './realtime-provider.ts';
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
  /** 冻结绑定的会话上下文（客户端不可改写） */
  conversationId: string | null;
  voiceProfileId: string;
}

export class CallCenter {
  private readonly tokens: CallTokenStore;
  private readonly sessions = new Map<string, CallSession>();
  /** P1-1：会话装配的唯一 Realtime Provider 出口（当前为 cascade 组合） */
  readonly voice: RealtimeVoiceProvider;

  constructor(private readonly deps: CallCenterDeps) {
    this.tokens = new CallTokenStore(deps.config.callTokenTtlS);
    this.voice = new CascadeRealtimeProvider({
      name: `cascade(${deps.asrName ?? 'asr'}+${deps.ttsName ?? 'tts'})`,
      asr: deps.realtimeAsr,
      tts: deps.realtimeTts
    });
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async createCall(params: { conversationId?: string; voiceProfileId?: string }): Promise<CreateCallResult> {
    const callId = randomUUID();
    const fallback = this.deps.profiles.defaultProfileId() ?? 'main';
    const profile = this.deps.profiles.get(params.voiceProfileId ?? undefined, fallback);
    const conversationId = params.conversationId ?? null;
    // 上下文在签发时刻冻结：token 属于哪个 conversation / profile 由服务端唯一决定
    const { token, expiresAt } = this.tokens.issue(callId, conversationId, profile.id);
    this.deps.sessionsRepo?.insert({
      id: callId,
      conversation_id: conversationId,
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
    return {
      callId,
      wsUrl: `${wsBase}/ws/call/${callId}`,
      token,
      expiresAt,
      conversationId,
      voiceProfileId: profile.id
    };
  }

  /** 握手校验：成功返回冻结的上下文 reservation，失败返回 null（调用方关 4001） */
  verifyToken(callId: string, token: string): VerifiedCallToken | null {
    const result = this.tokens.verify(callId, token);
    if (!result.ok) return null;
    return {
      callId: result.payload.callId,
      conversationId: result.payload.conversationId,
      voiceProfileId: result.payload.voiceProfileId,
      expiresAt: new Date(result.payload.expiresAtMs).toISOString()
    };
  }

  /** WS 握手成功后装配会话；同 call_id 已有活跃会话时返回 null（调用方关闭 4002） */
  createSession(params: {
    callId: string;
    /** verifyToken 返回的冻结上下文；conversationId / voiceProfileId 以此为准 */
    reservation: Omit<VerifiedCallToken, 'callId' | 'expiresAt'>;
    send: (data: string, binary?: Buffer) => void;
    bufferedAmount: () => number;
    close: (code: number, reason: string) => void;
  }): CallSession | null {
    if (this.sessions.has(params.callId)) return null;
    const fallback = this.deps.profiles.defaultProfileId() ?? 'main';
    const baseProfile = this.deps.profiles.get(params.reservation.voiceProfileId, fallback);
    const profile = { ...baseProfile, voiceId: this.deps.profiles.resolveVoiceId(baseProfile) };
    const session = new CallSession({
      config: this.deps.config,
      logger: this.deps.logger,
      callId: params.callId,
      conversationId: params.reservation.conversationId,
      profile,
      voice: this.voice,
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
