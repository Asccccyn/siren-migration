import { describe, expect, it } from 'vitest';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import type { PcmChunk, TtsProvider, TtsRequest, TtsAudioResult } from '@siren/contracts';
import { openDatabase, CallSessionsRepository, CallTurnsRepository } from '@siren/storage';
import { buildSessionHarness, testConfig, waitFor } from './helpers.ts';

/** 输出固定采样率 PCM 的假 TTS（验证 P0-7 采样率全链路保留） */
function fixedRateTts(rate: number): TtsProvider {
  const inner = new MockTtsProvider();
  const wrap = (chunks: AsyncGenerator<PcmChunk>): AsyncGenerator<PcmChunk> =>
    (async function* () {
      for await (const chunk of chunks) {
        yield { audio: chunk.audio, sampleRate: rate };
      }
    })();
  return {
    synthesize: (request: TtsRequest) =>
      inner.synthesize(request).then(
        (result: TtsAudioResult): TtsAudioResult => ({ ...result, sampleRate: rate })
      ),
    synthesizeStream: (request: TtsRequest, _signal?: AbortSignal) => wrap(inner.synthesizeStream(request))
  };
}

/** 慢速 TTS：流式产出每块间隔固定耗时，并记录每句合成开始/最后一块时间（审计回归：真实预取） */
class TrackingSlowTts implements TtsProvider {
  readonly calls: { text: string; startedAt: number; lastChunkAt: number }[] = [];
  private readonly inner = new MockTtsProvider();

  synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    return this.inner.synthesize(request);
  }

  async *synthesizeStream(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
    const entry = { text: request.text, startedAt: Date.now(), lastChunkAt: 0 };
    this.calls.push(entry);
    const chunks: PcmChunk[] = [];
    for await (const chunk of this.inner.synthesizeStream(request)) chunks.push(chunk);
    for (const chunk of chunks) {
      if (signal?.aborted) throw new Error('tts aborted');
      await sleep(8); // 模拟 provider 流式产出的真实耗时
      entry.lastChunkAt = Date.now();
      yield chunk;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  it('F07：6 句回复 + TTS 全失败——生产者/消费者不死锁，错误收尾回 listening', async () => {
    const tts = new MockTtsProvider();
    tts.faults = { failStream: true, failBatch: true };
    // 6 句让 sentenceQueue 达到深度 2 的背压窗口（死锁触发条件）
    const harness = buildSessionHarness({
      tts,
      core: new MockCoreBridge({
        reply: '一句。二句。三句。四句。五句。六句。七句。八句。',
        intervalMs: 1,
        charsPerDelta: 1
      })
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    // waitFor 带 5s 超时：若互等（F07 旧缺陷）这里直接超时失败
    await waitFor(() => harness.texts().some((m) => m.t === 'error' && m.code === 'tts_failed'));
    await waitFor(() => harness.texts().some((m) => m.t === 'reply'));
    await waitFor(() => harness.session.state === 'listening');
    // 文字不丢：完整回复文本已下发
    const reply = harness.texts().find((m) => m.t === 'reply') as { text?: string };
    expect((reply?.text ?? '').length).toBeGreaterThan(0);
  });

  it('F12：流式已下发部分音频后再失败——不整句降级重播，按 tts_failed 收尾', async () => {
    const tts = new MockTtsProvider();
    tts.faults = { failStream: true, failStreamAfterChunks: 1, failBatch: false }; // batch 可用
    const harness = buildSessionHarness({
      tts,
      core: new MockCoreBridge({ reply: '只有一句话。', intervalMs: 1, charsPerDelta: 2 })
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'error' && m.code === 'tts_failed'));
    await waitFor(() => harness.session.state === 'listening');
    // 只允许出现已播出的 1 个 pcm 头；旧行为会 batch 重合成整句（几十帧）重播句首
    const pcmCount = harness.texts().filter((m) => m.t === 'pcm').length;
    expect(pcmCount).toBe(1);
    // batch 未被调用（部分输出后不再降级）
    expect(tts.calls.batchCount).toBe(0);
  });

  it('F08：grace 采纳等待期间到达的最新 partial（不是 end 时刻的快照）', async () => {
    const harness = buildSessionHarness({
      asr: new MockAsrProvider({ partials: ['你', '你好世界'], final: '迟到的 final。', finalDelayMs: 200 }),
      config: testConfig({ PARTIAL_GRACE_MS: '30' })
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1)); // 触发第 1 个 partial
    harness.session.handleMessage({ t: 'end' }); // 剩余 partial 在 end() 内到达，落在 grace 窗口中
    await waitFor(() => harness.texts().some((m) => m.t === 'asr'));
    const asr = harness.texts().find((m) => m.t === 'asr') as { text?: string };
    expect(asr?.text).toBe('你好世界'); // 旧实现的调用点快照只有 '你'
    await waitFor(() => harness.session.state === 'listening');
  });

  it('F10：speaking 中途 destroy——当前轮幂等落库（interrupted），不随连接丢失', async () => {
    const db = openDatabase(':memory:');
    const turnsRepo = new CallTurnsRepository(db);
    const sessionsRepo = new CallSessionsRepository(db);
    sessionsRepo.insert({
      id: 'call-test-1',
      conversation_id: 'conv-f10',
      voice_profile: 'main',
      started_at: Date.now(),
      ended_at: null,
      status: 'active',
      asr_provider: 'mock',
      tts_provider: 'mock',
      created_at: Date.now()
    });
    // 慢速 Core：destroy 时回复仍在产出（快速 mock 会在轮询间隔内整轮完成）
    const harness = buildSessionHarness({
      turnsRepo,
      sessionsRepo,
      core: new MockCoreBridge({ reply: '第一句话说完。第二句继续说。第三句继续说。', intervalMs: 40, charsPerDelta: 2 })
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm'));
    expect(turnsRepo.listByCall('call-test-1').length).toBe(0); // 轮次进行中未落库
    harness.session.destroy('client_closed');
    const turns = turnsRepo.listByCall('call-test-1');
    expect(turns.length).toBe(1); // F10：销毁不丢当前轮
    expect(turns[0].interrupted).toBe(1);
    expect(String(turns[0].user_text ?? '').length).toBeGreaterThan(0);
    db.close();
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

  it('P0-2：正常说完一句回复 speaking -> listening，不经过 interrupting', async () => {
    const harness = buildSessionHarness({});
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() =>
      harness.texts().some((m) => m.t === 'state' && m.state === 'listening' && harness.texts().some((x) => x.t === 'pcm_end'))
    );
    const states = harness.texts().filter((m) => m.t === 'state').map((m) => m.state);
    expect(states).not.toContain('interrupting');
    expect(states[states.length - 1]).toBe('listening');
  });

  it('P0-6：backpressure 超限触发完整 teardown（无 zombie session）', async () => {
    const destroyed: string[] = [];
    let overflow = false;
    const harness = buildSessionHarness({
      // 审计修复（同步竞争）：慢速 Core 让音频跨越数百 ms 的窗口，
      // overflow 置位后必有后续帧触发背压，不再依赖两簇音频间的采样运气
      core: new MockCoreBridge({
        reply: '第一句话说完。第二句继续说。第三句继续说。第四句继续说。',
        intervalMs: 40,
        charsPerDelta: 2
      }),
      bufferedAmount: () => (overflow ? 999_999_999 : 0),
      onDestroyed: (session) => destroyed.push(session.callId)
    });
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm'));

    // 模拟 socket 缓冲超阈值，再发一帧触发背压保护
    overflow = true;
    const bytesAtOverflow = harness.binaryBytes();
    session.handleMessage({ t: 'ping' }); // 确认会话仍活着
    await waitFor(() => destroyed.includes('call-test-1'));

    expect(session.destroyed).toBe(true);
    expect(session.state).toBe('ended');
    expect(harness.closeCalls.some((c) => c.code === 4005)).toBe(true);
    // 背压后不再下发任何帧
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.binaryBytes()).toBe(bytesAtOverflow);
    expect(harness.texts().filter((m) => m.t === 'metrics').length).toBe(0);
  });

  it('P0-2：连续 abort 两次幂等，状态稳定回 listening', async () => {
    const harness = buildSessionHarness({
      core: new MockCoreBridge({ reply: '第一句话说完。第二句话也说完了。第三句继续。第四句未完。', intervalMs: 5, charsPerDelta: 3 })
    });
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm'));

    session.handleMessage({ t: 'abort' });
    session.handleMessage({ t: 'abort' }); // 第二次应幂等
    await waitFor(() => harness.texts().filter((m) => m.t === 'interrupted').length >= 1);
    await waitFor(() => session.state === 'listening');
    const interruptedCount = harness.texts().filter((m) => m.t === 'interrupted').length;
    expect(interruptedCount).toBe(1);
  });

  it('P0-7：provider 输出 16k / 48k 时，pcm 头 rate 与二进制帧一致', async () => {
    for (const rate of [16000, 24000, 48000]) {
      const harness = buildSessionHarness({ tts: fixedRateTts(rate) });
      harness.session.handleMessage({ t: 'start' });
      harness.session.handleBinary(Buffer.alloc(3200, 1));
      harness.session.handleMessage({ t: 'end' });
      await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
      const pcmHeaders = harness.texts().filter((m) => m.t === 'pcm');
      expect(pcmHeaders.length).toBeGreaterThan(0);
      for (const header of pcmHeaders) {
        expect(header.rate).toBe(rate);
      }
    }
  });

  it('审计回归：drain 控制 speaking→listening——pcm_end 后保持 speaking，playback_drained 后才回 listening', async () => {
    const harness = buildSessionHarness({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '5000' })
    });
    const { session } = harness;
    // 协议 v2 客户端声明 playback_drain 能力
    session.handleMessage({
      t: 'ready',
      protocol: 2,
      capabilities: { playback_drain: true, stream_identity: true, local_barge_in: true }
    });
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });

    // 服务端 PCM 发完，但状态必须仍是 speaking（客户端还在播尾音）；
    // v1.1.1 起 completed 落库与 metrics 延后到 drain 之后：此刻不应有 metrics
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
    expect(harness.texts().filter((m) => m.t === 'metrics').length).toBe(0);
    const states = harness.texts().filter((m) => m.t === 'state').map((m) => m.state);
    expect(states[states.length - 1]).toBe('speaking');
    expect(session.state).toBe('speaking');

    // 客户端播完 ACK -> metrics(completed) -> listening
    const pcmEnd = harness.texts().find((m) => m.t === 'pcm_end') as { stream_id: string };
    session.handleMessage({ t: 'playback_drained', stream_id: pcmEnd.stream_id });
    await waitFor(() => session.state === 'listening');
    const metricsFrames = harness.texts().filter((m) => m.t === 'metrics');
    expect(metricsFrames.length).toBe(1); // 只有一份 completed metrics
    expect((metricsFrames[0].metrics as { interrupted: boolean }).interrupted).toBe(false);
    // 不产生 interrupting（正常完成路径）
    expect(harness.texts().filter((m) => m.t === 'state').map((m) => m.state)).not.toContain('interrupting');
  });

  it('审计回归：drain 超时兜底回 listening（客户端未 ACK 不悬挂）', async () => {
    const harness = buildSessionHarness({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '120' })
    });
    const { session } = harness;
    session.handleMessage({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } });
    session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
    // pcm_end 后仍 speaking；超时后自动回 listening
    expect(session.state).toBe('speaking');
    await waitFor(() => session.state === 'listening');
  });

  it('审计回归：drain 等待期间 abort -> 立即 interrupted + listening（不等超时）', async () => {
    const harness = buildSessionHarness({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '5000' }),
      core: new MockCoreBridge({ reply: '第一句话说完。第二句话也说完了。第三句继续。', intervalMs: 5, charsPerDelta: 3 })
    });
    const { session } = harness;
    session.handleMessage({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } });
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
    expect(session.state).toBe('speaking');

    // 尾音期间用户抢话：必须立即打断，而不是等 drain 超时
    const abortAt = Date.now();
    session.handleMessage({ t: 'abort' });
    await waitFor(() => harness.texts().some((m) => m.t === 'interrupted'));
    expect(session.state).toBe('listening');
    expect(Date.now() - abortAt).toBeLessThan(1000);
  });

  it('审计回归：下一句 TTS 在上一句播放期间已开始（真实预取，非惰性）', async () => {
    const tts = new TrackingSlowTts();
    const harness = buildSessionHarness({
      tts,
      core: new MockCoreBridge({ reply: '第一句话说完。第二句话也说完了。', intervalMs: 1, charsPerDelta: 3 })
    });
    harness.session.handleMessage({ t: 'start' });
    harness.session.handleBinary(Buffer.alloc(3200, 1));
    harness.session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));

    // 两句都被合成过
    expect(tts.calls.length).toBe(2);
    // 关键断言：句 2 的合成开始时间早于句 1 的最后一块产出时间
    // （若仍是惰性迭代，句 2 只会在句 1 全部消费完之后才开始）
    expect(tts.calls[1].startedAt).toBeLessThan(tts.calls[0].lastChunkAt);
  });

  it('审计回归：未声明 playback_drain 能力的客户端（旧协议）pcm_end 后立即回 listening', async () => {
    const harness = buildSessionHarness({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '5000' })
    });
    const { session } = harness;
    session.handleMessage({ t: 'ready' }); // 无 capabilities
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() =>
      harness.texts().some((m) => m.t === 'state' && m.state === 'listening' && harness.texts().some((x) => x.t === 'pcm_end'))
    );
    expect(session.state).toBe('listening');
  });

  it('v1.1.1 审计回归：6 句长回复不死锁（生产者 waitForDrain 被消费唤醒），完整收到 pcm_end', async () => {
    const harness = buildSessionHarness({
      core: new MockCoreBridge({
        reply: '第一句话。第二句话。第三句话。第四句话。第五句话。第六句话。',
        intervalMs: 1,
        charsPerDelta: 3
      })
    });
    const { session } = harness;
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    // 旧实现：队列 size 达 2 后生产者 park 在 waitForDrain(1)，消费者消费不唤醒
    // -> 第 3 句永远进不了队列 -> pcm_end 永远不出现（waitFor 5s 超时失败）
    await waitFor(
      () =>
        harness.texts().some((m) => m.t === 'pcm_end') &&
        harness.texts().some((m) => m.t === 'state' && m.state === 'listening'),
      5000
    );
    // 6 句全部播出（reply 文本完整、pcm 头 sequence 连续推进）
    const reply = harness.texts().find((m) => m.t === 'reply');
    expect(String(reply?.text)).toContain('第六句话');
    expect(harness.binaries().length).toBeGreaterThan(6);
  });

  it('v1.1.1 审计回归：尾音 drain 期间被打断，DB 落 interrupted=1 且 metrics 只有一份', async () => {
    const db = openDatabase(':memory:');
    const turnsRepo = new CallTurnsRepository(db);
    const sessionsRepo = new CallSessionsRepository(db);
    sessionsRepo.insert({
      id: 'call-drain-abort',
      conversation_id: 'conv-da',
      voice_profile: 'main',
      started_at: Date.now(),
      ended_at: null,
      status: 'active',
      asr_provider: 'mock',
      tts_provider: 'mock',
      created_at: Date.now()
    });
    const harness = buildSessionHarness({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '5000' }),
      callId: 'call-drain-abort',
      conversationId: 'conv-da',
      turnsRepo,
      sessionsRepo
    });
    const { session } = harness;
    session.handleMessage({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } });
    session.handleMessage({ t: 'start' });
    session.handleBinary(Buffer.alloc(3200, 1));
    session.handleMessage({ t: 'end' });
    await waitFor(() => harness.texts().some((m) => m.t === 'pcm_end'));
    expect(session.state).toBe('speaking');

    // completed 尚未落库（延后到 drain 之后）——此刻打断
    session.handleMessage({ t: 'abort' });
    await waitFor(() => harness.texts().some((m) => m.t === 'interrupted'));
    await waitFor(() => session.state === 'listening');

    // DB：只有一行，且是 interrupted（不是被 completed 抢先覆盖）
    const turns = turnsRepo.listByCall('call-drain-abort');
    expect(turns.length).toBe(1);
    expect(turns[0].interrupted).toBe(1);
    // metrics 只有一份，且是 interrupted 版本（不再出现 completed+interrupted 两份互相矛盾）
    const metricsFrames = harness.texts().filter((m) => m.t === 'metrics');
    expect(metricsFrames.length).toBe(1);
    expect((metricsFrames[0].metrics as { interrupted: boolean }).interrupted).toBe(true);
  });
});
