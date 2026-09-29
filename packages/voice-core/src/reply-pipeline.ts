/**
 * ReplyPipeline：单轮回复的「Core 流 -> 切句 -> 流式 TTS -> PCM 下发」流水线（规范第 15/25/40 节）。
 * 从 CallSession 中拆出：会话层只管协议与状态机，这里只管音频生产。
 *
 * - 深度 1 的句子预取（上一句播放期间预热下一句 TTS）
 * - 流式 TTS 失败 -> 批量 PCM 兜底
 * - 全程检查 turn.aborted，保证 barge-in 真正取消
 * - Stream Identity（P0-3）：每轮回复独立 output_stream_id；每个二进制帧前发
 *   {t:'pcm', stream_id, sequence, rate, bytes} JSON 头，binary 与流的对应不靠猜
 * - 采样率全链路保留（P0-7）：rate 取每个 chunk 的真实值
 */
import { randomUUID } from 'node:crypto';
import type { CoreBridge } from '@siren/core-bridge';
import type {
  PcmChunk,
  ServerWsMessage,
  TtsProvider,
  VoiceProfile,
  VoiceStyle
} from '@siren/contracts';
import { ProviderError, REALTIME_OUTPUT_SAMPLE_RATE } from '@siren/contracts';
import { chunkPcm16, samplesForDuration } from '@siren/audio';
import { type Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';
import type { PrebufferedAsrSession } from './asr-prebuffer.ts';
import type { LatencyTracker } from '@siren/telemetry';
import { AsyncQueue, EagerIterable } from './async-queue.ts';
import { SentenceSplitter, streamSentences } from './sentence-splitter.ts';
import { emotionToFillerCategory, resolveStyle } from './emotion.ts';
import type { FillerManager } from './filler-manager.ts';

/** 内部信号：本轮已被打断 */
export class TurnAbortedError extends Error {
  constructor() {
    super('turn aborted');
    this.name = 'TurnAbortedError';
  }
}

/** 分配一次 TTS 输出流的标识（P0-3：out_ 前缀 + 随机） */
export function newOutputStreamId(): string {
  return `out_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** 一轮通话的运行时状态（CallSession 创建，流水线读写音频相关字段） */
export interface ActiveTurn {
  index: number;
  turnId: string;
  outputStreamId: string;
  /** 下行二进制帧序号（在每个 pcm 头中递增） */
  nextSequence: number;
  userText: string;
  asr: PrebufferedAsrSession;
  metrics: LatencyTracker;
  startedAt: number;
  /** 用户显式 abort */
  aborted: boolean;
  /** TTS 生成取消信号：barge-in 时立即终止 provider 上游（P0-2/P0-9） */
  ttsAbort: AbortController;
  /** LLM 已输出的完整文本 */
  fullText: string;
  /** 已真正完成下发音频的句子 */
  playedText: string;
  pcmStarted: boolean;
  written: boolean;
}

export type ReplyResult =
  | { status: 'ok' }
  | { status: 'aborted' }
  | { status: 'failed'; kind: 'tts' | 'core'; error: unknown };

/** 会话层提供给流水线的输出通道 */
export interface ReplyPipelinePort {
  sendJson(message: ServerWsMessage): void;
  sendRaw(frame: Buffer): void;
  /** 第一帧音频即将下发（会话层完成 thinking -> speaking 迁移） */
  onFirstAudio(): void;
}

export interface ReplyPipelineDeps {
  config: SirenConfig;
  logger: Logger;
  callId: string;
  conversationId: string | null;
  profile: VoiceProfile;
  tts: TtsProvider;
  core: CoreBridge;
  fillers: FillerManager;
}

export class ReplyPipeline {
  private readonly log: Logger;

  constructor(
    private readonly deps: ReplyPipelineDeps,
    private readonly port: ReplyPipelinePort
  ) {
    this.log = deps.logger.child({ component: 'reply-pipeline', call_id: deps.callId });
  }

  async run(turn: ActiveTurn): Promise<ReplyResult> {
    const style: VoiceStyle = resolveStyle(this.deps.profile);
    const splitter = new SentenceSplitter();
    const sentenceQueue = new AsyncQueue<{ sentence: string; eager: EagerIterable<PcmChunk> }>();
    // F07：失败路径的取消信号——pipeline 出错时除 user abort 外也要终止在途 TTS，
    // 否则已排队的句子继续在后台合成，浪费供应商配额
    const failureAbort = new AbortController();
    const ttsSignal: AbortSignal = AbortSignal.any([turn.ttsAbort.signal, failureAbort.signal]);

    // 生产者：core 句子 -> 预取的 TTS chunk 流（深度 1 的流水线）
    const producer = (async () => {
      try {
        const deltas = this.mapCoreDeltas(turn);
        for await (const sentence of streamSentences(deltas, splitter)) {
          turn.fullText += sentence;
          turn.metrics.mark('first_sentence_ready');
          while (sentenceQueue.size >= 2 && !turn.aborted && !sentenceQueue.closed) {
            await sentenceQueue.waitForDrain(1);
          }
          if (turn.aborted || sentenceQueue.closed) break;
          const eager = new EagerIterable(() => this.synthSentenceToPcm(turn, sentence, style, ttsSignal));
          // 真实预取（审计修复）：句子进入队列即开始 TTS，
          // 上一句播放期间下一句已在合成，而不是等消费者迭代才启动
          eager.start();
          sentenceQueue.push({ sentence, eager });
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
        for await (const chunk of item.eager) {
          this.sendAudioChunk(turn, chunk);
        }
        turn.playedText += item.sentence;
      }
      await producer;
    } catch (error) {
      // F07 错误路径必须按序解锁：先关队列（唤醒卡在 waitForDrain 的生产者）、
      // 再取消在途 TTS、最后才 await 生产者——任何颠倒都会重新互等
      sentenceQueue.close();
      failureAbort.abort();
      if (error instanceof TurnAbortedError || turn.aborted) {
        // 打断路径：interrupted / reply 由 CallSession.handleAbort 同步下发
        return { status: 'aborted' };
      }
      await producer.catch(() => undefined);
      const isTts = error instanceof ProviderError && error.code === 'tts_failed';
      return { status: 'failed', kind: isTts ? 'tts' : 'core', error };
    }
    return { status: 'ok' };
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

  /** 单句合成：流式优先，失败回退批量 PCM（规范第 40 节降级链）。
   * F12：降级只在句子尚未输出任何音频时进行——流式已下发前缀后再批量合成
   * 整句会重播句首，此时按 tts_failed 失败处理，保留已播出内容 */
  private async *synthSentenceToPcm(
    turn: ActiveTurn,
    sentence: string,
    style: VoiceStyle,
    signal: AbortSignal
  ): AsyncGenerator<PcmChunk> {
    if (signal.aborted) throw new TurnAbortedError();
    const request = {
      text: sentence,
      profile: this.deps.profile,
      style,
      format: 'pcm' as const,
      sampleRate: REALTIME_OUTPUT_SAMPLE_RATE,
      language: this.deps.profile.language
    };
    let emitted = false;
    try {
      for await (const chunk of this.deps.tts.synthesizeStream(request, signal)) {
        if (turn.aborted) throw new TurnAbortedError();
        turn.metrics.mark('tts_first_chunk');
        emitted = true;
        yield { audio: chunk.audio, sampleRate: chunk.sampleRate };
      }
      return;
    } catch (error) {
      // provider 被 abort 时上游抛错：翻译成本轮取消信号
      if (turn.aborted || signal.aborted) throw new TurnAbortedError();
      if (error instanceof TurnAbortedError) throw error;
      if (!(error instanceof ProviderError)) throw error;
      if (emitted) {
        this.log.warn('tts_stream_failed_after_partial_audio', {
          turn_index: turn.index,
          sentence_len: sentence.length
        });
        throw new ProviderError('tts_failed', 'reply-pipeline', 'tts stream failed after partial audio emitted');
      }
    }
    // 降级：Batch TTS（按 provider 返回的真实采样率）；仅零输出句子可整句重来
    this.log.warn('tts_stream_fallback_batch', { turn_index: turn.index, sentence_len: sentence.length });
    const result = await this.deps.tts.synthesize(request);
    turn.metrics.mark('tts_first_chunk');
    for (const frame of chunkPcm16(result.audio, samplesForDuration(result.sampleRate, 20))) {
      if (turn.aborted) throw new TurnAbortedError();
      yield { audio: frame, sampleRate: result.sampleRate };
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
    turn.metrics.setFillerPlayed();
    this.log.info('filler_played', { turn_index: turn.index });
    for (const frame of frames) {
      this.sendAudioChunk(turn, { audio: frame, sampleRate: REALTIME_OUTPUT_SAMPLE_RATE });
    }
  }

  /** 每个二进制帧前发 JSON 头：stream_id + sequence + 真实 rate + bytes（P0-3/P0-7） */
  private sendAudioChunk(turn: ActiveTurn, chunk: PcmChunk): void {
    if (turn.aborted) throw new TurnAbortedError();
    const first = !turn.pcmStarted;
    turn.pcmStarted = true;
    if (first) this.port.onFirstAudio();
    turn.metrics.mark('audio_play_request');
    this.port.sendJson({
      t: 'pcm',
      stream_id: turn.outputStreamId,
      sequence: turn.nextSequence++,
      rate: chunk.sampleRate,
      bytes: chunk.audio.length
    });
    this.port.sendRaw(chunk.audio);
  }
}
