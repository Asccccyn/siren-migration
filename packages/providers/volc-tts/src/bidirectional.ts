/**
 * 火山引擎双向流式 TTS Provider（P0-9 真 provider-level streaming）。
 *
 * 协议：wss://openspeech.bytedance.com/api/v3/tts/bidirection（事件驱动，
 * 见 bidirectional-protocol.ts）。文本流式输入、音频流式输出：
 *   StartConnection -> ConnectionStarted -> StartSession(speaker/audio_params)
 *   -> TaskRequest(text) -> TTSResponse*(audio chunks) -> FinishSession
 *   -> SessionFinished
 *
 * - 连接生命周期：open() 发送 StartConnection 后等待 ConnectionStarted(50)
 *   才 resolve（官方顺序）；ConnectionFailed(51)/超时则拒绝
 * - 连接复用：一条 WebSocket 承载多个 session（按 session id 多路复用），
 *   句间无需重新握手；socket 级错误才 kill 整条连接，下次调用重建
 * - 取消是 session 级的（审计修复）：AbortSignal 发送 CancelSession(101) 让服务端
 *   真正停止该 session 的合成（回 SessionCanceled/151），只 fail 自己的 channel，
 *   连接继续承载其他通话的 session
 * - 建连互斥（审计修复）：并发首次调用共享同一个 connecting promise，
 *   不会产生孤儿连接
 * - 采样率：chunk 携带真实 sampleRate（P0-7）
 */
import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  type PcmChunk,
  type StreamTtsProvider,
  type TtsRequest
} from '@siren/contracts';
import type { Logger } from '@siren/telemetry';
import WebSocket from 'ws';
import {
  decodeServerFrame,
  encodeClientEventFrame,
  EVENT,
  type BidirectionServerFrame
} from './bidirectional-protocol.ts';
import { mapStyleToVolcAudio } from './voice-map.ts';

export interface VolcBidirectionalTtsConfig {
  appId: string;
  accessToken: string;
  /** 新版控制台单一 API Key（设置后握手走 X-Api-Key 单头） */
  apiKey?: string;
  /** 如 volc.service_type.10029（大模型语音合成） */
  resourceId: string;
  wsUrl: string;
  connectTimeoutMs: number;
  /** 单 session 无活动超时 */
  sessionTimeoutMs: number;
}

/** 单个 session 的下行通道：音频队列 + 事件等待 */
class SessionChannel {
  private audioQueue: Buffer[] = [];
  private audioWaiters: ((chunk: Buffer | null) => void)[] = [];
  private failure: Error | null = null;
  private finished = false;
  private readonly seenEvents = new Set<number>();
  private readonly eventWaiters = new Map<number, () => void>();
  private readonly failureWaiters: ((error: Error) => void)[] = [];

  pushAudio(chunk: Buffer): void {
    const waiter = this.audioWaiters.shift();
    if (waiter) waiter(chunk);
    else this.audioQueue.push(chunk);
  }

  /** 拉取下一块音频；null 表示本 session 结束 */
  nextAudio(): Promise<Buffer | null> {
    if (this.audioQueue.length > 0) return Promise.resolve(this.audioQueue.shift() ?? null);
    if (this.finished || this.failure) return Promise.resolve(null);
    return new Promise((resolve) => this.audioWaiters.push(resolve));
  }

  /** 等待某个事件到达（已到达过则立即返回；session 失败则拒绝） */
  waitFor(event: number): Promise<void> {
    if (this.seenEvents.has(event)) return Promise.resolve();
    if (this.eventWaiters.has(event)) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.eventWaiters.set(event, () => resolve());
      this.failureWaiters.push(reject);
    });
  }

  handleEvent(event: number): void {
    this.seenEvents.add(event);
    if (event === EVENT.SESSION_FINISHED || event === EVENT.SESSION_CANCELED) {
      this.finished = true;
      this.drainWaiters(null);
    }
    const waiter = this.eventWaiters.get(event);
    if (waiter) {
      this.eventWaiters.delete(event);
      waiter();
    }
  }

  fail(error: Error): void {
    if (this.failure || this.finished) return;
    this.failure = error;
    this.finished = true;
    this.drainWaiters(null);
    for (const reject of this.failureWaiters.splice(0)) reject(error);
  }

  get error(): Error | null {
    return this.failure;
  }

  private drainWaiters(value: Buffer | null): void {
    for (const waiter of this.audioWaiters.splice(0)) waiter(value);
  }
}

