// JV-01（联合审计 2026-10-26，P0）整改验证：原声落盘是外部 I/O——await 期间
// 挂断（destroy→ended）或新输入打断（旧轮 aborted/换轮）后，旧轮不得再推进
// 状态机。修复前：ended→thinking 非法迁移抛 InvalidTransitionError → unhandled
// rejection → 默认 Node 进程退出（同进程全部通话中断）。
// 用真实 CallSession + 可延迟的 userAudio store（只延迟外部落盘边界）：
// - 场景1 挂断：落盘挂起→destroy→释放 put→无异常、旧轮不派 Core、无 thinking 帧
// - 场景2 打断：落盘挂起→interrupt(A→B)→释放 put→旧轮不进 thinking、新轮正常继续
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TtsProvider } from '@siren/contracts';
import { MockAsrProvider } from '@siren/provider-mock';
import { type CoreBridge } from '@siren/core-bridge';
import { openDatabase, CallSessionsRepository, CallTurnsRepository, VoiceAssetsRepository } from '@siren/storage';
import { CallSession, CascadeRealtimeProvider, FillerManager } from '@siren/voice-core';
import { TEST_PROFILE, silentLogger, testConfig, waitFor } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(core: CoreBridge) {
  const db = openDatabase(':memory:');
  const assets = new VoiceAssetsRepository(db);
  new CallSessionsRepository(db).insert({ id: 'jv01', conversation_id: 'primary', voice_profile: TEST_PROFILE.id, started_at: Date.now(), ended_at: null, status: 'active', asr_provider: 'mock', tts_provider: 'mock', created_at: Date.now() });
  const frames: Array<Record<string, unknown>> = [];
  const pendingPuts: Array<() => void> = [];
  const session = new CallSession({
    config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '100' }), logger: silentLogger,
    callId: 'jv01', conversationId: 'primary', profile: TEST_PROFILE,
    voice: new CascadeRealtimeProvider({ name: 'controlled', asr: new MockAsrProvider({ final: '这轮的话', finalDelayMs: 1 }), tts: { synthesize: () => { throw new Error('unexpected batch'); }, synthesizeStream: async function* () { /* 无音频：足够 */ } } as TtsProvider }),
    core,
    fillers: new FillerManager('/unused-fillers', false, silentLogger),
    turnsRepo: new CallTurnsRepository(db),
    userAudio: {
      assetsRepo: assets,
      store: {
        put: async () => { await new Promise<void>((r) => { pendingPuts.push(r); }); }
      } as never
    },
    send: (data: string) => { frames.push(JSON.parse(data)); },
    bufferedAmount: () => 0, close: () => undefined
  });
  cleanups.push(async () => { session.destroy('test-cleanup'); pendingPuts.splice(0).forEach(release => release()); await session.settled(); db.close(); });
  const waitForPutStarted = (): Promise<void> => waitFor(() => pendingPuts.length > 0).then(() => undefined);
  const releaseOnePut = (): void => { pendingPuts.shift()?.(); };
  return { session, frames, assets, waitForPutStarted, releaseOnePut };
}

describe('JV-01 原声落盘期间取消：旧轮不推进、进程不退出', () => {
  it('场景1 挂断：落盘 await 中 destroy → 释放后旧轮不进 thinking、不派 Core', async () => {
    const streamCalls = vi.fn();
    const core: CoreBridge = {
      async *streamReply(input) { streamCalls(input); yield { text: '回复。' }; },
      cancel: async () => undefined
    };
    const h = harness(core);
    h.session.handleMessage({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } });
    h.session.handleMessage({ t: 'start', input_id: 'in_a' });
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_a' });
    // 等 runReplyPhase 真正进入原声落盘 await（put 已挂起）
    await h.waitForPutStarted();
    h.session.destroy('hangup'); // 挂断：abortTurn + forceEnded
    h.releaseOnePut(); // 落盘此刻才返回——旧轮不得再 transition('thinking')
    await h.session.settled();
    expect(h.session.destroyed).toBe(true);
    expect(h.frames.filter((f) => f.t === 'state' && f.state === 'thinking')).toHaveLength(0);
    expect(streamCalls).toHaveBeenCalledTimes(0); // 旧轮不派模型
    // 无未处理 rejection：若有，vitest 进程已失败（修复前此路径必抛 InvalidTransitionError）
  });

  it('场景2 打断：落盘 await 中 interrupt(A→B) → 旧轮不进 thinking、新轮正常继续', async () => {
    const streamCalls = vi.fn();
    const core: CoreBridge = {
      async *streamReply(input) { streamCalls(input); yield { text: '回复。' }; },
      cancel: async () => undefined
    };
    const h = harness(core);
    h.session.handleMessage({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } });
    h.session.handleMessage({ t: 'start', input_id: 'in_a' });
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_a' });
    await h.waitForPutStarted(); // 旧轮 A 已在落盘 await 中
    // 她再次开口：interrupt 换代（旧轮 aborted、回 listening、新轮 B 建立）
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'in_a', new_input_id: 'in_b' });
    await waitFor(() => h.frames.some((f) => f.t === 'input_started' && f.input_id === 'in_b'));
    h.releaseOnePut(); // 旧轮落盘此刻返回——不得把 listening 推成 thinking
    await h.session.settled();
    expect(h.frames.filter((f) => f.t === 'state' && f.state === 'thinking')).toHaveLength(0);
    expect(h.session.state).toBe('listening');
    // 新轮正常继续：说话→end→新轮自己的落盘→释放→派 Core
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_b' });
    await h.waitForPutStarted();
    h.releaseOnePut();
    await waitFor(() => streamCalls.mock.calls.length >= 1);
    await h.session.settled();
    expect(streamCalls).toHaveBeenCalledTimes(1);
    expect(streamCalls.mock.calls[0]![0].turnId).toBe(h.assets.findByMessageId('call-jv01-t2-u')!.turnId);
    expect(streamCalls.mock.calls[0]![0].turnId).not.toBe(h.assets.findByMessageId('call-jv01-t1-u')!.turnId);
  });
});
