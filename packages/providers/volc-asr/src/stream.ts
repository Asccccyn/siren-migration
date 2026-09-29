/**
 * 火山引擎大模型流式 ASR v3（sauc/bigmodel，2026-09 按官方文档重写）。
 *
 * 与 v2 的差异：
 * - 鉴权改 HTTP header（X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Connect-Id），
 *   不再把 token 放进 URL query
 * - 二进制帧 4B header + gzip payload；末帧 = audio only + last packet flag
 * - 服务端 full response 带 sequence（负值=末包）；error 帧带 code + message
 *
 * 每次 talk 创建新 session（Siren 的 PrebufferedAsrSession 负责句首保护）。
 * 音频按 100ms 聚批上行（官方建议 100-200ms/包）。
 */
import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  type AsrStream,
  type AsrStreamHandlers,
  type StreamAsrOptions,
  type StreamAsrProvider,
  type TranscriptResult
} from '@siren/contracts';
import type { Logger } from '@siren/telemetry';
import WebSocket from 'ws';
import {
  buildFullRequest,
  decodeServerFrame,
  encodeAudioFrame,
  encodeLastAudioFrame,
  type VolcAsrStreamConfig
} from './protocol.ts';

/** 100ms @16k PCM16 = 3200 字节 */
const FEED_BATCH_BYTES = 3200;
/** end() 后等待 final 的兜底超时 */
const FINAL_TIMEOUT_MS = 5000;

interface PendingFinal {
  resolve: (result: TranscriptResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export class VolcStreamAsrProvider implements StreamAsrProvider {
  constructor(
    private readonly config: VolcAsrStreamConfig,
    private readonly logger?: Logger
  ) {}

  async createStream(options: StreamAsrOptions, handlers: AsrStreamHandlers): Promise<AsrStream> {
    const requestId = randomUUID();
    const connectId = randomUUID();
    const socket = await this.connect(connectId);
    const session = new VolcAsrSession(socket, this.config, requestId, options, handlers, this.logger);
    socket.on('message', (data) => {
      try {
        session.handleServerFrame(decodeServerFrame(Buffer.from(data as Buffer)));
      } catch (error) {
        session.handleError(error);
      }
    });
    socket.once('error', (error) => session.handleError(error));
    socket.once('close', () => session.handleClose());
    // 首帧 full client request（options 的 language / profile uid 进入请求；
    // language 仅多语种端点携带，由协议层判断）
    socket.send(
      buildFullRequest(this.config, requestId, {
        language: options.language,
        uid: options.profile ? `siren:${options.profile.id}` : 'siren'
      })
    );
    return session;
  }

  private async connect(connectId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // 新版控制台单一 API Key -> X-Api-Key 单头；旧版双件套 -> App-Key + Access-Key
      const authHeaders: Record<string, string> = this.config.apiKey
        ? { 'X-Api-Key': this.config.apiKey }
        : {
            'X-Api-App-Key': this.config.appId,
            'X-Api-Access-Key': this.config.accessToken
          };
      const socket = new WebSocket(this.config.wsUrl, {
        handshakeTimeout: this.config.connectTimeoutMs,
        headers: {
          ...authHeaders,
          'X-Api-Resource-Id': this.config.resourceId,
          'X-Api-Connect-Id': connectId
        }
      });
      socket.once('open', () => resolve(socket));
      socket.once('error', (error) =>
        reject(new ProviderError('provider_unavailable', 'volc-asr', 'asr websocket connect failed', error))
      );
    });
  }
}

