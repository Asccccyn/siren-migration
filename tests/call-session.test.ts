import { describe, expect, it } from 'vitest';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import { buildSessionHarness, waitFor } from './helpers.ts';

describe('CallSession（协议 / 打断 / 降级）', () => {
  it('完整一轮：start -> partial -> asr -> thinking -> speaking -> pcm -> pcm_end -> listening', async () => {
    const harness = buildSessionHarness({});
    const { session } = harness;

    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1)); // 100ms 语音
    session.handleMessage({ t: 'end' });

    await waitFor(() => harness.texts().some((m) => m.t === 'state' && m.state === 'listening' && harness.texts().some((x) => x.t === 'pcm_end')));

    const texts = harness.texts();
    const types = texts.map((m) => m.t);
    expect(types).toContain('partial');
    expect(texts.find((m) => m.t === 'asr')).toMatchObject({ text: '你好。' });
    expect(texts.filter((m) => m.t === 'state').map((m) => m.state)).toEqual(
      expect.arrayContaining(['listening', 'ending', 'thinking', 'speaking', 'listening'])
    );
    const pcmStart = texts.find((m) => m.t === 'pcm');
    expect(pcmStart).toMatchObject({ rate: 24000 });
    expect(types).toContain('pcm_end');
    const reply = texts.find((m) => m.t === 'reply');
    expect(String(reply?.text)).toContain('今天天气不错');
    expect(texts.find((m) => m.t === 'metrics')).toBeTruthy();
    // 真正下发了二进制 PCM
    expect(harness.binaries().length).toBeGreaterThan(5);
    expect(session.state).toBe('listening');
  });

  it('空输入（无有效语音）直接回 listening，不进 Core', async () => {
    const core = new MockCoreBridge({ reply: '不应被调用。', intervalMs: 1, charsPerDelta: 2 });
    const harness = buildSessionHarness({
      asr: new MockAsrProvider({ partials: [], final: '', finalDelayMs: 5 }),
      core
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleMessage({ t: 'end' });
    await waitFor(
      () => harness.texts().filter((m) => m.t === 'state' && m.state === 'listening').length >= 2
    );
    expect(harness.session.state).toBe('listening');
    expect(harness.texts().some((m) => m.t === 'asr')).toBe(false);
    expect(harness.texts().some((m) => m.t === 'pcm')).toBe(false);
  });

  it('Barge-in：speaking 期间 abort -> interrupted + 回 listening，音频停止增长', async () => {
    const longReply = '第一句话说完。第二句话也说完了。第三句话继续。第四句还有。第五句未完待续。';
    const harness = buildSessionHarness({
      core: new MockCoreBridge({ reply: longReply, intervalMs: 5, charsPerDelta: 3 })
    });
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });

    // 等到开始说话
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm'));
    await new Promise((resolve) => setTimeout(resolve, 30)); // 让部分帧发出
    const bytesAtAbort = harness.binaryBytes();
    expect(bytesAtAbort).toBeGreaterThan(0);

    session.handleMessage({ t: 'abort' });
    await waitFor(() => harness.texts().some((m) => m.t === 'interrupted'));
    expect(session.state).toBe('listening');
    expect(harness.texts().some((m) => m.t === 'reply')).toBe(true); // 保留已播出文本

    // 之后不再有新的音频帧
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.binaryBytes()).toBe(bytesAtAbort);
  });

  it('ASR 失败：明确 error 帧，不进入 Core，回 listening', async () => {
    const core = new MockCoreBridge({ reply: '不应被调用。', intervalMs: 1, charsPerDelta: 2 });
    const harness = buildSessionHarness({
      asr: new MockAsrProvider({ partials: [], final: '', finalDelayMs: 5, failEnd: true }),
      core
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'error'));
    const errorFrame = harness.texts().find((m) => m.t === 'error');
    expect(errorFrame).toMatchObject({ code: 'asr_failed' });
    expect(harness.texts().some((m) => m.t === 'pcm')).toBe(false);
    await waitFor(() => harness.session.state === 'listening');
  });

  it('Streaming TTS 失败 -> Batch TTS 兜底（音频仍然下发）', async () => {
    const tts = new MockTtsProvider();
    tts.faults = { failStream: true };
    const harness = buildSessionHarness({ tts });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
    expect(tts.calls.batchCount).toBeGreaterThanOrEqual(1); // 走了批量兜底
    expect(harness.binaries().length).toBeGreaterThan(0);
    expect(harness.texts().some((m) => m.t === 'reply')).toBe(true);
  });

  it('TTS 全失败：文字仍保留（reply 帧），不发未知音频', async () => {
    const tts = new MockTtsProvider();
    tts.faults = { failStream: true, failBatch: true };
    const harness = buildSessionHarness({ tts });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'reply'));
    expect(harness.texts().some((m) => m.t === 'error' && m.code === 'tts_failed')).toBe(true);
    await waitFor(() => harness.session.state === 'listening');
  });

  it('destroy 后：状态 ended 且不再输出任何帧', async () => {
    const harness = buildSessionHarness({});
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.destroy('test');
    const frames = harness.frames.length;
    harness.session.handleMessage({ t: 'ping' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    expect(harness.session.state).toBe('ended');
    expect(harness.frames.length).toBe(frames);
  });

  it('非法状态操作返回 error 帧', async () => {
    const harness = buildSessionHarness({});
    harness.session.handleMessage({ t: 'end' }); // idle 状态直接 end
    const errorFrame = harness.texts().find((m) => m.t === 'error');
    expect(errorFrame).toMatchObject({ code: 'invalid_state' });
  });
});
