/**
 * ASR 建连 prebuffer（规范第 22 节）。
 * 每次讲话创建新 ASR Session；建连期间 PCM 进入 prebuffer，
 * ready 后先补发再实时转发，防止丢句首。
 */
import type { AsrStream, AsrStreamHandlers, StreamAsrOptions, StreamAsrProvider } from '@siren/contracts';

export class PrebufferedAsrSession implements AsrStream {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private session: AsrStream | null = null;
  private sessionError: unknown = null;
  private readyWaiters: (() => void)[] = [];
  private aborted = false;
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly provider: StreamAsrProvider,
    private readonly options: StreamAsrOptions,
    private readonly handlers: AsrStreamHandlers,
    private readonly maxBufferBytes: number
  ) {}

  /** 触发建连（幂等） */
  connect(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      try {
        this.session = await this.provider.createStream(this.options, {
          onPartial: (text) => this.handlers.onPartial?.(text),
          onError: (error) => {
            this.sessionError = this.sessionError ?? error;
            this.handlers.onError?.(error);
          }
        });
      } catch (error) {
        this.sessionError = error;
        this.handlers.onError?.(error);
      }
      this.flushPrebuffer();
      for (const waiter of this.readyWaiters.splice(0)) waiter();
    })();
    return this.readyPromise;
  }

  get isReady(): boolean {
    return this.session !== null;
  }

  /** 已缓冲且尚未发送的字节数（测试用） */
  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  feed(pcm: Buffer): void {
    if (this.aborted) return;
    if (this.session) {
      this.session.feed(pcm);
      return;
    }
    if (this.sessionError) return; // 建连失败：丢弃，等待 end() 报错
    // 容量保护：超限时丢最旧的数据（保留最新语音）
    while (this.pendingBytes + pcm.length > this.maxBufferBytes && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped ? dropped.length : 0;
    }
    if (this.pendingBytes + pcm.length <= this.maxBufferBytes) {
      this.pending.push(pcm);
      this.pendingBytes += pcm.length;
    }
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  /** 建连完成后补发缓冲的 PCM（保证句首不丢） */
  private flushPrebuffer(): void {
    const session = this.session;
    if (!session) return;
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const chunk of pending) {
      session.feed(chunk);
    }
  }

  async end(): Promise<{ text: string; language: string; durationMs: number }> {
    await this.ready();
    if (this.sessionError) {
      throw this.sessionError;
    }
    if (!this.session) {
      throw new Error('asr session unavailable');
    }
    return this.session.end();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.session?.abort();
    } catch {
      // 已关闭
    }
  }
}
