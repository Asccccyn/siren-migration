/**
 * 火山引擎流式 ASR（wss，v2 协议）。
 * 每次讲话创建新会话（规范第 22 节），句首由调用方 prebuffer 保证不丢。
 */
import { randomUUID } from 'node:crypto';
import { ProviderError, type AsrStream, type AsrStreamHandlers, type StreamAsrOptions, type StreamAsrProvider, type TranscriptResult } from '@siren/contracts';
import type { Logger } from '@siren/telemetry';
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, buildFullRequestHeader, VOLC_ASR_SUCCESS_CODE, type VolcAsrStreamConfig } from './protocol.ts';

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
    const headerJson = buildFullRequestHeader(this.config, requestId);
    const socket = await this.connect(requestId);
    const session = new VolcAsrSession(socket, headerJson, requestId, handlers, this.logger);
    socket.on('message', (data) => {
      try {
        session.handleServerFrame(decodeFrame(Buffer.from(data as Buffer)));
      } catch (error) {
        session.handleError(error);
      }
    });
    socket.once('error', (error) => session.handleError(error));
    socket.once('close', () => session.handleClose());
    return session;
  }

  private async connect(requestId: string): Promise<WebSocket> {
    const url = new URL(this.config.wsUrl);
    url.searchParams.set('appid', this.config.appId);
    url.searchParams.set('cluster', this.config.cluster);
    url.searchParams.set('token', this.config.accessToken);
    url.searchParams.set('reqid', requestId);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: this.config.connectTimeoutMs });
      socket.once('open', () => resolve(socket));
      socket.once('error', (error) =>
        reject(new ProviderError('provider_unavailable', 'volc-asr', 'asr websocket connect failed', error))
      );
    });
  }
}

class VolcAsrSession implements AsrStream {
  private sequence = 1;
  private ended = false;
  private aborted = false;
  private pendingFinal: PendingFinal | null = null;
  private lastPartialText = '';
  private lastFinalText = '';
  private closeHandled = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly headerJson: Buffer,
    private readonly requestId: string,
    private readonly handlers: AsrStreamHandlers,
    private readonly logger?: Logger
  ) {}

  feed(pcm: Buffer): void {
    if (this.ended || this.aborted || pcm.length === 0) return;
    this.sequence++;
    this.socket.send(encodeFrame(this.headerJson, pcm, this.sequence), { binary: true });
  }

  end(): Promise<TranscriptResult> {
    if (this.ended) {
      return Promise.resolve(this.buildResult());
    }
    this.ended = true;
    this.sequence++;
    // 末帧：负 sequence 表示最后一包
    this.socket.send(encodeFrame(this.headerJson, Buffer.alloc(0), -this.sequence), { binary: true });
    return new Promise<TranscriptResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时降级：采用最新稳定结果（规范第 23 节策略的兜底）
        this.pendingFinal = null;
        this.cleanup();
        resolve(this.buildResult());
      }, 5000);
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

  handleServerFrame(response: { code: number; message?: string; sequence?: number; result?: { text?: string; utterances?: { text?: string; definite?: boolean }[] } }): void {
    if (response.code !== VOLC_ASR_SUCCESS_CODE) {
      const error = new ProviderError(
        'asr_failed',
        'volc-asr',
        `asr error code=${response.code} ${response.message ?? ''}`
      );
      this.handlers.onError?.(error);
      this.failPending(error);
      this.cleanup();
      return;
    }
    const utterances = response.result?.utterances ?? [];
    const finalUtterance = utterances.find((u) => u.definite);
    if (finalUtterance?.text) {
      this.lastFinalText += finalUtterance.text;
    } else if (response.result?.text) {
      this.lastPartialText = response.result.text;
      this.handlers.onPartial?.(this.lastPartialText);
    }
    if (this.ended && ((response.sequence ?? 0) < 0 || finalUtterance !== undefined)) {
      this.settlePending();
    }
  }

  handleError(error: unknown): void {
    this.handlers.onError?.(error);
    this.failPending(new ProviderError('asr_failed', 'volc-asr', 'asr websocket error', error));
    this.cleanup();
  }

  handleClose(): void {
    if (this.closeHandled) return;
    this.closeHandled = true;
    this.settlePending();
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
    return { text, language: 'zh-CN', durationMs: 0 };
  }

  private cleanup(): void {
    try {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(1000, 'siren-done');
      }
    } catch {
      // socket 可能已关闭
    }
    this.logger?.debug('volc_asr_session_closed', { reqid: this.requestId });
  }
}
