/**
 * CallSession：实时通话的单会话编排器（规范第 15/19/20/22/23 节）。
 *
 * 职责（音频生产在 reply-pipeline.ts，落库在 call-recorder.ts）：
 * - WebSocket 消息/二进制帧 -> 状态机驱动
 * - ASR 建连 prebuffer（不丢句首）与 final/partial 采纳
 * - Barge-in：abort 真正取消 LLM / TTS / PCM 队列，保留已下发前缀与独立的播放证据
 * - 协议帧组装与背压保护（背压超限走幂等 finalize，禁止 zombie session，P0-6）
 */
import { randomUUID } from 'node:crypto';
import type {
  CallState,
  ClientPlaybackProgress,
  ClientWsMessage,
  RealtimeVoiceProvider,
  ServerWsMessage,
  VoiceProfile,
  WsAudioContract
} from '@siren/contracts';
import { WS_PROTOCOL_VERSION, WS_CLOSE_CODES } from '@siren/contracts';
import type { CoreBridge, CoreInterruption } from '@siren/core-bridge';
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
  private voiceInterruptCapable = false;
  private readonly knownInputIds = new Set<string>();
  private lastInputId: string | undefined;
  private pendingInterruption: CoreInterruption | undefined;
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
        sendJson: (message, turn) => {
          if (this.turn === turn && !turn.aborted) this.sendJson(message, turn);
        },
        sendRaw: (frame, turn) => {
          if (this.turn === turn && !turn.aborted) this.sendRaw(frame);
        },
        onFirstAudio: (turn) => {
          if (this.turn === turn && !turn.aborted) this.enterSpeaking();
        }
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
        this.handleStart(message.input_id);
        break;
      case 'end':
        if (this.matchesInput(message.input_id)) void this.handleEnd();
        break;
      case 'abort':
        if (this.matchesInput(message.input_id)) this.handleAbort(message.playback);
        break;
      case 'interrupt':
        this.handleInterrupt(message);
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
    // S1011-025：单轮音频预算——超限取消本轮（provider 不再消费），防失控计费
    turn.audioBytes += pcm.length;
    if (turn.audioBytes > this.deps.config.maxTurnAudioBytes) {
      this.log.warn('turn_audio_budget_exceeded', {
        turn_index: turn.index,
        audio_bytes: turn.audioBytes,
        limit: this.deps.config.maxTurnAudioBytes
      });
      this.sendJson({ t: 'error', code: 'audio_budget_exceeded', message: '本轮语音过长，已停止识别' });
      turn.asr.abort();
      this.abortTurn('audio_budget');
      this.backToListening();
      return;
    }
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

  private inputError(code: string, message: string, inputId?: string): void {
    this.sendJson({ t: 'error', code, message, ...(inputId ? { input_id: inputId } : {}) });
  }

  /** Legacy peers retain manual controls; negotiated peers must target a turn. */
  private matchesInput(inputId?: string): boolean {
    if (!this.voiceInterruptCapable) return true;
    if (!inputId) {
      this.inputError('input_id_required', 'this operation requires input_id');
      return false;
    }
    // Replayed end/abort for a retired input is a no-op, never a new-turn abort.
    return this.turn?.inputId === inputId;
  }

  private handleInterrupt(message: Extract<ClientWsMessage, { t: 'interrupt' }>): void {
    const nextId = message.new_input_id;
    if (!this.voiceInterruptCapable) {
      this.inputError('capability_required', 'negotiate voice_interrupt first', nextId);
      return;
    }
    if (nextId === message.target_input_id) {
      this.inputError('invalid_input_id', 'new and target input must differ', nextId);
      return;
    }
    if (this.turn?.inputId === nextId) {
      this.sendJson({ t: 'input_started', input_id: nextId });
      return;
    }
    if (this.knownInputIds.has(nextId)) {
      this.inputError('retired_input', 'input_id cannot be reused', nextId);
      return;
    }
    if (!this.knownInputIds.has(message.target_input_id) ||
        (this.turn ? this.turn.inputId !== message.target_input_id : this.lastInputId !== message.target_input_id)) {
      this.inputError('stale_interrupt', 'target is not the active input', nextId);
      return;
    }
    // Retire the old turn synchronously. Provider cleanup is deliberately not
    // awaited: the new input obtains its own ASR/prebuffer immediately.
    if (this.turn) this.handleAbort(message.playback);
    this.handleStart(nextId);
  }

  /** P1-7：ready 能力协商。只回版本与音频约定，不做复杂 negotiation */
  private handleReady(clientProtocol: number | undefined, capabilities: unknown): void {
    // 记录 playback_drain 能力：决定 pcm_end 后是否等待真正播完再回 listening
    const caps = (capabilities ?? {}) as { playback_drain?: boolean; voice_interrupt?: boolean };
    this.clientDrainCapable = caps.playback_drain === true;
    // Once negotiated, an extra ready frame cannot downgrade targeting guards.
    this.voiceInterruptCapable ||= caps.voice_interrupt === true;
    // 采样率契约来自 Realtime Provider 边界（P0-7/P1-1），不再假设固定值
    const audio: WsAudioContract = {
      input_rate: this.deps.voice.inputSampleRate,
      output_rate: this.deps.voice.outputSampleRate,
      format: 'pcm16'
    };
    this.sendJson({
      t: 'ready',
      protocol: WS_PROTOCOL_VERSION,
      audio,
      capabilities: { voice_interrupt: this.voiceInterruptCapable },
      // S1011-015：VAD/jitter 服务端配置随 ready 下发，客户端作为默认参数
      vad: {
        confirm_ms: this.deps.config.vad.confirmMs,
        min_speech_ms: this.deps.config.vad.minSpeechMs,
        end_silence_ms: this.deps.config.vad.endSilenceMs,
        rms_ratio: this.deps.config.vad.rmsRatio
      },
      jitter_ms: this.deps.config.jitterBufferMs
    });
    if (clientProtocol !== undefined && clientProtocol !== WS_PROTOCOL_VERSION) {
      this.log.warn('ws_protocol_version_mismatch', {
        client_protocol: clientProtocol,
        server_protocol: WS_PROTOCOL_VERSION,
        client_capabilities: capabilities
      });
    }
    this.sendJson({ t: 'state', state: this.state });
  }

  private handleStart(inputId?: string): void {
    if (this.voiceInterruptCapable) {
      if (!inputId) {
        this.inputError('input_id_required', 'start requires input_id');
        return;
      }
      if (this.knownInputIds.has(inputId)) {
        if (this.turn?.inputId === inputId) this.sendJson({ t: 'input_started', input_id: inputId });
        else this.inputError('retired_input', 'input_id cannot be reused', inputId);
        return;
      }
    }
    if (!this.stateMachine.is('idle', 'listening')) {
      this.inputError('invalid_state', `cannot start in state=${this.state}`, inputId);
      return;
    }
    if (this.turn && this.voiceInterruptCapable) {
      this.inputError('input_active', 'use interrupt to replace an active input', inputId);
      return;
    }
    if (this.turn) {
      // 上一轮输入未收尾：静默丢弃并重建
      this.turn.aborted = true;
      this.turn.asr.abort();
    }
    this.lastPartialText = '';
    if (this.stateMachine.state === 'idle') {
      this.stateMachine.transition('listening');
    }
    this.turnIndex++;
    const nextInputId = inputId ?? randomUUID();
    this.knownInputIds.add(nextInputId);
    this.lastInputId = nextInputId;
    const turn: ActiveTurn = {
      index: this.turnIndex,
      turnId: randomUUID(),
      inputId: nextInputId,
      interruptedTurn: this.pendingInterruption,
      outputStreamId: newOutputStreamId(),
      nextSequence: 0,
      userText: '',
      receivedText: '',
      audioBytes: 0,
      asrPartials: 0,
      asr: createAsrSession(
        { asr: this.deps.voice, profile: this.deps.profile, prebufferMaxBytes: this.deps.config.prebufferMaxBytes },
        (text) => {
          // F09：旧 turn 的迟到 partial 不得写入共享 lastPartialText / 转发给客户端
          if (this.turn !== turn || turn.aborted || this.closed || this.closing) return;
          turn.asrPartials += 1;
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
      sentText: '',
      pcmStarted: false,
      written: false
    };
    this.turn = turn;
    // 立即触发建连：prebuffer 在建连期间累积（规范第 22 节）。
    // info 级就绪日志（1002 空转写排障）：ready=false 即建连失败/挂起，是关键鉴别信号
    const connectStartedAt = Date.now();
    void this.turn.asr
      .connect()
      .then(() => {
        this.log.info('asr_session_ready', {
          turn_index: turn.index,
          ms: Date.now() - connectStartedAt,
          ready: turn.asr.isReady
        });
      })
      .catch(() => undefined);
    // ACK means this input owns a prebuffer; neither old cleanup nor ASR's
    // network handshake blocks acceptance of the next utterance.
    if (this.voiceInterruptCapable) this.sendJson({ t: 'input_started', input_id: nextInputId });
    this.sendJson({ t: 'state', state: 'listening' });
    this.log.info('turn_started', { turn_index: this.turnIndex, turn_id: this.turn.turnId });
  }

  // -------------------------------------------------------------------------
  // 用户结束说话 -> 等 final -> 进 Core
  // -------------------------------------------------------------------------

  private async handleEnd(): Promise<void> {
    const turn = this.turn;
    if (this.voiceInterruptCapable && turn && !this.stateMachine.is('listening')) return;
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
      // 留 warn + fed_bytes/partials 供诊断，客户端给"没听清"提示
      this.log.warn('asr_empty_transcript', {
        turn_index: turn.index,
        fed_bytes: turn.asr.fedBytes,
        partials: turn.asrPartials
      });
      this.sendJson({ t: 'notice', code: 'empty_transcript', message: '没听清，请再说一遍' });
      // R7（2026-10-23，她 D6 裁定）：空转写轮如实落库 outcome='asr_empty'（中性——
      // 用户说了话但无文本，此前直接丢弃致失败率分母不可还原）；文本两列为 NULL
      this.writeTurn(turn, 'asr_empty');
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
      // F08：传 getter——grace 到期时读的是等待期间持续更新的最新 partial；
      // 空 partial 不采纳（1002 实测：空宽限把建连失败/火山静音掩盖成"空转写"），
      // 改为等 end() 落定（其内部有建连/终包限时），失败可见化
      getLatestPartial: () => (this.turn === turn ? this.lastPartialText : '')
    });
    if (outcome.kind === 'error' || outcome.kind === 'timeout') {
      const timedOut = outcome.kind === 'timeout';
      // S1011-004：ASR 失败/超时即终态化——迟到建连/会话不得在 turn 释放后接管
      turn.asr.abort();
      if (turn.aborted || this.turn !== turn || this.closed) return null; // 已被 abort 接管
      this.sendJson({
        t: 'error',
        code: timedOut ? 'asr_timeout' : 'asr_failed',
        message: timedOut ? 'speech recognition timed out' : 'speech recognition failed'
      });
      this.log.warn('turn_failed', {
        ...(outcome.kind === 'error' ? errorFields(outcome.error) : {}),
        stage: 'asr',
        timeout: timedOut,
        turn_index: turn.index
      });
      this.writeTurn(turn, timedOut ? 'asr_timeout' : 'asr_failed');
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
    if (this.pendingInterruption === turn.interruptedTurn) this.pendingInterruption = undefined;
    this.sendJson({ t: 'state', state: 'thinking' });

    const result = await this.pipeline.run(turn);

    if (result.status === 'aborted' || turn.aborted || this.turn !== turn || this.closed) {
      // 打断路径：interrupted / reply 已由 handleAbort 同步下发
      return;
    }
    if (result.status === 'failed') {
      // TTS / Core 失败：保留文字，明确降级（规范第 40 节）。
      // S1011-021：Core 中途失败时已收到的原始文本独立保留并下发（含未成句的半句），
      // 与已下发正文（sentText）语义分离；仅在统一出口发布 reply。
      if (result.kind === 'core' && turn.receivedText) {
        turn.fullText = turn.receivedText;
      }
      this.log.warn('reply_generation_failed', {
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
    // 播完（或超时兜底）才收尾——期间保持 speaking，半双工门控继续吞 VAD
    if (turn.pcmStarted && this.clientDrainCapable && this.deps.config.playbackDrainTimeoutMs > 0) {
      const drained = await this.armPendingDrain(turn.outputStreamId);
      if (turn.aborted || this.turn !== turn) return; // 尾音被打断：interrupted 流程已接管
      if (!drained) {
        this.log.debug('playback_drain_fallback_listening', { stream_id: turn.outputStreamId });
      }
    }
    // 终态落库/metrics 在 drain 最终结果之后：被打断时由 handleAbort 写
    // interrupted 并只发一份 interrupted metrics（不会出现两份矛盾记录）
    this.finalizeReplyTurn(turn, result.status === 'failed' ? `${result.kind}_failed` : 'completed');
    if (this.closed || this.closing) return;
    this.backToListening();
  }

  /** Preserve failure at the terminal boundary; a metrics frame is not success. */
  private finalizeReplyTurn(turn: ActiveTurn, outcome: 'completed' | 'core_failed' | 'tts_failed'): void {
    this.writeTurn(turn, outcome);
    turn.metrics.markEnd();
    const metrics = turn.metrics.compute();
    this.sendJson({ t: 'metrics', metrics });
    const fields = {
      turn_index: turn.index,
      outcome,
      ...metrics,
      user_len: turn.userText.length,
      assistant_len: turn.fullText.length
    };
    if (outcome === 'completed') this.log.info('turn_completed', fields);
    else this.log.warn('turn_failed', fields);
  }

  // -------------------------------------------------------------------------
  // Barge-in（规范第 20 节）
  // -------------------------------------------------------------------------

  private handleAbort(playback?: ClientPlaybackProgress): void {
    const interrupted = this.turn;
    if (interrupted && (interrupted.userText || interrupted.receivedText)) {
      this.pendingInterruption = {
        turnId: interrupted.turnId,
        inputId: interrupted.inputId,
        outputStreamId: interrupted.outputStreamId,
        playback: playback?.stream_id === interrupted.outputStreamId
          ? { basis: 'client_reported', playedMs: playback.played_ms }
          : { basis: 'unknown' }
      };
    }
    if (this.stateMachine.is('idle', 'listening')) {
      // 收回未提交的输入：丢弃当前 utterance
      if (this.turn) this.turn.aborted = true;
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
      // ENDING may have a real partial but no adopted transcript yet. Preserve
      // that draft in the interrupted record; do not merge it into the new input
      // or pretend it was finalized/committed to Core.
      const inputStatus = turn.userText ? 'adopted' : this.lastPartialText ? 'partial' : 'unrecognized';
      if (!turn.userText && this.lastPartialText) turn.userText = this.lastPartialText;
      if (this.stateMachine.is('speaking')) {
        this.stateMachine.transition('interrupting');
      }
      this.abortTurn('user_abort');
      // 旧输出流永久失效（P0-3）：客户端凭 stream_id 丢弃迟到 chunk，且不再要求 drained
      this.clearPendingDrain('interrupted');
      this.sendJson({ t: 'interrupted', stream_id: turn.outputStreamId });
      // 保留已生成的原文；音频下发与客户端播放事实由独立字段表达。
      if (turn.fullText) {
        this.sendJson({ t: 'reply', text: turn.fullText });
      }
      turn.metrics.setInterrupted();
      this.writeTurn(turn, 'interrupted');
      turn.metrics.markEnd();
      this.sendJson({ t: 'metrics', metrics: turn.metrics.compute() });
      this.log.info('turn_interrupted', {
        turn_index: turn.index,
        input_status: inputStatus,
        sent_len: turn.sentText.length,
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
    // Generated text is durable even when its sentence has only partly reached
    // TTS. sentText remains the separate fully-sent prefix; neither is heard text.
    turn.fullText = turn.receivedText;
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

  private sendJson(message: ServerWsMessage, turn = this.turn): void {
    if (this.closed) return;
    const inputId = turn?.inputId ?? this.lastInputId;
    this.deps.send(JSON.stringify(
      this.voiceInterruptCapable && inputId && message.t !== 'ready' && message.t !== 'pong'
        ? { ...message, input_id: message.input_id ?? inputId }
        : message
    ));
  }

  private writeTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
    this.recorder.write(this.deps.callId, turn, outcome);
  }
}
