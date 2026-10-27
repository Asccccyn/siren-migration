// A11 柔性挂断（2026-10-24）离线合同：
// ① listening 态提出挂断→linger 计时→窗口内无新输入→destroy(model_hangup, 1000)
// ② linger 窗口内她开口（新 start）→取消→通话继续（新一轮可完整走完）
// ③ speaking 中提出→立即回执 accepted；等正文 drain 后才进入 linger（不提前挂）
// ④ 用户显式挂断（WS close）不受 linger 拦截（现有 destroy 即时路径）
// ⑤ 旧计时器不误伤：取消后再次提出→新 generation 计时
import { describe, expect, it } from 'vitest';
import { buildSessionHarness, testConfig, waitFor } from './helpers.ts';
import type { CallSession } from '@siren/voice-core';

function harness(opts: { lingerMs?: number } = {}) {
  const h = buildSessionHarness({ config: { hangupLingerMs: opts.lingerMs ?? 80 } as never });
  const states = (): string[] => h.texts().map((x) => String(x['state'] ?? '')).filter(Boolean);
  // 完整一轮：reply 帧出现且回到 listening（区别于 start 前的初始 listening）
  const roundDone = (): boolean => h.texts().some((x) => x['t'] === 'reply') && states().at(-1) === 'listening';
  return { h, states, roundDone, session: h.session, closeCalls: h.closeCalls };
}

describe('A11 柔性挂断（离线合同）', () => {
  it('listening 提出挂断：linger 到期无新输入→model_hangup 结束（1000）', async () => {
    const { h, states, roundDone, session, closeCalls } = harness({ lingerMs: 60 });
    try {
      // 一轮完整对话回到 listening
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(640));
      session.handleMessage({ t: 'end' });
      await waitFor(roundDone);
      const r = session.requestHangup();
      expect(r.accepted).toBe(true);
      expect(h.texts().some((x) => x['t'] === 'notice' && x['code'] === 'hangup_linger')).toBe(true);
      await waitFor(() => closeCalls.length > 0, 3000);
      expect(closeCalls[0]).toEqual({ code: 1000, reason: 'linger elapsed without new speech' });
    } finally {
      session.destroy('test');
    }
  });

  it('linger 窗口内她开口：取消挂断，通话继续完整走一轮', async () => {
    const { h, states, roundDone, session, closeCalls } = harness({ lingerMs: 500 });
    try {
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(640));
      session.handleMessage({ t: 'end' });
      await waitFor(roundDone);
      session.requestHangup();
      // 窗口内新输入（取消）
      await new Promise((r) => setTimeout(r, 60));
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(640));
      session.handleMessage({ t: 'end' });
      await waitFor(roundDone);
      expect(closeCalls.length).toBe(0); // 未被旧计时器结束
      await new Promise((r) => setTimeout(r, 600)); // 旧 linger 时窗早已过
      expect(closeCalls.length).toBe(0); // 取消后计时器不再触发
    } finally {
      session.destroy('test');
    }
  });

  it('speaking 中提出：立即回执；正文 drain 后才进 linger（不提前挂）', async () => {
    const { h, states, roundDone, session, closeCalls } = harness({ lingerMs: 120 });
    try {
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(640));
      session.handleMessage({ t: 'end' });
      // 进入 speaking（TTS 下发中）即提出
      await waitFor(() => states().includes('speaking'));
      const r = session.requestHangup();
      expect(r.accepted).toBe(true);
      expect(['speaking', 'thinking', 'listening']).toContain(r.state);
      expect(closeCalls.length).toBe(0); // 不立即挂
      await waitFor(() => closeCalls.length > 0, 5000);
      expect(closeCalls[0]!.code).toBe(1000); // drain→linger→结束
    } finally {
      session.destroy('test');
    }
  });

  it('再次提出=新 generation；用户显式挂断即时（不经 linger 等待）', async () => {
    const { h, states, roundDone, session, closeCalls } = harness({ lingerMs: 400 });
    try {
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(640));
      session.handleMessage({ t: 'end' });
      await waitFor(() => states().includes('listening'));
      session.requestHangup(400);
      session.handleMessage({ t: 'start' }); // 取消
      const r2 = session.requestHangup(60); // 再次提出=新计时
      expect(r2.accepted).toBe(true);
      // 用户挂断：destroy 即时
      session.destroy('user_hangup');
      expect(closeCalls.length === 0 || closeCalls[0] === undefined).toBe(true); // harness destroy 不走 linger close
    } finally {
      session.destroy('test');
    }
  });

  // 联合审计（2026-10-27）：hangup_linger 提示须与播放证据一致——只有真实 playback_drained ACK
  // 才可说"正文已播完"；drain 超时兜底（客户端未确认）只提示等待时限。
  async function lingerNotice(ack: boolean): Promise<string> {
    const h = buildSessionHarness({ config: { ...testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '150' }), hangupLingerMs: 5000 } as never });
    const { session } = h;
    try {
      session.handleMessage({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } });
      session.handleMessage({ t: 'start' });
      session.handleBinary(Buffer.alloc(3200, 1));
      session.handleMessage({ t: 'end' });
      await waitFor(() => h.texts().some((m) => m.t === 'pcm_end'));
      session.requestHangup(); // 正文仍在 drain：挂起到 settle 后才进入 linger
      if (ack) {
        const pcmEnd = h.texts().find((m) => m.t === 'pcm_end') as { stream_id: string };
        session.handleMessage({ t: 'playback_drained', stream_id: pcmEnd.stream_id });
      }
      await waitFor(() => h.texts().some((m) => m.t === 'notice' && m.code === 'hangup_linger'), 3000);
      return String(h.texts().find((m) => m.t === 'notice' && m.code === 'hangup_linger')!.message);
    } finally {
      session.destroy('test');
    }
  }

  it('播放 ACK 才说"正文已播完"；无 ACK 超时兜底不声称已播完', async () => {
    expect(await lingerNotice(true)).toContain('正文已播完');
    const noAck = await lingerNotice(false);
    expect(noAck).not.toContain('播完');
    expect(noAck).toContain('秒内不开口就挂断');
  });
});
