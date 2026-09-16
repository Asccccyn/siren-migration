/**
 * CallSession：实时通话的单会话编排器（规范第 15/19/20/22/23 节）。
 *
 * 职责（音频生产在 reply-pipeline.ts，落库在 call-recorder.ts）：
 * - WebSocket 消息/二进制帧 -> 状态机驱动
 * - ASR 建连 prebuffer（不丢句首）与 final/partial 采纳
 * - Barge-in：abort 真正取消 LLM / TTS / PCM 队列，保留已播出内容
 * - 协议帧组装与背压保护
 */
import { randomUUID } from 'node:crypto';
import type {
  AsrProvider,
  CallState,
  ClientWsMessage,
  ServerWsMessage,
  TtsProvider,
  VoiceProfile
} from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type { CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import { LatencyTracker, errorFields, type Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';
import { CallStateMachine } from './call-state-machine.ts';
import { adoptTranscript, createAsrSession } from './utterance-intake.ts';
import { ReplyPipeline, type ActiveTurn } from './reply-pipeline.ts';
import { CallTurnRecorder, type TurnOutcome } from './call-recorder.ts';
import { resolveStyle } from './emotion.ts';
import type { FillerManager } from './filler-manager.ts';

export interface CallSessionDeps {
  config: SirenConfig;
  logger: Logger;
  callId: string;
  conversationId: string | null;
  profile: VoiceProfile;
  asr: AsrProvider;
  tts: TtsProvider;
  core: CoreBridge;
  fillers: FillerManager;
  turnsRepo?: CallTurnsRepository;
  sessionsRepo?: CallSessionsRepository;
  send: (data: string, binary?: Buffer) => void;
  bufferedAmount: () => number;
  close: (code: number, reason: string) => void;
  onDestroyed?: (session: CallSession) => void;
}

export class CallSession {
  readonly stateMachine: CallStateMachine;
  private readonly log: Logger;
  private readonly recorder: CallTurnRecorder;
  private readonly pipeline: ReplyPipeline;
  private turnIndex = 0;
  private turn: ActiveTurn | null = null;
  private destroyed = false;
  private lastPartialText = '';

  constructor(private readonly deps: CallSessionDeps) {
    this.log = deps.logger.child({ call_id: deps.callId, conversation_id: deps.conversationId });
    this.stateMachine = new CallStateMachine((from, to, at) => {
      this.log.info('call_state', { from, to, at });
    });
    this.recorder = new CallTurnRecorder(deps.turnsRepo, this.log);
    this.pipeline = new ReplyPipeline(
      {
        config: deps.config,
        logger: deps.logger,
        callId: deps.callId,
        conversationId: deps.conversationId,
        profile: deps.profile,
        tts: deps.tts,
        core: deps.core,
        fillers: deps.fillers
      },
      {
        sendJson: (message) => this.sendJson(message),
        sendRaw: (frame) => this.sendRaw(frame),
        onFirstAudio: () => this.enterSpeaking()
      }
    );
    void this.deps.fillers.preload();
    this.deps.sessionsRepo?.markStarted(deps.callId, Date.now());
    this.log.info('call_started', { voice_profile: deps.profile.id });
  }

  get callId(): string {
    return this.deps.callId;
  }

  get state(): CallState {
    return this.stateMachine.state;
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  handleMessage(message: ClientWsMessage): void {
    if (this.destroyed) return;
    switch (message.t) {
      case 'ready':
        this.sendJson({ t: 'state', state: this.state });
        break;
      case 'start':
        this.handleStart();
        break;
      case 'end':
        void this.handleEnd();
        break;
      case 'abort':
        this.handleAbort();
        break;
      case 'ping':
        this.sendJson({ t: 'pong' });
        break;
    }
  }

  handleBinary(pcm: Buffer): void {
    if (this.destroyed || pcm.length === 0) return;
    const turn = this.turn;
    if (!turn || !this.stateMachine.is('listening')) return;
    turn.asr.feed(pcm);
  }

  /** 连接关闭 / 服务停止：取消一切并落终态（规范第 47 节第 9/25/29 条） */
  destroy(reason = 'closed'): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortTurn('destroy');
    this.stateMachine.forceEnded();
    this.deps.sessionsRepo?.markEnded(this.deps.callId, Date.now(), 'ended');
    this.log.info('call_ended', { reason });
    this.deps.onDestroyed?.(this);
  }

  // -------------------------------------------------------------------------
  // 用户开始说话
  // -------------------------------------------------------------------------

  private handleStart(): void {
    if (!this.stateMachine.is('idle', 'listening')) {
      this.sendJson({ t: 'error', code: 'invalid_state', message: `cannot start in state=${this.state}` });
      return;
    }
    if (this.turn) {
      // 上一轮输入未收尾：静默丢弃并重建
      this.turn.asr.abort();
    }
    if (this.stateMachine.state === 'idle') {
      this.stateMachine.transition('listening');
    }
    this.turnIndex++;
    this.turn = {
      index: this.turnIndex,
      turnId: randomUUID(),
      userText: '',
      asr: createAsrSession(
        { asr: this.deps.asr, profile: this.deps.profile, prebufferMaxBytes: this.deps.config.prebufferMaxBytes },
        (text) => {
          this.lastPartialText = text;
          this.sendJson({ t: 'partial', text });
        },
        (error) => {
          this.log.warn('asr_stream_error', errorFields(error));
        }
      ),
      metrics: new LatencyTracker(),
      startedAt: Date.now(),
      aborted: false,
      fullText: '',
      playedText: '',
      pcmStarted: false,
      written: false
    };
    // 立即触发建连：prebuffer 在建连期间累积（规范第 22 节）
    void this.turn.asr.connect().catch(() => undefined);
    this.sendJson({ t: 'state', state: 'listening' });
    this.log.info('turn_started', { turn_index: this.turnIndex, turn_id: this.turn.turnId });
  }

  // -------------------------------------------------------------------------
  // 用户结束说话 -> 等 final -> 进 Core
  // -------------------------------------------------------------------------

  private async handleEnd(): Promise<void> {
    const turn = this.turn;
    if (!turn || !this.stateMachine.is('listening')) {
      this.sendJson({ t: 'error', code: 'invalid_state', message: `cannot end in state=${this.state}` });
      return;
    }
    turn.metrics.mark('speech_end');
    this.stateMachine.transition('ending');
    this.sendJson({ t: 'state', state: 'ending' });

    const transcript = await this.adoptTranscript(turn);
    if (transcript === null) return; // 失败已处理 / 已被 abort 接管
    turn.metrics.mark('asr_final');
    if (!transcript) {
      this.backToListening();
      return;
    }
    turn.userText = transcript;
    this.sendJson({ t: 'asr', text: transcript, language: this.deps.profile.language });
    await this.runReplyPhase(turn);
  }

  /**
   * 采纳识别结果（final 优先 / grace 采用 partial / 失败明确报错）。
   * 失败或被 abort 接管时返回 null（规范第 23/40 节）。
   */
  private async adoptTranscript(turn: ActiveTurn): Promise<string | null> {
    const outcome = await adoptTranscript(turn.asr, {
      graceMs: this.deps.config.partialGraceMs,
      lastPartialText: this.lastPartialText
    });
    if (outcome.kind === 'error') {
      if (turn.aborted || this.turn !== turn) return null; // 已被 abort 接管
      this.sendJson({ t: 'error', code: 'asr_failed', message: 'speech recognition failed' });
      this.log.warn('turn_failed', { ...errorFields(outcome.error), stage: 'asr', turn_index: turn.index });
      this.writeTurn(turn, 'asr_failed');
      this.backToListening();
      return null;
    }
    if (turn.aborted || this.turn !== turn) return null;
    return outcome.text;
  }

  // -------------------------------------------------------------------------
  // Core -> 切句 -> TTS -> PCM（委托 ReplyPipeline）
  // -------------------------------------------------------------------------

  private async runReplyPhase(turn: ActiveTurn): Promise<void> {
    if (turn.aborted || this.turn !== turn) return;
    this.stateMachine.transition('thinking');
    this.sendJson({ t: 'state', state: 'thinking' });

    const result = await this.pipeline.run(turn);

    if (result.status === 'aborted') {
      // 打断路径：interrupted / reply 已由 handleAbort 同步下发
      return;
    }
    if (result.status === 'failed') {
      // TTS / Core 失败：保留文字，明确降级（规范第 40 节）
      this.log.warn('turn_failed', {
        ...errorFields(result.error),
        stage: 'reply',
        turn_index: turn.index
      });
      this.sendJson({
        t: 'error',
        code: result.kind === 'tts' ? 'tts_failed' : 'core_failed',
        message:
          result.kind === 'tts' ? 'voice synthesis failed, text preserved' : 'core reply failed'
      });
    }

    if (turn.aborted || this.turn !== turn) return;
    // 下发完整回复文本（文字永远不丢）
    if (turn.fullText) {
      const style = resolveStyle(this.deps.profile);
      this.sendJson({ t: 'reply', text: turn.fullText, emotion: style.emotion });
    }
    if (turn.pcmStarted) {
      this.sendJson({ t: 'pcm_end' });
    }
    this.writeTurn(turn, 'completed');
    turn.metrics.markEnd();
    this.sendJson({ t: 'metrics', metrics: turn.metrics.compute() });
    this.log.info('turn_completed', {
      turn_index: turn.index,
      ...turn.metrics.compute(),
      user_len: turn.userText.length,
      assistant_len: turn.fullText.length
    });
    this.backToListening();
  }

  // -------------------------------------------------------------------------
  // Barge-in（规范第 20 节）
  // -------------------------------------------------------------------------

  private handleAbort(): void {
    if (this.stateMachine.is('idle', 'listening')) {
      // 收回未提交的输入：丢弃当前 utterance
      this.turn?.asr.abort();
      this.turn = null;
      this.lastPartialText = '';
      this.sendJson({ t: 'state', state: this.state });
      return;
    }
    if (this.stateMachine.is('ending', 'thinking', 'speaking')) {
      const turn = this.turn;
      if (!turn) {
        this.backToListening();
        return;
      }
      if (this.stateMachine.is('speaking')) {
        this.stateMachine.transition('interrupting');
      }
      this.abortTurn('user_abort');
      this.sendJson({ t: 'interrupted' });
      // 保留已真正播出的内容（规范第 20 节第 6 条）
      if (turn.fullText) {
        this.sendJson({ t: 'reply', text: turn.fullText });
      }
      turn.metrics.setInterrupted();
      this.writeTurn(turn, 'interrupted');
      turn.metrics.markEnd();
      this.sendJson({ t: 'metrics', metrics: turn.metrics.compute() });
      this.log.info('turn_interrupted', {
        turn_index: turn.index,
        played_len: turn.playedText.length,
        total_len: turn.fullText.length
      });
      this.backToListening();
    }
  }

  /** 取消 LLM / TTS / PCM：必须真正取消，不是静音（规范第 20 节） */
  private abortTurn(reason: string): void {
    const turn = this.turn;
    if (!turn) return;
    turn.aborted = true;
    turn.asr.abort();
    // 先截取已播出文本，保证随后落库/下发的都是真正播出的内容（规范第 20 节第 6 条）
    turn.fullText = turn.playedText;
    void this.deps.core.cancel(turn.turnId).catch(() => undefined);
    this.log.debug('turn_abort', { reason, turn_index: turn.index });
  }

  private backToListening(): void {
    this.turn = null;
    this.lastPartialText = '';
    if (this.stateMachine.is('speaking')) {
      this.stateMachine.transition('interrupting');
    }
    if (!this.stateMachine.is('listening')) {
      this.stateMachine.transition('listening');
    }
    if (!this.destroyed) {
      this.sendJson({ t: 'state', state: 'listening' });
    }
  }

  // -------------------------------------------------------------------------
  // 输出
  // -------------------------------------------------------------------------

  private enterSpeaking(): void {
    if (this.stateMachine.is('thinking')) {
      this.stateMachine.transition('speaking');
      this.sendJson({ t: 'state', state: 'speaking' });
    }
  }

  private sendRaw(frame: Buffer): void {
    if (this.destroyed) return;
    if (this.deps.bufferedAmount() > this.deps.config.ws.maxBufferedBytes) {
      this.log.error('ws_backpressure_overflow', { buffered: this.deps.bufferedAmount() });
      this.deps.close(4005, 'backpressure overflow');
      this.destroyed = true;
      return;
    }
    this.deps.send('binary', frame);
  }

  private sendJson(message: ServerWsMessage): void {
    if (this.destroyed) return;
    this.deps.send(JSON.stringify(message));
  }

  private writeTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
    this.recorder.write(this.deps.callId, turn, outcome);
  }
}
