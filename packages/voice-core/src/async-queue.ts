/**
 * 轻量异步队列 + 预取迭代器：实时链路的句子级流水线原语。
 */

/** 多生产者-单消费者异步队列 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private drainWaiters: { threshold: number; resolve: () => void }[] = [];
  private closed = false;
  private failure: unknown = null;
  private hasFailure = false;

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
    this.notifyDrain();
  }

  fail(error: unknown): void {
    if (this.closed || this.hasFailure) return;
    this.hasFailure = true;
    this.failure = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(Promise.reject(error) as unknown as IteratorResult<T>);
    }
    this.notifyDrain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
    this.notifyDrain();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          const value = this.items.shift() as T;
          // 审计修复（P0）：消费使队列变短，必须唤醒等待 drain 的生产者，
          // 否则 size>=2 时生产者 waitForDrain(1) 永远不会被叫醒 -> 死锁
          this.notifyDrain();
          return Promise.resolve({ value, done: false });
        }
        if (this.hasFailure) {
          return Promise.reject(this.failure);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }

  /** 等待队列长度低于阈值（生产者背压） */
  waitForDrain(threshold = 1): Promise<void> {
    if (this.items.length <= threshold || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push({ threshold, resolve });
    });
  }

  /** 按 waiter 各自等待的 threshold 唤醒（而非仅队列清空时） */
  private notifyDrain(): void {
    if (this.drainWaiters.length === 0) return;
    if (this.closed) {
      for (const waiter of this.drainWaiters.splice(0)) waiter.resolve();
      return;
    }
    const remaining: { threshold: number; resolve: () => void }[] = [];
    for (const waiter of this.drainWaiters.splice(0)) {
      if (this.items.length <= waiter.threshold) waiter.resolve();
      else remaining.push(waiter);
    }
    this.drainWaiters.push(...remaining);
  }
}

/**
 * 立即开始消费底层异步迭代器并缓冲结果的包装。
 * 用于“下一句 TTS 在上一句播放期间预热”。
 */
export class EagerIterable<T> implements AsyncIterable<T> {
  private readonly queue = new AsyncQueue<T>();
  private started = false;

  constructor(private readonly factory: () => AsyncIterable<T>) {}

  /** 幂等启动（首次调用后开始拉取） */
  start(): void {
    if (this.started) return;
    this.started = true;
    void (async () => {
      try {
        for await (const item of this.factory()) {
          this.queue.push(item);
        }
        this.queue.close();
      } catch (error) {
        this.queue.fail(error);
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    this.start();
    return this.queue[Symbol.asyncIterator]();
  }
}
