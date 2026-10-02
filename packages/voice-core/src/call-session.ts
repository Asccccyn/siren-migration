/**
 * CallSession：实时通话的单会话编排器（规范第 15/19/20/22/23 节）。
 *
 * 职责（音频生产在 reply-pipeline.ts，落库在 call-recorder.ts）：
 * - WebSocket 消息/二进制帧 -> 状态机驱动
 * - ASR 建连 prebuffer（不丢句首）与 final/partial 采纳
 * - Barge-in：abort 真正取消 LLM / TTS / PCM 队列，保留已播出内容
 * - 协议帧组装与背压保护（背压超限走幂等 finalize，禁止 zombie session，P0-6）
 */
import { randomUUID } from 'node:crypto';
import type {
  CallState,
  ClientWsMessage,
  RealtimeVoiceProvider,
  ServerWsMessage,
  VoiceProfile,
  WsAudioContract
} from '@siren/contracts';
import { WS_PROTOCOL_VERSION, WS_CLOSE_CODES } from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type { CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import { LatencyTracker, errorFields, type Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';
import { CallStateMachine } from './call-state-machine.ts';
import { adoptTranscript, createAsrSession } from './utterance-intake.ts';
import { ReplyPipeline, newOutputStreamId, type ActiveTurn } from './reply-pipeline.ts';
import { CallTurnRecorder, type TurnOutcome } from './call-recorder.ts';
import { resolveStyle } from './emotion.ts';
import type { FillerManager } from './filler-manager.ts';

export interface CallSessionDeps {
  config: SirenConfig;
  logger: Logger;
  callId: string;
  conversationId: string | null;
  profile: VoiceProfile;
  /** P1-1：Realtime Provider 边界（cascade 组合 ASR + TTS 与采样率契约） */
  voice: RealtimeVoiceProvider;
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
  private closing = false;
  private closed = false;
  private lastPartialText = '';
  /** 客户端 ready 时上报的 playback_drain 能力（协议 v2） */
  private clientDrainCapable = false;
  /** 等待客户端 playback_drained ACK 的输出流（P0-4） */
  private pendingDrain: { streamId: string; timer: NodeJS.Timeout; sentAt: number; settle: (drained: boolean) => void } | null = null;

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
        tts: deps.voice.tts,
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

  /** 冻结绑定的会话上下文（来自 call token reservation，客户端不可改写） */
  get conversationId(): string | null {
    return this.deps.conversationId;
  }

  get state(): CallState {
    return this.stateMachine.state;
  }

  get destroyed(): boolean {
    return this.closed;
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  handleMessage(message: ClientWsMessage): void {
    if (this.closed || this.closing) return;
    switch (message.t) {
      case 'ready':
        this.handleReady(message.protocol, message.capabilities);
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
      case 'playback_drained':
        this.handlePlaybackDrained(message.stream_id);
        break;
      case 'ping':
        this.sendJson({ t: 'pong' });
        break;
    }
  }

  handleBinary(pcm: Buffer): void {
    if (this.closed || this.closing || pcm.length === 0) return;
    const turn = this.turn;
    if (!turn || !this.stateMachine.is('listening')) return;
    turn.asr.feed(pcm);
  }

  /** 连接关闭/服务停止/背压超限：幂等 finalize（P0-6）。cleanup 完成前
   * 不置 terminal flag，保证 abort/落库/token 吊销/注册表移除一定发生 */
  destroy(reason = 'closed', closeInfo?: { code: number; reason: string }): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      const turn = this.turn;
      this.abortTurn(`destroy:${reason}`);
      this.clearPendingDrain('destroy');
      if (turn && !turn.written && (turn.userText || turn.fullText || this.lastPartialText)) {
        // F10：销毁（断线/背压/关停）不丢当前轮——已识别/已产出内容的轮次幂等落库；
        // ending 阶段仅有 partial 时也保留（文字不丢），outcome 记 interrupted
        turn.userText = turn.userText || this.lastPartialText;
        this.writeTurn(turn, 'interrupted');
      }
      this.stateMachine.forceEnded();
      this.deps.sessionsRepo?.markEnded(this.deps.callId, Date.now(), 'ended');
      this.log.info('call_ended', { reason });
      this.deps.onDestroyed?.(this);
      if (closeInfo) {
        this.deps.close(closeInfo.code, closeInfo.reason);
      }
    } finally {
      this.closing = false;
      this.closed = true;
    }
  }

  // -------------------------------------------------------------------------
  // 用户开始说话
  // -------------------------------------------------------------------------

  /** P1-7：ready 能力协商。只回版本与音频约定，不做复杂 negotiation */
  private handleReady(clientProtocol: number | undefined, capabilities: unknown): void {
    // 记录 playback_drain 能力：决定 pcm_end 后是否等待真正播完再回 listening
    const caps = (capabilities ?? {}) as { playback_drain?: boolean };
    this.clientDrainCapable = caps.playback_drain === true;
    // 采样率契约来自 Realtime Provider 边界（P0-7/P1-1），不再假设固定值
    const audio: WsAudioContract = {
      input_rate: this.deps.voice.inputSampleRate,
      output_rate: this.deps.voice.outputSampleRate,
      format: 'pcm16'
    };
    this.sendJson({ t: 'ready', protocol: WS_PROTOCOL_VERSION, audio });
    if (clientProtocol !== undefined && clientProtocol !== WS_PROTOCOL_VERSION) {
      this.log.warn('ws_protocol_version_mismatch', {
        client_protocol: clientProtocol,
        server_protocol: WS_PROTOCOL_VERSION,
        client_capabilities: capabilities
      });
    }
    this.sendJson({ t: 'state', state: this.state });
  }

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
    const turn: ActiveTurn = {
      index: this.turnIndex,
      turnId: randomUUID(),
      outputStreamId: newOutputStreamId(),
      nextSequence: 0,
      userText: '',
      asr: createAsrSession(
        { asr: this.deps.voice, profile: this.deps.profile, prebufferMaxBytes: this.deps.config.prebufferMaxBytes },
        (text) => {
          // F09：旧 turn 的迟到 partial 不得写入共享 lastPartialText / 转发给客户端
          if (this.turn !== turn || this.closed) return;
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
      ttsAbort: new AbortController(),
      fullText: '',
      playedText: '',
      pcmStarted: false,
      written: false
    };
    this.turn = turn;
    // 立即触发建连：prebuffer 在建连期间累积（规范第 22 节）；记录就绪耗时供空转写诊断
    const connectStartedAt = Date.now();
    void this.turn.asr
      .connect()
      .then(() => {
        this.log.debug('asr_session_ready', { turn_index: turn.index, ms: Date.now() - connectStartedAt });
      })
      .catch(() => undefined);
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
      // 空转写不再静默丢弃（实测故障模式：打断后续接轮拿到空 final，用户对黑箱说话）：
      // 留 warn + fed_bytes 供诊断，客户端给"没听清"提示
      this.log.warn('asr_empty_transcript', {
        turn_index: turn.index,
        fed_bytes: turn.asr.fedBytes
      });
      this.sendJson({ t: 'notice', code: 'empty_transcript', message: '没听清，请再说一遍' });
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
      // F08：传 getter——grace 到期时读的是等待期间持续更新的最新 partial
      getLatestPartial: () => (this.turn === turn ? this.lastPartialText : '')
    });
    if (outcome.kind === 'error') {
      if (turn.aborted || this.turn !== turn || this.closed) return null; // 已被 abort 接管
      this.sendJson({ t: 'error', code: 'asr_failed', message: 'speech recognition failed' });
      this.log.warn('turn_failed', { ...errorFields(outcome.error), stage: 'asr', turn_index: turn.index });
      this.writeTurn(turn, 'asr_failed');
      this.backToListening();
      return null;
    }
    if (turn.aborted || this.turn !== turn || this.closed) return null;
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

    if (result.status === 'aborted' || this.closed) {
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
      this.sendJson({ t: 'pcm_end', stream_id: turn.outputStreamId });
    }
    // drain 门控：pcm_end 只代表服务端发完，客户端还有尾音。v2 客户端等真正
    // 播完（或超时兜底）才收尾——期间保持 speaking，本地 barge-in 判定仍成立
    if (turn.pcmStarted && this.clientDrainCapable && this.deps.config.playbackDrainTimeoutMs > 0) {
      const drained = await this.armPendingDrain(turn.outputStreamId);
      if (turn.aborted || this.turn !== turn) return; // 尾音被打断：interrupted 流程已接管
      if (!drained) {
        this.log.debug('playback_drain_fallback_listening', { stream_id: turn.outputStreamId });
      }
    }
    // completed 落库/metrics 在 drain 最终结果之后：被打断时由 handleAbort 写
    // interrupted 并只发一份 interrupted metrics（不会出现两份矛盾记录）
    this.finalizeCompletedTurn(turn);
    if (this.closed || this.closing) return;
    this.backToListening();
  }

  /** 轮次正常收尾：completed 落库 + 单份 completed metrics（drain 之后调用） */
  private finalizeCompletedTurn(turn: ActiveTurn): void {
    this.writeTurn(turn, 'completed');
    turn.metrics.markEnd();
    const metrics = turn.metrics.compute();
    this.sendJson({ t: 'metrics', metrics });
    this.log.info('turn_completed', {
      turn_index: turn.index,
      ...metrics,
      user_len: turn.userText.length,
      assistant_len: turn.fullText.length
    });
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
      // 旧输出流永久失效（P0-3）：客户端凭 stream_id 丢弃迟到 chunk，且不再要求 drained
      this.clearPendingDrain('interrupted');
      this.sendJson({ t: 'interrupted', stream_id: turn.outputStreamId });
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

  /** 取消 LLM / TTS / PCM：必须真正取消，不是静音（规范第 20 节）。幂等。 */
  private abortTurn(reason: string): void {
    const turn = this.turn;
    if (!turn) return;
    turn.aborted = true;
    turn.asr.abort();
    // 立即终止 TTS provider 上游流（P0-2/P0-9：不是只停止消费）
    if (!turn.ttsAbort.signal.aborted) turn.ttsAbort.abort();
    // 先截取已播出文本，保证随后落库/下发的都是真正播出的内容（规范第 20 节第 6 条）
    turn.fullText = turn.playedText;
    void this.deps.core.cancel(turn.turnId).catch(() => undefined);
    this.log.debug('turn_abort', { reason, turn_index: turn.index });
  }

  /** 回 listening：正常结束 speaking->listening 直达；interrupting 只用于真实打断 */
  private backToListening(): void {
    this.turn = null;
    this.lastPartialText = '';
    if (!this.stateMachine.is('listening')) {
      this.stateMachine.transition('listening');
    }
    if (!this.closed) {
      this.sendJson({ t: 'state', state: 'listening' });
    }
  }

  // -------------------------------------------------------------------------
  // 输出
  // -------------------------------------------------------------------------

  /** P0-4：等待 playback_drained ACK，返回是否在超时内收到；
   * interrupted / destroy / 新流覆盖立即以 false 放行，绝不悬挂 session */
  private armPendingDrain(streamId: string): Promise<boolean> {
    this.clearPendingDrain('rearm');
    const timeoutMs = this.deps.config.playbackDrainTimeoutMs;
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const settle = (drained: boolean): void => {
        if (!this.pendingDrain || this.pendingDrain.streamId !== streamId) return;
        clearTimeout(this.pendingDrain.timer);
        this.pendingDrain = null;
        resolve(drained);
      };
      const timer = setTimeout(() => {
        this.log.warn('playback_drain_timeout', {
          stream_id: streamId,
          waited_ms: timeoutMs
        });
        settle(false);
      }, timeoutMs);
      timer.unref?.();
      this.pendingDrain = { streamId, timer, sentAt: Date.now(), settle };
    });
  }

  private handlePlaybackDrained(streamId: string): void {
    const pending = this.pendingDrain;
    if (!pending || pending.streamId !== streamId) return;
    this.log.info('playback_drained', {
      stream_id: streamId,
      playback_ms: Date.now() - pending.sentAt
    });
    pending.settle(true);
  }

  private clearPendingDrain(reason: string): void {
    const pending = this.pendingDrain;
    if (!pending) return;
    this.log.debug('playback_drain_cleared', { reason, stream_id: pending.streamId });
    pending.settle(false);
  }

  private enterSpeaking(): void {
    if (this.stateMachine.is('thinking')) {
      this.stateMachine.transition('speaking');
      this.sendJson({ t: 'state', state: 'speaking' });
    }
  }

  private sendRaw(frame: Buffer): void {
    if (this.closed || this.closing) return;
    if (this.deps.bufferedAmount() > this.deps.config.ws.maxBufferedBytes) {
      this.log.error('ws_backpressure_overflow', { buffered: this.deps.bufferedAmount() });
      // P0-6：背压超限也必须完整 teardown（abort / 落库 / 吊销 token / 移除注册），
      // 而不是只关 socket 留下 zombie session
      this.destroy('backpressure_overflow', {
        code: WS_CLOSE_CODES.BACKPRESSURE_OVERFLOW,
        reason: 'backpressure overflow'
      });
      return;
    }
    this.deps.send('binary', frame);
  }

  private sendJson(message: ServerWsMessage): void {
    if (this.closed) return;
    this.deps.send(JSON.stringify(message));
  }

  private writeTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
    this.recorder.write(this.deps.callId, turn, outcome);
  }
}
