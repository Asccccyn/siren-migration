/**
 * ASR 接入加固（1002 通话实测故障回归）：
 * - PrebufferedAsrSession.end()：建连永不落定时按失败上抛（禁止静默空转写）+ fedBytes 计数
 * - CallSession：空转写不再静默——下发 notice"没听清"并回 listening
 */
import { describe, expect, it } from 'vitest';
import { PrebufferedAsrSession } from '../packages/voice-core/src/asr-prebuffer.ts';
import { MockAsrProvider } from '@siren/provider-mock';
import { buildSessionHarness } from './helpers.ts';

describe('PrebufferedAsrSession：建连超时与喂入计数', () => {
  it('connect 永不落定时 end() 在限时内抛错（不再等宽限赛跑变空文本）', async () => {
    const neverConnect = {
      createStream: () => new Promise(() => undefined)
    } as unknown as ConstructorParameters<typeof PrebufferedAsrSession>[0];
    const session = new PrebufferedAsrSession(
      neverConnect,
      {} as ConstructorParameters<typeof PrebufferedAsrSession>[1],
      {},
      64_000,
      30 // 测试用短超时
    );
    void session.connect();
    session.feed(Buffer.alloc(3200));
    await expect(session.end()).rejects.toThrow(/not ready/);
  });

  it('fedBytes 统计含 pre-buffer 部分', async () => {
    const provider = new MockAsrProvider({ final: '你好', finalDelayMs: 5 });
    const session = new PrebufferedAsrSession(
      provider,
      {} as ConstructorParameters<typeof PrebufferedAsrSession>[1],
      {},
      64_000,
      1000
    );
    void session.connect();
    session.feed(Buffer.alloc(3200));
    session.feed(Buffer.alloc(3200));
    await session.end();
    expect(session.fedBytes).toBe(6400);
  });
});

describe('CallSession：空转写可见化', () => {
  it('ASR final 为空时下发 notice 并回 listening（不再静默丢弃）', async () => {
    const harness = buildSessionHarness({ asr: new MockAsrProvider({ final: '', finalDelayMs: 5 }) });
    try {
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      // finalDelayMs 后 adopt 完成
      await new Promise((resolve) => setTimeout(resolve, 80));
      const notices = harness.texts().filter((m) => m.t === 'notice');
      expect(notices.length).toBe(1);
      expect(notices[0]?.code).toBe('empty_transcript');
      const states = harness.texts().filter((m) => m.t === 'state');
      expect(states.at(-1)?.state).toBe('listening');
    } finally {
      harness.session.destroy('test-done');
    }
  });
});