/** 一条可复用的双向流式连接 */
class BidirectionConnection {
  private dead = false;
  private readonly channels = new Map<string, SessionChannel>();
  /** 已发送过 CancelSession 的 session（幂等：abort 回调与 finally 各调一次时不重发） */
  private readonly canceledSessions = new Set<string>();
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;

  private constructor(
    readonly socket: WebSocket,
    connectTimeoutMs: number
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => {
      // 审计修复：超时必须 kill 整条 socket（terminate），只 settleReady 会留下
      // 已建立但永不就绪的孤儿连接，连续失败会积累
      this.kill(
        new ProviderError('provider_timeout', 'volc-tts', 'tts connection start timeout')
      );
    }, connectTimeoutMs);
    timer.unref?.();
    this.readyPromise.catch(() => undefined).finally(() => clearTimeout(timer));
  }

  static async open(config: VolcBidirectionalTtsConfig, logger?: Logger): Promise<BidirectionConnection> {
    const connectId = randomUUID();
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      // 新版控制台单一 API Key -> X-Api-Key 单头；旧版双件套 -> App-Key + Access-Key
      const authHeaders: Record<string, string> = config.apiKey
        ? { 'X-Api-Key': config.apiKey }
        : {
            'X-Api-App-Key': config.appId,
            'X-Api-Access-Key': config.accessToken
          };
      const ws = new WebSocket(config.wsUrl, {
        handshakeTimeout: config.connectTimeoutMs,
        headers: {
          ...authHeaders,
          'X-Api-Resource-Id': config.resourceId,
          'X-Api-Connect-Id': connectId
        }
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', (error) =>
        reject(new ProviderError('provider_unavailable', 'volc-tts', 'tts websocket connect failed', error))
      );
    });
    const connection = new BidirectionConnection(socket, config.connectTimeoutMs);
    socket.on('message', (data) => {
      try {
        connection.dispatch(decodeServerFrame(Buffer.from(data as Buffer)));
      } catch (error) {
        logger?.warn('tts_bidi_frame_parse_failed', { error_message: (error as Error).message });
      }
    });
    socket.once('error', (error) => connection.kill(error));
    socket.once('close', () => connection.kill(new Error('tts websocket closed')));
    // StartConnection（payload 空对象）；open() 在 ConnectionStarted 之前不返回
    socket.send(encodeClientEventFrame(EVENT.START_CONNECTION, null, {}));
    await connection.readyPromise;
    return connection;
  }

  get isDead(): boolean {
    return this.dead;
  }

  register(sessionId: string): SessionChannel {
    if (this.dead) throw new Error('connection dead');
    const channel = new SessionChannel();
    this.channels.set(sessionId, channel);
    return channel;
  }

  send(event: number, sessionId: string | null, payload: unknown): void {
    if (this.dead) throw new Error('connection dead');
    this.socket.send(encodeClientEventFrame(event, sessionId, payload));
  }

  /**
   * session 级取消（审计修复）：只 fail 自己的 channel，并向服务端发
   * CancelSession(101)——与 FinishSession(102) 不同，101 语义是"停止合成"，
   * 服务端会中止该 session 的剩余音频并回 SessionCanceled(151)。
   * 连接保持存活，其他通话的 session 不受影响。
   */
  cancelSession(sessionId: string, cause: string): void {
    const channel = this.channels.get(sessionId);
    if (channel) {
      channel.fail(new ProviderError('tts_failed', 'volc-tts', cause));
      this.channels.delete(sessionId);
    }
    if (!this.dead && !this.canceledSessions.has(sessionId)) {
      // 幂等：同一 session 只向上游发一次 CancelSession（abort 回调与
      // synthesizeStream finally 都会走到这里）
      this.canceledSessions.add(sessionId);
      try {
        this.socket.send(encodeClientEventFrame(EVENT.CANCEL_SESSION, sessionId, {}));
      } catch {
        // socket 已不可写：连接随后会被 kill 兜底
      }
    }
  }

  /** 会话结束（正常或失败）后注销通道 */
  release(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  /** 连接整体关闭：进程关停 / socket 错误时使用 */
  kill(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.settleReady(
      new ProviderError('provider_unavailable', 'volc-tts', `tts bidi connection lost: ${error.message}`)
    );
    for (const channel of this.channels.values()) {
      channel.fail(new ProviderError('tts_failed', 'volc-tts', `tts bidi connection lost: ${error.message}`, error));
    }
    this.channels.clear();
    try {
      this.socket.terminate();
    } catch {
      // 已关闭
    }
  }

  private settleReady(error: Error | null): void {
    if (this.readySettled) return;
    this.readySettled = true;
    if (error) this.readyReject(error);
    else this.readyResolve();
  }

  private dispatch(frame: BidirectionServerFrame): void {
    if (frame.kind === 'error') {
      // 连接级错误：失败全部 session
      this.kill(new ProviderError('tts_failed', 'volc-tts', `tts error code=${frame.code} ${frame.message}`));
      return;
    }
    if (frame.kind === 'connection-event') {
      if (frame.event === EVENT.CONNECTION_STARTED) {
        this.settleReady(null);
      } else if (frame.event === EVENT.CONNECTION_FAILED) {
        this.kill(new ProviderError('tts_failed', 'volc-tts', 'tts connection failed'));
      }
      return;
    }
    const channel = this.channels.get(frame.sessionId);
    if (!channel) return; // 已取消/已释放的 session：迟到事件直接忽略
    if (frame.kind === 'session-audio') {
      channel.pushAudio(frame.audio);
      return;
    }
    if (frame.event === EVENT.SESSION_FAILED) {
      channel.fail(
        new ProviderError('tts_failed', 'volc-tts', `tts session failed: ${JSON.stringify(frame.payload)}`)
      );
      this.release(frame.sessionId);
      return;
    }
    channel.handleEvent(frame.event);
    if (frame.event === EVENT.SESSION_FINISHED || frame.event === EVENT.SESSION_CANCELED) {
      this.release(frame.sessionId);
    }
  }
}

