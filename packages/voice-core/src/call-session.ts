/**
 * CallSession：实时通话的单会话编排器（规范第 15/19/20/22/23 节）。
 *
 * 职责：
 * - WebSocket 消息/二进制帧 -> 状态机驱动
 * - ASR 建连 prebuffer（不丢句首）
 * - Core 流式回复 -> sentence splitter -> 流式 TTS -> PCM 下发
 * - Barge-in：abort 真正取消 LLM / TTS / PCM 队列，保留已播出内容
 * - 每轮写回 call_turns（含延迟指标）
 */
import { randomUUID } from 'node:crypto';
import type {
  AsrProvider,
  CallState,
  ClientWsMessage,
  ServerWsMessage,
  TtsProvider,
  VoiceProfile,
  VoiceStyle
} from '@siren/contracts';
import { ProviderError } from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type { CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import { chunkPcm16, samplesForDuration } from '@siren/audio';
import { LatencyTracker, errorFields, type Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';
import { CallStateMachine } from './call-state-machine.ts';
import { SentenceSplitter, streamSentences } from './sentence-splitter.ts';
import { PrebufferedAsrSession } from './asr-prebuffer.ts';
import { AsyncQueue, EagerIterable } from './async-queue.ts';
import { emotionToFillerCategory, resolveStyle } from './emotion.ts';
import type { FillerManager } from './filler-manager.ts';

/** 内部信号：本轮已被打断 */
class TurnAbortedError extends Error {
  constructor() {
    super('turn aborted');
    this.name = 'TurnAbortedError';
  }
}

interface ActiveTurn {
  index: number;
  turnId: string;
  userText: string;
  asr: PrebufferedAsrSession;
  metrics: LatencyTracker;
  startedAt: number;
  /** 用户显式 abort */
  aborted: boolean;
  /** LLM 已输出的完整文本 */
  fullText: string;
  /** 已真正完成下发音频的句子 */
  playedText: string;
  pcmStarted: boolean;
  written: boolean;
}

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
  private turnIndex = 0;
  private turn: ActiveTurn | null = null;
  private destroyed = false;
  private lastPartialText = '';

  constructor(private readonly deps: CallSessionDeps) {
    this.log = deps.logger.child({ call_id: deps.callId, conversation_id: deps.conversationId });
    this.stateMachine = new CallStateMachine((from, to, at) => {
      this.log.info('call_state', { from, to, at });
    });
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
      asr: new PrebufferedAsrSession(
        this.deps.asr,
        { language: this.deps.profile.language, profile: this.deps.profile },
        {
          onPartial: (text) => {
            this.lastPartialText = text;
            this.sendJson({ t: 'partial', text });
          },
          onError: (error) => {
            this.log.warn('asr_stream_error', errorFields(error));
          }
        },
        this.deps.config.prebufferMaxBytes
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

    let transcript = '';
    try {
      // 等待 final；PARTIAL_GRACE_MS 内未返回则采用最新 partial（规范第 23 节）。
      // ASR 真正失败必须走 catch 明确报错，禁止把失败当成空文本（规范第 40 节）。
      const endPromise = turn.asr.end().then(
        (result) => ({ kind: 'final' as const, result }),
        (error) => ({ kind: 'error' as const, error })
      );
      const gracePromise = new Promise<{ kind: 'grace' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'grace' }), this.deps.config.partialGraceMs);
      });
      const outcome = await Promise.race([endPromise, gracePromise]);
      if (outcome.kind === 'error') throw outcome.error;
      transcript =
        outcome.kind === 'final' ? outcome.result.text.trim() : this.lastPartialText.trim();
    } catch (error) {
      if (turn.aborted || this.turn !== turn) return; // 已被 abort 接管
      // ASR 失败：明确报错，禁止猜测内容（规范第 40 节）
      this.sendJson({ t: 'error', code: 'asr_failed', message: 'speech recognition failed' });
      this.log.warn('turn_failed', { ...errorFields(error), stage: 'asr', turn_index: turn.index });
      this.writeTurn(turn, 'asr_failed');
      this.backToListening();
      return;
    }
    if (turn.aborted || this.turn !== turn) return; // 已被 abort 接管
    turn.metrics.mark('asr_final');
    if (!transcript) {
      this.backToListening();
      return;
    }
    turn.userText = transcript;
    this.sendJson({ t: 'asr', text: transcript, language: this.deps.profile.language });
    await this.runReplyPhase(turn);
  }

  // -------------------------------------------------------------------------
  // Core -> 切句 -> TTS -> PCM
  // -------------------------------------------------------------------------

  private async runReplyPhase(turn: ActiveTurn): Promise<void> {
    if (turn.aborted || this.turn !== turn) return;
    this.stateMachine.transition('thinking');
    this.sendJson({ t: 'state', state: 'thinking' });

    const splitter = new SentenceSplitter();
    const style: VoiceStyle = resolveStyle(this.deps.profile);

    const sentenceQueue = new AsyncQueue<{ sentence: string; eager: EagerIterable<Buffer> }>();

    // 生产者：core 句子 -> 预取的 TTS chunk 流（深度 1 的流水线）
    const producer = (async () => {
      try {
        const deltas = this.mapCoreDeltas(turn);
        for await (const sentence of streamSentences(deltas, splitter)) {
          turn.fullText += sentence;
          turn.metrics.mark('first_sentence_ready');
          while (sentenceQueue.size >= 2 && !turn.aborted) {
            await sentenceQueue.waitForDrain(1);
          }
          if (turn.aborted) break;
          sentenceQueue.push({
            sentence,
            eager: new EagerIterable(() => this.synthSentenceToPcm(turn, sentence, style))
          });
        }
      } catch (error) {
        if (!turn.aborted) sentenceQueue.fail(error);
      } finally {
        sentenceQueue.close();
      }
    })();

    try {
      // thinking 期间可插 filler
      this.maybePlayFiller(turn);

      for await (const item of sentenceQueue) {
        for await (const frame of item.eager) {
          this.sendAudioFrame(turn, frame);
        }
        turn.playedText += item.sentence;
      }
      await producer;
    } catch (error) {
      if (error instanceof TurnAbortedError || turn.aborted) {
        // 打断路径：interrupted / reply 由 handleAbort 同步下发
        return;
      }
      // TTS / Core 失败：保留文字，明确降级（规范第 40 节）
      this.log.warn('turn_failed', { ...errorFields(error), stage: 'reply', turn_index: turn.index });
      const isTts = error instanceof ProviderError && error.code === 'tts_failed';
      this.sendJson({
        t: 'error',
        code: isTts ? 'tts_failed' : 'core_failed',
        message: isTts ? 'voice synthesis failed, text preserved' : 'core reply failed'
      });
      await producer.catch(() => undefined);
    }

    if (turn.aborted || this.turn !== turn) return;
    // 下发完整回复文本（文字永远不丢）
    if (turn.fullText) {
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

  private mapCoreDeltas(turn: ActiveTurn): AsyncGenerator<string> {
    const core = this.deps.core;
    const input = {
      conversationId: this.deps.conversationId ?? undefined,
      callId: this.deps.callId,
      turnId: turn.turnId,
      text: turn.userText,
      modality: 'voice_call' as const
    };
    return (async function* () {
      for await (const delta of core.streamReply(input)) {
        if (turn.aborted) throw new TurnAbortedError();
        turn.metrics.mark('llm_first_token');
        yield delta.text;
      }
    })();
  }

  /** 单句合成：流式优先，失败回退批量 PCM（规范第 40 节降级链） */
  private async *synthSentenceToPcm(
    turn: ActiveTurn,
    sentence: string,
    style: VoiceStyle
  ): AsyncGenerator<Buffer> {
    const request = {
      text: sentence,
      profile: this.deps.profile,
      style,
      format: 'pcm' as const,
      sampleRate: 24000,
      language: this.deps.profile.language
    };
    try {
      for await (const chunk of this.deps.tts.synthesizeStream(request)) {
        if (turn.aborted) throw new TurnAbortedError();
        turn.metrics.mark('tts_first_chunk');
        yield chunk.audio;
      }
      return;
    } catch (error) {
      if (error instanceof TurnAbortedError || turn.aborted) throw error;
      if (!(error instanceof ProviderError)) throw error;
    }
    // 降级：Batch TTS（PCM 24k）
    this.log.warn('tts_stream_fallback_batch', { turn_index: turn.index, sentence_len: sentence.length });
    const result = await this.deps.tts.synthesize(request);
    turn.metrics.mark('tts_first_chunk');
    for (const frame of chunkPcm16(result.audio, samplesForDuration(result.sampleRate, 20))) {
      if (turn.aborted) throw new TurnAbortedError();
      yield frame;
    }
  }

  private maybePlayFiller(turn: ActiveTurn): void {
    if (!this.deps.fillers.available || turn.aborted) return;
    const style = resolveStyle(this.deps.profile);
    const frames = this.deps.fillers.pickFrames(
      this.deps.profile.id,
      emotionToFillerCategory(style.emotion)
    );
    if (!frames || frames.length === 0) return;
    this.startPcmStream(turn);
    for (const frame of frames) {
      this.sendRaw(frame);
    }
    turn.metrics.setFillerPlayed();
    this.log.info('filler_played', { turn_index: turn.index });
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

  private startPcmStream(turn: ActiveTurn): void {
    if (turn.pcmStarted) return;
    turn.pcmStarted = true;
    this.sendJson({ t: 'pcm', rate: 24000 });
  }

  private sendAudioFrame(turn: ActiveTurn, frame: Buffer): void {
    if (turn.aborted || this.destroyed) throw new TurnAbortedError();
    this.startPcmStream(turn);
    if (this.stateMachine.is('thinking')) {
      this.stateMachine.transition('speaking');
      this.sendJson({ t: 'state', state: 'speaking' });
    }
    turn.metrics.mark('audio_play_request');
    this.sendRaw(frame);
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

  // -------------------------------------------------------------------------
  // 落库
  // -------------------------------------------------------------------------

  private writeTurn(turn: ActiveTurn, outcome: 'completed' | 'interrupted' | 'asr_failed'): void {
    if (turn.written || !this.deps.turnsRepo) return;
    turn.written = true;
    const metrics = turn.metrics.toDbColumns();
    try {
      this.deps.turnsRepo.insert({
        id: turn.turnId,
        call_id: this.deps.callId,
        turn_index: turn.index,
        user_text: outcome === 'asr_failed' ? null : turn.userText,
        assistant_text: outcome === 'asr_failed' ? null : turn.fullText,
        started_at: turn.startedAt,
        ended_at: Date.now(),
        interrupted: outcome === 'interrupted' ? 1 : 0,
        asr_latency_ms: metrics.asr_latency_ms,
        llm_first_token_ms: metrics.llm_first_token_ms,
        tts_first_audio_ms: metrics.tts_first_audio_ms,
        created_at: Date.now()
      });
    } catch (error) {
      this.log.warn('call_turn_write_failed', errorFields(error));
    }
  }
}
