import { describe, expect, it } from 'vitest';
import { MockAsrProvider } from '@siren/provider-mock';
import { PrebufferedAsrSession } from '@siren/voice-core';

/** 延迟建连的 ASR Provider：验证 prebuffer 不丢句首（规范第 22 节） */
class DelayedAsrProvider extends MockAsrProvider {
  constructor(private readonly delayMs: number) {
    super({ partials: ['嗯'], final: '句首完整。', finalDelayMs: 5 });
  }

  override async createStream(
    options: Parameters<MockAsrProvider['createStream']>[0],
    handlers: Parameters<MockAsrProvider['createStream']>[1]
  ) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.createStream(options, handlers);
  }
}

describe('ASR Prebuffer', () => {
  it('建连期间的数据在 ready 后按原顺序补发', async () => {
    const provider = new DelayedAsrProvider(80);
    const session = new PrebufferedAsrSession(provider, {}, {}, 1024 * 1024);
    const ready = session.connect();

    const first = Buffer.alloc(3200, 1);
    const second = Buffer.alloc(1600, 2);
    const third = Buffer.alloc(3200, 3);
    session.feed(first);
    session.feed(second);
    session.feed(third);
    expect(session.isReady).toBe(false);

    await ready;
    expect(session.isReady).toBe(true);
    expect(session.bufferedBytes).toBe(0); // 已全部补发

    const result = await session.end();
    expect(result.text).toBe('句首完整。');
  });

  it('容量保护：超限时丢弃最旧数据而非崩溃', async () => {
    const provider = new DelayedAsrProvider(30);
    const session = new PrebufferedAsrSession(provider, {}, {}, 6400);
    const ready = session.connect();
    session.feed(Buffer.alloc(3200, 1));
    session.feed(Buffer.alloc(3200, 2));
    session.feed(Buffer.alloc(3200, 3)); // 超过 6400，最早一块被丢
    expect(session.bufferedBytes).toBeLessThanOrEqual(6400);
    await ready;
    const result = await session.end();
    expect(result.text).toBe('句首完整。');
  });

  it('ready 之后的数据直接透传', async () => {
    const provider = new MockAsrProvider({ final: 'ok', finalDelayMs: 5 });
    const session = new PrebufferedAsrSession(provider, {}, {}, 1024 * 1024);
    await session.ready();
    expect(session.isReady).toBe(true);
    session.feed(Buffer.alloc(3200, 9));
    const result = await session.end();
    expect(result.durationMs).toBeGreaterThan(0); // feed 的字节被统计
  });

  it('abort 丢弃缓冲并中止底层会话', async () => {
    const provider = new DelayedAsrProvider(50);
    const session = new PrebufferedAsrSession(provider, {}, {}, 1024 * 1024);
    const ready = session.connect();
    session.feed(Buffer.alloc(3200, 1));
    session.abort();
    await ready;
    expect(session.bufferedBytes).toBe(0);
  });
});