export class VolcBidirectionalTtsProvider implements StreamTtsProvider {
  private connection: BidirectionConnection | null = null;
  /** 建连互斥：并发首次调用共享同一个连接建立过程（审计修复） */
  private connecting: Promise<BidirectionConnection> | null = null;
  /** dispose 后拒绝新会话，并防止 in-flight 建连结果复活 connection（审计修复） */
  private disposed = false;
  /**
   * session 串行链：seed-tts-2.0 拒绝同一连接上的并发 session
   * （第二个 StartSession 会收到 55000000 并杀掉整条连接，2026-09-29 实测）。
   * 每个合成请求排队等前一个 session Finish/Cancel 后再开——共享连接保留，
   * reply-pipeline 的预取退化为"排队预热"，仍在上一句结束瞬间启动下一句。
   */
  private sessionChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: VolcBidirectionalTtsConfig,
    private readonly logger?: Logger
  ) {}

  /** 真 provider-level streaming：边合成边产出 PCM chunk（session 串行化后逐个执行） */
  async *synthesizeStream(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.sessionChain;
    this.sessionChain = gate;
    await previous;
    if (signal?.aborted) {
      release();
      throw new ProviderError('tts_failed', 'volc-tts', 'tts aborted');
    }
    try {
      yield* this.streamOnce(request, signal);
    } finally {
      release();
    }
  }

  private async *streamOnce(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError(
        'provider_unavailable',
        'volc-tts',
        'voice id missing (set VOLC_VOICE_ID or profile voiceId)'
      );
    }
    const sampleRate = request.sampleRate ?? 24000;
    const connection = await this.ensureConnection(signal);
    if (signal?.aborted) {
      // F14：取消发生在建连 await 期间——此时 abort 监听尚未注册，
      // 不检查就会照常注册 session 并提交合成
      throw new ProviderError('tts_failed', 'volc-tts', 'tts aborted');
    }
    const sessionId = randomUUID();
    const channel = connection.register(sessionId);

    // session 级取消：不 kill 共享连接（审计修复）
    const onAbort = () => connection.cancelSession(sessionId, 'tts aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    let completed = false;
    try {
      this.sendStartSession(connection, sessionId, request, voiceId, sampleRate);
      await withTimeout(channel.waitFor(EVENT.SESSION_STARTED), this.config.sessionTimeoutMs, 'tts session start timeout');
      connection.send(EVENT.TASK_REQUEST, sessionId, {
        event: EVENT.TASK_REQUEST,
        namespace: 'BidirectionalTTS',
        req_params: { text: request.ttsScript ?? request.text }
      });
      connection.send(EVENT.FINISH_SESSION, sessionId, {});

      while (true) {
        if (signal?.aborted) throw new ProviderError('tts_failed', 'volc-tts', 'tts aborted');
        const chunk = await withTimeout(channel.nextAudio(), this.config.sessionTimeoutMs, 'tts audio timeout');
        if (!chunk) break;
        yield { audio: chunk, sampleRate };
      }
      const failure = channel.error;
      if (failure) throw failure;
      completed = true;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!completed) {
        // F15：超时/异常/提前退出都要取消上游 session——只 release 本地通道的话，
        // 服务端会继续为该 session 合成并推送（与 batch 降级重叠消耗配额）
        connection.cancelSession(sessionId, 'tts stream did not complete');
      }
      connection.release(sessionId);
    }
  }

  /** 进程关停：关闭共享连接（app dispose 时调用） */
  dispose(): void {
    this.disposed = true;
    this.connection?.kill(new ProviderError('tts_failed', 'volc-tts', 'provider disposed'));
    this.connection = null;
    // connecting 不在此处等待：open 结果在 ensureConnection 的回调里按
    // disposed 标志拦截并 kill，不会写回 this.connection
    this.connecting = null;
  }

  private sendStartSession(
    connection: BidirectionConnection,
    sessionId: string,
    request: TtsRequest,
    voiceId: string,
    sampleRate: number
  ): void {
    const style = mapStyleToVolcAudio(request.style, request.profile.emotionMap);
    const speechRate = clampSpeechRate(((request.style.speed ?? 1) - 1) * 100);
    connection.send(EVENT.START_SESSION, sessionId, {
      event: EVENT.START_SESSION,
      namespace: 'BidirectionalTTS',
      user: { uid: 'siren' },
      req_params: {
        speaker: voiceId,
        audio_params: {
          format: 'pcm',
          sample_rate: sampleRate,
          ...(style.emotion ? { emotion: style.emotion } : {}),
          ...(style.emotion_scale !== undefined ? { emotion_scale: style.emotion_scale } : {}),
          ...(speechRate !== 0 ? { speech_rate: speechRate } : {})
        }
      }
    });
  }

  private async ensureConnection(signal?: AbortSignal): Promise<BidirectionConnection> {
    if (signal?.aborted) throw new ProviderError('tts_failed', 'volc-tts', 'tts aborted');
    if (this.disposed) {
      throw new ProviderError('provider_unavailable', 'volc-tts', 'provider disposed');
    }
    if (this.connection && !this.connection.isDead) return this.connection;
    if (!this.connecting) {
      this.connecting = (async () => {
        const connection = await BidirectionConnection.open(this.config, this.logger);
        if (this.disposed) {
          // dispose 发生在建连期间：立即关闭新连接，禁止写回（防复活）
          connection.kill(new Error('provider disposed during connect'));
          throw new ProviderError('provider_unavailable', 'volc-tts', 'provider disposed');
        }
        this.connection = connection;
        return connection;
      })().finally(() => {
        this.connecting = null;
      });
    }
    const connecting = this.connecting;
    if (!signal) return connecting;
    // F14：建连等待期间取消也要立即失败，让取消方等到明确结果而不是超时
    return Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new ProviderError('tts_failed', 'volc-tts', 'tts aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        // 连接先就绪则解绑监听，不在长寿命信号上留闭包
        connecting
          .catch(() => undefined)
          .finally(() => signal.removeEventListener('abort', onAbort));
      })
    ]);
  }
}

/** speech_rate 合法区间 [-50, 100]（官方 audio_params 定义） */
function clampSpeechRate(value: number): number {
  return Math.round(Math.min(Math.max(value, -50), 100));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('provider_timeout', 'volc-tts', message)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
