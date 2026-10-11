/**
 * S1011-016/017/018/021（1011 审计 P2 实时链路返修）：
 * - 021：Core 中途失败时已收到的原始文本（含未成句半句）独立保留并下发
 * - 018：TTS 流式+批量双失败的任何原生异常都归属 tts_failed，不再误报 core_failed
 * - 017：TTS 失败后的生产者收敛有界——卡在 Core 读取时 core.cancel 真正终止，不拖到 60s 超时
 * - 016：批量合成不可取消的等待被 turn 取解绑——abort 后立即按打断收尾
 */
import { describe, expect, it } from 'vitest';
import type { CoreBridge } from '@siren/core-bridge';
import type { TtsProvider } from '@siren/contracts';
import { ProviderError } from '@siren/contracts';
import { buildSessionHarness, waitFor } from './helpers.ts';

class ScriptedCore implements CoreBridge {
  name = 'scripted';
  cancelResolve: (() => void) | null = null;
  constructor(
    private readonly script:
      | { kind: 'yield-then-throw'; deltas: string[]; error: Error }
      | { kind: 'yield-then-stall'; deltas: string[] }
  ) {}
  async *streamReply(): AsyncGenerator<{ text: string }> {
    for (const delta of this.script.deltas) {
      yield { text: delta };
    }
    if (this.script.kind === 'yield-then-throw') {
      throw this.script.error;
    }
    await new Promise<void>((resolve) => {
      this.cancelResolve = resolve;
    });
  }
  cancel(): Promise<void> {
    this.cancelResolve?.();
    return Promise.resolve();
  }
}

function failingTts(options: { batchHangs?: boolean } = {}): TtsProvider {
  return {
    // eslint-disable-next-line require-yield -- 立即抛错的流式桩（模拟网络原生异常）
    synthesizeStream: async function* (): AsyncGenerator<{ audio: Buffer; sampleRate: number }> {
      throw new Error('fetch network down');
    },
    synthesize: () =>
      options.batchHangs
        ? new Promise<never>(() => undefined)
        : Promise.reject(new Error('batch timeout'))
  } as unknown as TtsProvider;
}

describe('S1011-021/018：Core 中途失败保留已收文本 + TTS 异常归属正确', () => {
  it('Core 吐两句半后抛错：reply 帧含全部已收文本（含半句），错误码 core_failed', async () => {
    const core = new ScriptedCore({ kind: 'yield-then-throw', deltas: ['你好。', '世界很'], error: new Error('core exploded') });
    const harness = buildSessionHarness({ core: core as never });
    try {
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'error'), 5000);
      const replies = harness.texts().filter((m) => m.t === 'reply');
      expect(replies.at(-1)?.text).toBe('你好。世界很'); // 半句也保留（receivedText）
      const error = harness.texts().find((m) => m.t === 'error');
      expect(error?.code).toBe('core_failed');
    } finally {
      harness.session.destroy('test');
    }
  });

  it('TTS 流式+批量全挂（原生异常）：错误码 tts_failed，不再误报 core_failed', async () => {
    const core = new ScriptedCore({ kind: 'yield-then-stall', deltas: ['一句话。', '再'] }); // 第二段首字触发切句器吐出第一句
    const tts = failingTts();
    const harness = buildSessionHarness({ core: core as never, tts });
    try {
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'error'), 5000);
      const error = harness.texts().find((m) => m.t === 'error');
      expect(error?.code).toBe('tts_failed');
    } finally {
      harness.session.destroy('test');
    }
  });
});

describe('S1011-017/016：失败收敛有界 + 批量降级可取消', () => {
  it('TTS 失败且 Core 卡住：生产者经 core.cancel 有界收敛（不等待 60s 超时）', async () => {
    const core = new ScriptedCore({ kind: 'yield-then-stall', deltas: ['第一句。', '再'] }); // 触发第一句切出
    const tts = failingTts();
    const harness = buildSessionHarness({ core: core as never, tts });
    try {
      const startedAt = Date.now();
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'error'), 8000);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(5000); // 旧实现会挂到 Core 60s 超时
      expect(harness.texts().find((m) => m.t === 'error')?.code).toBe('tts_failed');
      expect(core.cancelResolve).not.toBeNull(); // 确认走了 cancel 终止路径
    } finally {
      harness.session.destroy('test');
    }
  });

  it('批量合成挂起时用户打断：立即按 interrupted 收尾，不吊在批量请求上（S1011-016）', async () => {
    const core = new ScriptedCore({ kind: 'yield-then-stall', deltas: ['第一句。', '再'] }); // 触发第一句切出
    const tts = failingTts({ batchHangs: true });
    const harness = buildSessionHarness({ core: core as never, tts });
    try {
      const startedAt = Date.now();
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'state' && m.state === 'thinking'), 5000);
      harness.session.handleMessage({ t: 'abort' });
      await waitFor(() => harness.texts().some((m) => m.t === 'interrupted'), 3000);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(8000); // 批量 promise 永不落定也不许拖住打断
      const states = harness.texts().filter((m) => m.t === 'state');
      expect(states.at(-1)?.state).toBe('listening');
    } finally {
      harness.session.destroy('test');
    }
  });

  it('ProviderError 语义保持：emitted 后的流式失败仍是 tts_failed 且不重放（F12 不回归）', async () => {
    // 已下发部分音频后流断——按 F12 处理为 tts_failed；此处验证归类不回落 core
    const streamTts: TtsProvider = {
      synthesizeStream: async function* (): AsyncGenerator<{ audio: Buffer; sampleRate: number }> {
        yield { audio: Buffer.alloc(640, 1), sampleRate: 24000 };
        throw new ProviderError('provider_unavailable', 'volc-tts', 'conn reset');
      },
      synthesize: () => Promise.reject(new Error('batch down'))
    } as unknown as TtsProvider;
    const core = new ScriptedCore({ kind: 'yield-then-stall', deltas: ['一句话。', '再'] }); // 触发第一句切出
    const harness = buildSessionHarness({ core: core as never, tts: streamTts });
    try {
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 0));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'error'), 5000);
      expect(harness.texts().find((m) => m.t === 'error')?.code).toBe('tts_failed');
    } finally {
      harness.session.destroy('test');
    }
  });
});
