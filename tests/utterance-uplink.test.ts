/**
 * 客户端上行编排：
 * - P0-1：VAD start 前的音频最终进入发送队列（pre-roll flush）；触发块不重复发送
 * - 半双工（1002 定案）：AI 活跃（thinking/speaking）期间 VAD start 一律吞掉
 *   ——不 abort、不 start、不上行（回声误触发与自动打断故障区收敛）；
 *   回 listening 且用户仍在说话时自动接上，句首来自 pre-roll
 */
import { describe, expect, it } from 'vitest';
import { VadMachine, type VadParams } from '../apps/web/src/vad.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';
import { VoiceTurnCoordinator } from '../apps/web/src/voice-turn-coordinator.ts';
import { StreamRouter } from '../apps/web/src/stream-router.ts';

const BLOCK = 160; // 10ms @16k

interface Harness {
  uplink: UtteranceUplink;
  json: Record<string, unknown>[];
  frames: ArrayBuffer[];
  tick(samples: Float32Array): void;
}

/**
 * 构造可控 VAD 环境：直接用真实 VadMachine，但注入快进时钟与低阈值，
 * 通过静音块 + 高幅块序列驱动 start/end。
 */
function buildHarness(options: { confirmMs?: number; aiActive?: () => boolean } = {}): Harness {
  const json: Record<string, unknown>[] = [];
  const frames: ArrayBuffer[] = [];
  const params = (): VadParams => ({
    confirmMs: options.confirmMs ?? 40,
    minSpeechMs: 10,
    endSilenceMs: 40,
    rmsRatio: 2
  });
  // VadMachine 用 performance.now；这里用块计数驱动真实时钟太慢，
  // 改为注入 now()：每个样本块推进 10ms
  let clockMs = 0;
  const vad = new VadMachine(params, () => clockMs);
  const uplink = new UtteranceUplink({
    vad,
    preRoll: new AudioPreRollBuffer(6400),
    framer: new Pcm16Framer(320),
    sendJson: (message) => json.push(message),
    sendFrame: (frame) => frames.push(frame),
    isAiActive: options.aiActive ?? (() => false)
  });
  return {
    uplink,
    json,
    frames,
    tick(samples: Float32Array): void {
      clockMs += 10;
      uplink.handleSamples(samples);
    }
  };
}

const SILENT = new Float32Array(BLOCK); // RMS = 0
function loud(block: number, count = BLOCK): Float32Array {
  const out = new Float32Array(count);
  out.fill(block % 2 === 0 ? 0.9 : -0.9);
  return out;
}

