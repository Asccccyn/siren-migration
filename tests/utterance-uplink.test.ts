/**
 * P0-1 / P0-2 客户端上行编排：
 * - VAD start 前的音频最终进入发送队列（pre-roll flush）
 * - start 触发块不重复发送
 * - 本地 barge-in：AI 活跃时 VAD start -> 先停播再 abort，不等服务端往返
 */
import { describe, expect, it } from 'vitest';
import { VadMachine, type VadParams } from '../apps/web/src/vad.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';

const BLOCK = 160; // 10ms @16k

interface Harness {
  uplink: UtteranceUplink;
  json: Record<string, unknown>[];
  frames: ArrayBuffer[];
  bargeIns: number[];
  tick(samples: Float32Array): void;
}

/**
 * 构造可控 VAD 环境：直接用真实 VadMachine，但注入快进时钟与低阈值，
 * 通过静音块 + 高幅块序列驱动 start/end。
 */
function buildHarness(
  options: { confirmMs?: number; aiActive?: () => boolean; aiSpeaking?: () => boolean } = {}
): Harness {
  const json: Record<string, unknown>[] = [];
  const frames: ArrayBuffer[] = [];
  const bargeIns: number[] = [];
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
    isAiActive: options.aiActive ?? (() => false),
    isAiSpeaking: options.aiSpeaking,
    onLocalBargeIn: () => bargeIns.push(clockMs)
  });
  return {
    uplink,
    json,
    frames,
    bargeIns,
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

describe('UtteranceUplink（P0-1 pre-roll / P0-2 本地 barge-in）', () => {
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

  it('AI speaking 时 VAD start 触发本地 barge-in：先停播、再 abort、再 start', () => {
    let aiActive = true;
    const h = buildHarness({ aiActive: () => aiActive });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    h.tick(loud(0));
    h.tick(loud(1));
    h.tick(loud(2));
    h.tick(loud(3));
    h.tick(loud(4));
    expect(h.bargeIns.length).toBe(1); // 立即停播发生
    const types = h.json.map((m) => m.t);
    // abort 在 start 之前（本地打断优先于新 utterance）
    const abortAt = types.lastIndexOf('abort');
    const startAt = types.lastIndexOf('start');
    expect(abortAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(abortAt);
    // 一次 AI 轮次只 abort 一次（防抖）：继续说也不重复 abort
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 6; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'abort').length).toBe(1);
    // 服务端回 listening 后重新武装
    aiActive = true;
    h.uplink.onServerState('listening');
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 6; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'abort').length).toBe(2);
  });

  it('AI 空闲（listening）时 VAD start 不触发 barge-in', () => {
    const h = buildHarness({ aiActive: () => false });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 5; i++) h.tick(loud(i));
    expect(h.bargeIns.length).toBe(0);
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

describe('UtteranceUplink（P0-4 回声防护：AI speaking 期间 VAD 不触发打断/上行）', () => {
  it('speaking 中 VAD start 被吞：不 abort、不 start、不上行、不停播', () => {
    const h = buildHarness({ aiSpeaking: () => true });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    expect(h.json.filter((m) => m.t === 'abort').length).toBe(0);
    expect(h.bargeIns.length).toBe(0);
    expect(h.frames.length).toBe(0); // 音频只进 pre-roll，不上行
  });

  it('他说完回 listening 且用户仍在说话：自动接上，句首来自 pre-roll', () => {
    let speaking = true;
    const h = buildHarness({ aiSpeaking: () => speaking });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // VAD start 被吞，preroll 积累
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    speaking = false;
    h.uplink.onServerState('listening'); // vadSpeech 仍为 true -> 自动接上
    expect(h.json.filter((m) => m.t === 'start').length).toBe(1);
    expect(h.frames.length).toBeGreaterThan(0);
    // 继续说话正常直发，静音后正常断句
    for (let i = 0; i < 6; i++) h.tick(loud(i));
    for (let i = 0; i < 8; i++) h.tick(SILENT);
    expect(h.json.filter((m) => m.t === 'end').length).toBe(1);
  });

  it('他说完前用户已停下：回 listening 不自动开启新 utterance', () => {
    let speaking = true;
    const h = buildHarness({ aiSpeaking: () => speaking });
    for (let i = 0; i < 6; i++) h.tick(SILENT);
    for (let i = 0; i < 8; i++) h.tick(loud(i)); // start 被吞
    for (let i = 0; i < 10; i++) h.tick(SILENT); // VAD end：用户已停
    speaking = false;
    h.uplink.onServerState('listening');
    expect(h.json.filter((m) => m.t === 'start').length).toBe(0);
    // 之后重新开口走正常路径
    for (let i = 0; i < 8; i++) h.tick(loud(i));
    expect(h.json.filter((m) => m.t === 'start').length).toBe(1);
  });
});
