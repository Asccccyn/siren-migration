/**
 * 火山引擎双向流式 TTS Provider（P0-9 真 provider-level streaming）。
 *
 * 协议：wss://openspeech.bytedance.com/api/v3/tts/bidirection（事件驱动，
 * 见 bidirectional-protocol.ts）。文本流式输入、音频流式输出：
 *   StartConnection -> StartSession(speaker/audio_params) -> TaskRequest(text)
 *   -> TTSResponse*(audio chunks) -> FinishSession -> SessionFinished
 *
 * - 连接复用：一条 WebSocket 承载多个 session（按 session id 多路复用），
 *   句间无需重新握手；断线自动丢弃，下次调用重建
 * - AbortSignal：abort 立即关闭连接（provider 真正停止，不是只停止消费）
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
  private started = false;
  private readonly channels = new Map<string, SessionChannel>();

  private constructor(readonly socket: WebSocket) {}

  static async open(config: VolcBidirectionalTtsConfig, logger?: Logger): Promise<BidirectionConnection> {
    const connectId = randomUUID();
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(config.wsUrl, {
        handshakeTimeout: config.connectTimeoutMs,
        headers: {
          'X-Api-App-Key': config.appId,
          'X-Api-Access-Key': config.accessToken,
          'X-Api-Resource-Id': config.resourceId,
          'X-Api-Connect-Id': connectId
        }
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', (error) =>
        reject(new ProviderError('provider_unavailable', 'volc-tts', 'tts websocket connect failed', error))
      );
    });
    const connection = new BidirectionConnection(socket);
    socket.on('message', (data) => {
      try {
        connection.dispatch(decodeServerFrame(Buffer.from(data as Buffer)));
      } catch (error) {
        logger?.warn('tts_bidi_frame_parse_failed', { error_message: (error as Error).message });
      }
    });
    socket.once('error', (error) => connection.kill(error));
    socket.once('close', () => connection.kill(new Error('tts websocket closed')));
    // StartConnection（payload 空对象）
    socket.send(encodeClientEventFrame(EVENT.START_CONNECTION, null, {}));
    return connection;
  }

  get isDead(): boolean {
    return this.dead;
  }

  register(sessionId: string): SessionChannel {
    if (this.dead) throw new Error('connection dead');
    if (!this.started) this.started = true;
    const channel = new SessionChannel();
    this.channels.set(sessionId, channel);
    return channel;
  }

  send(event: number, sessionId: string | null, payload: unknown): void {
    if (this.dead) throw new Error('connection dead');
    this.socket.send(encodeClientEventFrame(event, sessionId, payload));
  }

  /** 会话结束（正常或失败）后注销通道 */
  release(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  kill(error: Error): void {
    if (this.dead) return;
    this.dead = true;
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

  private dispatch(frame: BidirectionServerFrame): void {
    if (frame.kind === 'error') {
      // 连接级错误：失败全部 session
      this.kill(new ProviderError('tts_failed', 'volc-tts', `tts error code=${frame.code} ${frame.message}`));
      return;
    }
    if (frame.kind === 'connection-event') {
      if (frame.event === EVENT.CONNECTION_FAILED) {
        this.kill(new ProviderError('tts_failed', 'volc-tts', 'tts connection failed'));
      }
      return;
    }
    const channel = this.channels.get(frame.sessionId);
    if (!channel) return;
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

  constructor(
    private readonly config: VolcBidirectionalTtsConfig,
    private readonly logger?: Logger
  ) {}

  /** 真 provider-level streaming：边合成边产出 PCM chunk */
  async *synthesizeStream(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
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
    const sessionId = randomUUID();
    const channel = connection.register(sessionId);

    const onAbort = () => connection.kill(new ProviderError('tts_failed', 'volc-tts', 'tts aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

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
    } finally {
      signal?.removeEventListener('abort', onAbort);
      connection.release(sessionId);
    }
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
    if (this.connection && !this.connection.isDead) return this.connection;
    this.connection = await BidirectionConnection.open(this.config, this.logger);
    return this.connection;
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
