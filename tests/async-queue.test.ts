/**
 * AsyncQueue 背压语义（v1.1.1 审计回归）：
 * 审计给出的最小复现——size=2 时生产者 waitForDrain(1)，消费者 shift 一项后
 * size 已降到 1，但旧实现只在 push/close/fail 时 notifyDrain 且仅当
 * items.length === 0 才唤醒 -> 生产者永久睡眠 -> 死锁。
 */
import { describe, expect, it } from 'vitest';
import { AsyncQueue, EagerIterable } from '@siren/voice-core';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  return Promise.race([
    promise,
    new Promise<'TIMEOUT'>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), ms);
      timer.unref?.();
    })
  ]);
}

describe('AsyncQueue drain 唤醒（v1.1.1 审计修复）', () => {
  it('审计最小复现：shift 使 size 降到阈值后，waitForDrain(1) 必须被唤醒', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    expect(queue.size).toBe(2);

    const drain = queue.waitForDrain(1); // 旧实现在此 park，永远不醒
    const iterator = queue[Symbol.asyncIterator]();
    const first = await iterator.next(); // 消费一项 -> size 1
    expect(first.value).toBe(1);

    const result = await withTimeout(drain, 500);
    expect(result).not.toBe('TIMEOUT'); // 旧实现这里就是 TIMEOUT（死锁）
  });

  it('threshold=2 的 waiter 恰在 size 降到 2 时唤醒', async () => {
    const queue = new AsyncQueue<number>();
    for (let i = 1; i <= 4; i++) queue.push(i);
    const drainAtTwo = queue.waitForDrain(2);
    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next(); // size 3：不醒
    expect(await withTimeout(Promise.race([drainAtTwo.then(() => 'WAKE'), new Promise<'SLEEP'>((r) => setTimeout(() => r('SLEEP'), 100))]), 300)).toBe('SLEEP');
    await iterator.next(); // size 2：醒
    expect(await withTimeout(drainAtTwo, 500)).not.toBe('TIMEOUT');
  });

  it('close/fail 唤醒全部 drain waiter（不悬挂生产者）', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    const a = queue.waitForDrain(1);
    const b = queue.waitForDrain(0);
    queue.close();
    expect(await withTimeout(a, 200)).not.toBe('TIMEOUT');
    expect(await withTimeout(b, 200)).not.toBe('TIMEOUT');

    const failed = new AsyncQueue<number>();
    failed.push(1);
    failed.push(2);
    const c = failed.waitForDrain(1);
    failed.fail(new Error('boom'));
    expect(await withTimeout(c, 200)).not.toBe('TIMEOUT');
  });

  it('EagerIterable.start() 立即拉取（不依赖消费者迭代）', async () => {
    const produced: number[] = [];
    const eager = new EagerIterable<number>(
      () =>
        (async function* () {
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 5));
            produced.push(i);
            yield i;
          }
        })()
    );
    eager.start();
    // 轮询等待全部产出（无人消费也已缓冲；Windows 定时器精度问题不用固定 sleep）
    const deadline = Date.now() + 2000;
    while (produced.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(produced).toEqual([0, 1, 2]);
    const collected: number[] = [];
    for await (const item of eager) collected.push(item);
    expect(collected).toEqual([0, 1, 2]);
  });
});
