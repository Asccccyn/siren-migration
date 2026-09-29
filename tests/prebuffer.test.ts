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

  it('F09：建连途中 abort——迟到的 ASR 连接被立即关闭，不再回吐 partial', async () => {
    const aborts: number[] = [];
    const received: string[] = [];
    /** createStream 延迟 resolve；底层 stream 的 abort 记录在案（模拟迟到连接） */
    const provider = new (class extends MockAsrProvider {
      override async createStream(
        options: Parameters<MockAsrProvider['createStream']>[0],
        handlers: Parameters<MockAsrProvider['createStream']>[1]
      ) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const stream = await super.createStream(options, {
          ...handlers,
          onPartial: (text) => {
            received.push(text);
            handlers.onPartial?.(text);
          }
        });
        const innerAbort = stream.abort.bind(stream);
        stream.abort = () => {
          aborts.push(1);
          innerAbort();
        };
        return stream;
      }
    })({ partials: ['迟到的 partial'], final: '不应被采用。', finalDelayMs: 5 });
    const session = new PrebufferedAsrSession(provider, {}, {}, 1024 * 1024);
    const ready = session.connect();
    session.feed(Buffer.alloc(3200, 1));
    // abort 发生在 createStream 仍在 await 的窗口内
    session.abort();
    expect(aborts.length).toBe(0); // 底层连接尚不存在
    await ready;
    // 迟到连接一就绪就被关闭（F09 修复点），且不会被采纳
    expect(aborts.length).toBe(1);
    expect(session.isReady).toBe(false);
    await expect(session.end()).rejects.toThrowError(/unavailable|abort/i);
    expect(received).toEqual([]);
  });
});