describe('UtteranceUplink（P0-1 pre-roll / 基础上行）', () => {
  it('VAD start 前的音频通过 pre-roll flush 进入发送队列（首音不丢）', () => {
    const h = buildHarness();
    // 静音期若干块（确立噪声基线）
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    // 说话：VAD 需要 confirmMs=40ms 确认 —— 前 4 块高幅是"判定窗口内"的音频
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    // start 应已发生（第 5 块时 t - speechStart = 40ms）
    expect(h.json.filter((m) => m.t === 'start').length).toBe(1);

    // pre-roll flush 的样本必须包含判定窗口内的高幅音频：
    // 上行帧中存在非零 PCM（首帧可能是 pre-roll 里的静音块，扫描全部帧）
    expect(h.frames.length).toBeGreaterThan(0);
    let nonZero = 0;
    for (const frame of h.frames) {
      const view = new DataView(frame);
      for (let i = 0; i < view.byteLength / 2; i++) {
        if (view.getInt16(i * 2, true) !== 0) nonZero++;
      }
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('start 触发块不重复发送（flush 已含当前块，同一块只上行一次）', () => {
    const h = buildHarness();
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    // 第 5 块高幅恰好在 confirm 边界触发 start；该块已在 pre-roll 中
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    const startSeq = h.json.filter((m) => m.t === 'start').length;
    expect(startSeq).toBe(1);
    // 帧样本总量 = flush(pre-roll 全量，含触发块) + 后续直发块，不允许同块双份：
    // pre-roll 内 = 6 静音块 + 5 高幅块（触发块在内）= 1760 样本，分帧后 5 帧 = 3200 字节；
    // 若触发块被重复发送会多出 160 样本 -> 6 帧 = 3840 字节
    const bytes = h.frames.reduce((sum, f) => sum + f.byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(11 * 160 * 2);
    expect(bytes).toBeGreaterThanOrEqual(5 * 320 * 2);
  });

  it('AI 空闲（listening）时 VAD start 正常上行，不发 abort', () => {
    const h = buildHarness({ aiActive: () => false });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    expect(h.json.some((m) => m.t === 'abort')).toBe(false);
    expect(h.json.some((m) => m.t === 'start')).toBe(true);
  });

  it('静音时不积累不上传；解除静音后 pre-roll 从零开始', () => {
    const h = buildHarness();
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    h.uplink.setMuted(true);
    for (let i = 0; i < 4; i++) h.tick(loud(i)); // 静音期说话
    expect(h.json.some((m) => m.t === 'start')).toBe(false);
    expect(h.frames.length).toBe(0);
    h.uplink.setMuted(false);
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    // 解除静音后：pre-roll 不含静音期的旧 loud 块，start 正常触发
    expect(h.json.some((m) => m.t === 'start')).toBe(true);
    expect(h.frames.length).toBeGreaterThan(0);
  });

  it('F19：PTT 每轮收尾 flush 分帧残余，第二轮不混入上一轮样本', () => {
    const h = buildHarness();
    h.uplink.setMode('ptt');
    h.uplink.startPtt();
    h.tick(new Float32Array(BLOCK).fill(0.5)); // 160 样本 = 半帧
    h.uplink.endPtt();
    // 残余作为末帧立即发出（旧行为：0 帧，残余滞留）
    expect(h.frames.length).toBe(1);
    const first = new Int16Array(h.frames[0]);
    expect(first.length).toBe(BLOCK);
    expect(first[0]).toBeGreaterThan(0);

    h.uplink.startPtt();
    h.tick(new Float32Array(BLOCK).fill(-0.5));
    h.uplink.endPtt();
    expect(h.frames.length).toBe(2);
    const second = new Int16Array(h.frames[1]);
    expect(second.length).toBe(BLOCK);
    // 第二轮从自己的样本开始：没有串入上一轮的正样本残余
    expect(second[0]).toBeLessThan(0);
  });

  it('VAD 断句发送 end；PTT 模式直发', () => {
    const h = buildHarness();
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    for (let i = 0; i < 6; i++) h.tick(SILENT); // endSilence 40ms = 4 块
    expect(h.json.some((m) => m.t === 'end')).toBe(true);

    h.uplink.setMode('ptt');
    h.uplink.startPtt();
    h.tick(loud(0));
    h.uplink.endPtt();
    expect(h.json.filter((m) => m.t === 'start').length).toBe(2);
    expect(h.json.filter((m) => m.t === 'end').length).toBe(2);
  });
});

describe('UtteranceUplink（半双工：AI 活跃期间 VAD 一律不触发上行/打断）', () => {
  it('AI active（thinking 或 speaking）中 VAD start 被吞：不 abort、不 start、不上行', () => {
    const h = buildHarness({ aiActive: () => true });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    expect(h.json.filter((m) => m.t === 'abort').length).toBe(0);
    expect(h.frames.length).toBe(0); // 音频只进 pre-roll，不上行
  });

  it('AI 回 listening 且用户仍在说话：自动接上，句首来自 pre-roll', () => {
    let aiActive = true;
    const h = buildHarness({ aiActive: () => aiActive });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // VAD start 被吞，preroll 积累
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    aiActive = false;
    h.uplink.onServerState('listening'); // vadSpeech 仍为 true -> 自动接上
    expect(h.json.filter((m) => m.t === 'start').length).toBe(1);
    expect(h.frames.length).toBeGreaterThan(0);
    // 继续说话正常直发，静音后正常断句
    for (let i = 0; i < 6; i++) h.tick(loud(i));
    for (let i = 0; i < 8; i++) h.tick(SILENT);
    expect(h.json.filter((m) => m.t === 'end').length).toBe(1);
  });

  it('S1011-005：静音撤销待恢复意图——静音中回 listening 不上行', () => {
    let aiActive = true;
    const h = buildHarness({ aiActive: () => aiActive });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // start 被吞
    h.uplink.setMuted(true); // 等待期间静音
    aiActive = false;
    h.uplink.onServerState('listening');
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    expect(h.frames.length).toBe(0);
  });

  it('S1011-005：切 PTT 撤销待恢复意图——不按键不得上传麦克风', () => {
    let aiActive = true;
    const h = buildHarness({ aiActive: () => aiActive });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // start 被吞
    h.uplink.setMode('ptt'); // 等待期间切到按住说话
    aiActive = false;
    h.uplink.onServerState('listening');
    // PTT 模式下持续有声但不按键：不上行
    for (let i = 0; i < 8; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    expect(h.frames.length).toBe(0);
  });

  it('AI 结束前用户已停下：回 listening 不自动开启新 utterance', () => {
    let aiActive = true;
    const h = buildHarness({ aiActive: () => aiActive });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // start 被吞
    for (let i = 0; i < 10; i++) h.tick(SILENT); // VAD end：用户已停
    aiActive = false;
    h.uplink.onServerState('listening');
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    // 之后重新开口走正常路径
    for (let i = 0; i < 8; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'start').length).toBe(1);
  });
});

/** C05 短输入不丢：uplink + 真实 VoiceTurnCoordinator/StreamRouter 联动 */
function negotiatedHarness() {
  const json: Record<string, unknown>[] = [];
  const frames: ArrayBuffer[] = [];
  const dropped: string[] = [];
  let invalidations = 0;
  let lastInvalidatedStream: string | null = null;
  let clockMs = 0;
  const router = new StreamRouter({
    onChunk: () => {},
    onStreamStart: () => {},
    onStreamEnd: () => {},
    onDrained: () => {},
    onDropped: (reason) => dropped.push(reason)
  });
  const turns = new VoiceTurnCoordinator({
    idPrefix: 'c05',
    sendJson: (m) => json.push(m),
    sendFrame: (f) => frames.push(f),
    invalidateOutput: () => {
      // 顺序保持 L45-46：先作废 router 再 stopAll（本测试无播放器，只记顺序事实）
      invalidations += 1;
      const stream = router.activeStream;
      router.invalidateActive();
      lastInvalidatedStream = stream;
      return stream ? { stream_id: stream, played_ms: 12 } : undefined;
    },
    onFailure: () => {
      throw new Error('unexpected coordinator failure');
    }
  });
  turns.negotiate(true);
  let aiActive = false;
  const uplink = new UtteranceUplink({
    vad: new VadMachine(
      () => ({ confirmMs: 40, minSpeechMs: 400, endSilenceMs: 60, rmsRatio: 2 }),
      () => clockMs
    ),
    preRoll: new AudioPreRollBuffer(6400),
    framer: new Pcm16Framer(320),
    sendJson: (m) => json.push(m),
    sendFrame: (f) => turns.sendFrame(f),
    isAiActive: () => aiActive,
    canInterrupt: () => turns.supported,
    startInput: () => turns.begin(),
    finishInput: (valid) => turns.finish(valid),
    endInput: () => turns.endInput()
  });
  return {
    json, frames, dropped, turns, router, uplink,
    get invalidations() { return invalidations; },
    get lastInvalidatedStream() { return lastInvalidatedStream; },
    setAiActive(value: boolean) { aiActive = value; },
    tick(samples: Float32Array) { clockMs += 10; uplink.handleSamples(samples); }
  };
}


describe('C05：短输入完成而非中止（minSpeech 门下不丢弃）', () => {
  /** 公共前置：建立第一轮 input（c05_1）+ 服务端已在播旧输出流 out_old */
  function establishedTurn() {
    const h = negotiatedHarness();
    h.router.handleJson({ t: 'pcm', stream_id: 'out_old', sequence: 0, rate: 24000, bytes: 640 });
    h.router.handleBinary(new ArrayBuffer(640));
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 46; i++) h.tick(loud(i)); // spoken ≈ 450ms ≥ 400ms
    h.turns.accept({ t: 'input_started', input_id: 'c05_1' }); // ACK 前 flush
    for (let i = 0; i < 8; i++) h.tick(SILENT); // endSilence 60ms
    expect(h.json.some((m) => m.t === 'end' && m.input_id === 'c05_1')).toBe(true);
    h.setAiActive(true); // AI 正在播报第一轮的回复
    return h;
  }

  it('AI 播报中短音起声：interrupt 带作废旧输出，PCM 缓冲等 ACK', () => {
    const h = establishedTurn();
    const framesBefore = h.frames.length;
    for (let i = 0; i < 26; i++) h.tick(loud(i)); // spoken ≈ 250ms
    const interrupt = h.json.find((m) => m.t === 'interrupt');
    expect(interrupt).toMatchObject({ target_input_id: 'c05_1', new_input_id: 'c05_2' });
    expect(interrupt).toMatchObject({ playback: { stream_id: 'out_old', played_ms: 12 } });
    // 每次 begin 各作废一次（第一轮 begin 无活跃流、第二轮 begin 作废 out_old）；
    // 旧行为的 abort 会带来第三次作废
    expect(h.invalidations).toBe(2);
    expect(h.frames.length).toBe(framesBefore); // ACK 前 PCM 仍在缓冲
  });

  it('AI 播报中 250ms 短音（<400ms 门）：end 提交 ASR，不 abort，旧输出不复活', () => {
    const h = establishedTurn();
    const framesBefore = h.frames.length;
    for (let i = 0; i < 26; i++) h.tick(loud(i)); // spoken ≈ 250ms
    for (let i = 0; i < 8; i++) h.tick(SILENT); // 静音断句：spoken<400 → invalid
    // 旧行为：finishInput(false) -> abort（丢弃）；新行为：end 提交
    expect(h.json.some((m) => m.t === 'abort')).toBe(false);
    expect(h.invalidations).toBe(2); // 没有第三次作废（未走 abort）
    expect(h.json.filter((m) => m.t === 'end' && m.input_id === 'c05_2')).toHaveLength(0); // end 在缓冲 PCM 之后
    h.turns.accept({ t: 'input_started', input_id: 'c05_2' });
    expect(h.json.some((m) => m.t === 'end' && m.input_id === 'c05_2')).toBe(true);
    expect(h.frames.length).toBeGreaterThan(framesBefore); // 短音 PCM 真正上行（进 ASR）
    // 旧输出不复活：短输入结束后旧流迟到 chunk 仍被取消/丢弃
    h.router.handleJson({ t: 'pcm', stream_id: 'out_old', sequence: 1, rate: 24000, bytes: 640 });
    h.router.handleBinary(new ArrayBuffer(640));
    expect(h.dropped).toContain('cancelled_stream_chunk');
  });

  it('静音假起声（从未确认）不上行不 abort；从未 begin 的 finish(false) 仍 abort（legacy 语义保留）', () => {
    const h = negotiatedHarness();
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    // 低于 confirmMs=40ms 的候选起声后转静音：从未 start，VAD 直接回到空闲
    for (let i = 0; i < 2; i++) h.tick(loud(i));
    for (let i = 0; i < 10; i++) h.tick(SILENT);
    expect(h.json).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
    expect(h.invalidations).toBe(0);

    // 从未 begin 的输入显式 finish(false)（假候选路径）：abort 保留
    const legacy = new VoiceTurnCoordinator({
      idPrefix: 'legacy',
      sendJson: (m) => h.json.push(m),
      sendFrame: () => {},
      invalidateOutput: () => undefined,
      onFailure: () => {}
    });
    legacy.negotiate(false);
    legacy.finish(false);
    expect(h.json.some((m) => m.t === 'abort')).toBe(true);
    expect(h.json.some((m) => m.t === 'end')).toBe(false);
  });
});