class VolcAsrSession implements AsrStream {
  private ended = false;
  private aborted = false;
  private pendingFinal: PendingFinal | null = null;
  private lastPartialText = '';
  private lastFinalText = '';
  /** F13：已提交 definite 分句的 start_time 身份集合（代替文字后缀匹配去重） */
  private readonly committedUtterances = new Set<string>();
  private feedBatch: Buffer[] = [];
  private feedBatchBytes = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly config: VolcAsrStreamConfig,
    private readonly requestId: string,
    private readonly options: StreamAsrOptions,
    private readonly handlers: AsrStreamHandlers,
    private readonly logger?: Logger
  ) {}

  feed(pcm: Buffer): void {
    if (this.ended || this.aborted || pcm.length === 0) return;
    this.feedBatch.push(pcm);
    this.feedBatchBytes += pcm.length;
    if (this.feedBatchBytes >= FEED_BATCH_BYTES) {
      this.flushFeed();
    }
  }

  end(): Promise<TranscriptResult> {
    if (this.ended) {
      return Promise.resolve(this.buildResult());
    }
    this.ended = true;
    this.flushFeed();
    // 末包：audio only + last packet flag
    try {
      this.socket.send(encodeLastAudioFrame());
    } catch (error) {
      return Promise.reject(new ProviderError('asr_failed', 'volc-asr', 'asr last frame send failed', error));
    }
    return new Promise<TranscriptResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时降级：采用最新稳定结果（规范第 23 节策略的兜底）
        this.pendingFinal = null;
        this.cleanup();
        resolve(this.buildResult());
      }, FINAL_TIMEOUT_MS);
      this.pendingFinal = { resolve, reject, timer };
    });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.pendingFinal) {
      clearTimeout(this.pendingFinal.timer);
      this.pendingFinal.reject(new ProviderError('asr_failed', 'volc-asr', 'asr session aborted'));
      this.pendingFinal = null;
    }
    this.cleanup();
  }

  handleServerFrame(frame: {
    kind: 'result';
    sequence: number;
    payload: {
      result?: {
        text?: string;
        utterances?: { text?: string; definite?: boolean; start_time?: number; end_time?: number }[];
      };
    };
    isLast: boolean;
  } | { kind: 'error'; code: number; message: string }): void {
    if (this.aborted) return;
    if (frame.kind === 'error') {
      const error = new ProviderError(
        'asr_failed',
        'volc-asr',
        `asr error code=${frame.code} ${frame.message}`
      );
      this.handlers.onError?.(error);
      this.failPending(error);
      this.cleanup();
      return;
    }
    const utterances = frame.payload.result?.utterances ?? [];
    // partial 可重复更新（覆盖式）；final（definite=true）只提交一次且不重复拼接。
    // F13：按 start_time 识别重传——两次真实说出的相同话语时间戳不同，都会保留；
    // 服务端跨帧重发同一分句时 start_time 相同，只提交一次
    for (const utterance of utterances) {
      if (!utterance.definite || !utterance.text) continue;
      if (typeof utterance.start_time === 'number') {
        const key = `${utterance.start_time}|${utterance.text}`;
        if (this.committedUtterances.has(key)) continue;
        this.committedUtterances.add(key);
        this.lastFinalText += utterance.text;
      } else if (!this.lastFinalText.endsWith(utterance.text)) {
        // 无时间戳兜底：沿用后缀防重（同帧/紧邻重发）
        this.lastFinalText += utterance.text;
      }
    }
    const interim = frame.payload.result?.text ?? '';
    if (interim && !this.lastFinalText.endsWith(interim)) {
      this.lastPartialText = interim;
      this.handlers.onPartial?.(interim);
    }
    if (this.ended && frame.isLast) {
      this.settlePending();
    }
  }

  handleError(error: unknown): void {
    if (this.aborted) return;
    this.handlers.onError?.(error);
    this.failPending(new ProviderError('asr_failed', 'volc-asr', 'asr websocket error', error));
    this.cleanup();
  }

  handleClose(): void {
    if (this.aborted) return;
    this.settlePending();
  }

  private flushFeed(): void {
    if (this.feedBatchBytes === 0) return;
    const merged = Buffer.concat(this.feedBatch);
    this.feedBatch = [];
    this.feedBatchBytes = 0;
    try {
      this.socket.send(encodeAudioFrame(merged), { binary: true });
    } catch (error) {
      this.handleError(error);
    }
  }

  private settlePending(): void {
    if (!this.pendingFinal) return;
    clearTimeout(this.pendingFinal.timer);
    const pending = this.pendingFinal;
    this.pendingFinal = null;
    this.cleanup();
    pending.resolve(this.buildResult());
  }

  private failPending(error: unknown): void {
    if (!this.pendingFinal) return;
    clearTimeout(this.pendingFinal.timer);
    const pending = this.pendingFinal;
    this.pendingFinal = null;
    pending.reject(error);
  }

  private buildResult(): TranscriptResult {
    const text = (this.lastFinalText || this.lastPartialText).trim();
    return { text, language: this.options.language ?? 'zh-CN', durationMs: 0 };
  }

  private cleanup(): void {
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close(1000, 'siren-done');
      }
    } catch {
      // socket 可能已关闭
    }
    this.logger?.debug('volc_asr_session_closed', { reqid: this.requestId });
  }
}
