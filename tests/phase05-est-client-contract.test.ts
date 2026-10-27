// Phase 0.5 最小跨仓合同回归（F-03，2026-10-25；复审 2026-10-26 收紧）：
// **手写** est CallClient 帧序列（与 estómago tests/unit/phase05-call-client.test.ts
// 驱动真实客户端得到的帧序列一致）喂给真实 Siren CallSession——证明这些帧能被
// 真实服务端接受；est 客户端自身逻辑由其仓内测试驱动真实 CallClient 验证。
// 时序收紧：interrupt 必须发生在**第二轮** speaking（speaking 帧计数 ≥2），
// 不允许第一轮 speaking 提前满足等待。
// 服务端合同源：packages/contracts/src/websocket.ts（v2）。
import { afterEach, describe, expect, it } from 'vitest';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import type { CallTurnsRepository } from '@siren/storage';
import { CallSession, CascadeRealtimeProvider, FillerManager } from '@siren/voice-core';
import { TEST_PROFILE, silentLogger, testConfig, waitFor } from './helpers.ts';

const sessions: CallSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.destroy('test-cleanup'); });

function harness() {
  const frames: Array<Record<string, unknown>> = [];
  const audio: Buffer[] = [];
  const session = new CallSession({
    config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '100' }), logger: silentLogger,
    callId: 'phase05-contract', conversationId: 'primary', profile: TEST_PROFILE,
    voice: new CascadeRealtimeProvider({ name: 'controlled', asr: new MockAsrProvider({ final: '第一轮的话', finalDelayMs: 1 }), tts: new MockTtsProvider() }),
    core: new MockCoreBridge({ reply: '他回复。', intervalMs: 1 }),
    fillers: new FillerManager('/unused-fillers', false, silentLogger),
    turnsRepo: { insert: () => undefined } as unknown as CallTurnsRepository,
    send: (data, binary) => { if (binary) audio.push(binary); else frames.push(JSON.parse(data)); },
    bufferedAmount: () => 0, close: () => undefined
  });
  sessions.push(session);
  return { session, frames };
}

describe('est 正式客户端帧序列 × 真实 CallSession（跨仓合同）', () => {
  it('多轮 start/end 与 speaking 期 interrupt 都被真实服务端接受', async () => {
    const h = harness();
    // est CallClient connect() 上报：protocol 2 + playback_drain + voice_interrupt
    h.session.handleMessage({ t: 'ready', protocol: 2, capabilities: { playback_drain: true, voice_interrupt: true } });
    const readyReply = h.frames.find((f) => f.t === 'ready') as { capabilities?: { voice_interrupt?: boolean } } | undefined;
    expect(readyReply?.capabilities?.voice_interrupt).toBe(true); // 协商成立

    // 第一轮：开麦即 start(A)（est 客户端保话头 prebuffer 的行为）→ PCM → end
    h.session.handleMessage({ t: 'start', input_id: 'in_A' });
    expect(h.frames).toContainEqual({ t: 'input_started', input_id: 'in_A' });
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_A' });
    // 等"第一轮完成后"的 listening（ASR final→回复→drain→回 listening；start(A) 也会
    // 发一条 listening，不能作为轮完成信号）
    await waitFor(() => h.frames.some((f) => f.t === 'asr') && h.frames.filter((f) => f.t === 'state' && f.state === 'listening').length >= 2);

    // 第二轮：干净轮界 start(B)——真实服务端必须接受新输入代际（est 修复点）
    h.session.handleMessage({ t: 'start', input_id: 'in_B' });
    expect(h.frames).toContainEqual({ t: 'input_started', input_id: 'in_B' });
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_B' });
    // 复审收紧：等**第二轮** speaking（帧计数 ≥2）——第一轮 speaking 不算
    await waitFor(() => h.frames.filter((f) => f.t === 'state' && f.state === 'speaking').length >= 2);
    expect(h.session.state).toBe('speaking');

    // 他正在说（speaking）时她开口：est 客户端发 interrupt(B→C)——真实服务端换代
    h.session.handleMessage({ t: 'interrupt', target_input_id: 'in_B', new_input_id: 'in_C' });
    expect(h.frames).toContainEqual({ t: 'input_started', input_id: 'in_C' });
    expect(h.session.state).toBe('listening');
    // 新代际接收音频；静音断句 end 正常收口（第三轮完成后回 listening）
    h.session.handleBinary(Buffer.alloc(640));
    h.session.handleMessage({ t: 'end', input_id: 'in_C' });
    await waitFor(() => h.frames.filter((f) => f.t === 'state' && f.state === 'listening').length >= 4);

    // 挂断（est hangup 发 abort 后关 WS）：destroy 收口、turn 落库由既有测试覆盖
    h.session.destroy('hangup');
    expect(h.session.destroyed).toBe(true);
  });
});
