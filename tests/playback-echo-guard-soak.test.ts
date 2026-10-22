/**
 * C09/C23：PlaybackEchoGuard 合成长时浸泡。
 * 16kHz 连续样本数组直接喂入（不占用真实时间）：变增益回声 + 混响尾次径 +
 * 周期性间歇的参考信号，总时长 ≥60s 等效样本；近端穿插弱信号（双讲窗 + 静音窗）。
 *
 * 断言：
 * - 全程无误抑制近端：弱信号段残差能量保留（双讲窗与近端独占窗都不被吞）
 * - 无未绑定点状态泄漏：输出无 NaN/Infinity、幅度有界
 * - 缓冲内存有界：内部固定缓冲样本量不随处理时长增长
 *
 * 10 分钟真机外放浸泡（iPhone/蓝牙音箱实际声学路径）= DEVICE NOT_EXECUTED：
 * 本文件只验证算法在合成信号上的长时稳定性，不能替代设备验收。
 */
import { describe, expect, it } from 'vitest';
import { PlaybackEchoGuard } from '../apps/web/src/playback-echo-guard.ts';

const BLOCK = 320; // 20ms，与分析节拍一致
const TOTAL_BLOCKS = 3000; // 60s 等效样本（960,000 samples @16kHz）
const TOTAL = TOTAL_BLOCKS * BLOCK;

// 周期性间歇：每 350 块停 50 块（参考信号暂停窗 = [300+350n, 350+350n)）
const paused = (block: number): boolean => block % 350 >= 300;
// 近端弱信号窗：双讲 [900,1000)/[1900,2000)（参考活跃），近端独占 [1370,1400)（参考暂停）
const nearActive = (block: number): boolean =>
  (block >= 900 && block < 1000) || (block >= 1900 && block < 2000) || (block >= 1370 && block < 1400);
const nearOnly = (block: number): boolean => block >= 1370 && block < 1400;

function buildSignals(): { reference: Float32Array; mic: Float32Array; near: Float32Array } {
  let lcg = 0x2f6e2b1;
  const noise = (): number => {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    return (lcg / 0x100000000) * 2 - 1;
  };
  const reference = new Float32Array(TOTAL);
  const near = new Float32Array(TOTAL);
  const mic = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    const block = Math.floor(i / BLOCK);
    // 参考信号：伪随机噪声 × 慢变增益 + 周期性间歇
    const gain = paused(block) ? 0 : 0.15 + 0.7 * (0.5 + 0.5 * Math.sin(block / 300));
    reference[i] = noise() * gain;
    near[i] = nearActive(block) ? noise() * 0.06 : 0;
    // 回声信道：主径 384 样本（24ms，增益慢变 ±40%）+ 次径 1000 样本混响尾（单延迟模型无法消除）
    const channel = 0.5 * (0.8 + 0.4 * Math.sin(block / 973 + 1));
    mic[i] =
      (reference[i - 384] ?? 0) * channel +
      (reference[i - 1000] ?? 0) * 0.1 +
      noise() * 1e-4 +
      near[i];
  }
  return { reference, mic, near };
}

describe('PlaybackEchoGuard 长时浸泡（合成 60s 等效样本）', () => {
  it('弱近端全程保留、回声整体受抑、无状态泄漏、缓冲有界', () => {
    const { reference, mic, near } = buildSignals();
    const guard = new PlaybackEchoGuard();
    const footprintStart = guard.fixedBufferSamples;
    let footprintMid = footprintStart;

    let doubleResidual = 0, doubleNear = 0, doubleMic = 0; // 双讲窗累计能量
    let doubleMinBlockRatio = Infinity;
    let soloResidual = 0, soloNear = 0; // 近端独占窗（参考暂停）
    let echoMic = 0, echoResidual = 0; // 纯回声区（非近端、参考活跃、跳过预热）
    let maxAbs = 0;
    let leaked = false;

    for (let block = 0; block < TOTAL_BLOCKS; block++) {
      const at = block * BLOCK;
      const residual = guard.process(mic.subarray(at, at + BLOCK), reference.subarray(at, at + BLOCK));
      let blockResidual = 0, blockNear = 0, blockMic = 0;
      for (let i = 0; i < BLOCK; i++) {
        const value = residual[i];
        if (!Number.isFinite(value)) leaked = true;
        const abs = Math.abs(value);
        if (abs > maxAbs) maxAbs = abs;
        blockResidual += value * value;
        blockNear += near[at + i] * near[at + i];
        blockMic += mic[at + i] * mic[at + i];
      }
      if (nearActive(block)) {
        if (nearOnly(block)) {
          soloResidual += blockResidual;
          soloNear += blockNear;
        } else if (block >= 905 && block < 1000 || block >= 1905 && block < 2000) {
          // 窗口首 5 块留给重锁定，其余逐块盯守
          doubleResidual += blockResidual;
          doubleNear += blockNear;
          doubleMic += blockMic;
          const ratio = blockNear > 0 ? blockResidual / blockNear : 1;
          if (ratio < doubleMinBlockRatio) doubleMinBlockRatio = ratio;
        }
      } else if (!paused(block) && block >= 100) {
        echoMic += blockMic;
        echoResidual += blockResidual;
      }
      if (block === Math.floor(TOTAL_BLOCKS / 2)) footprintMid = guard.fixedBufferSamples;
    }

    // 1) 近端独占窗：参考已停，guard 必须原样放行（残差 ≈ 近端，无任何抑制）
    expect(soloNear).toBeGreaterThan(0);
    expect(soloResidual / soloNear).toBeGreaterThan(0.95);
    // 2) 双讲窗：弱近端不被误抑制——窗口累计保留 + 逐块下限（没有任何块被吞掉）。
    //    上界只防状态发散：低锁定置信时 guard 宁可放行（残差含未消除回声），这是
    //    "不吞近端"的设计取向，残差因此允许高于近端能量本身
    expect(doubleNear).toBeGreaterThan(0);
    expect(doubleResidual / doubleNear).toBeGreaterThan(0.8);
    expect(doubleMinBlockRatio).toBeGreaterThan(0.4);
    expect(doubleResidual).toBeLessThanOrEqual(2 * doubleMic);
    // 3) 纯回声区：整体能量显著受抑（次径混响尾是单延迟模型无法消除的已知残差）
    expect(echoMic).toBeGreaterThan(0);
    expect(echoResidual / echoMic).toBeLessThan(0.12);
    // 4) 无未绑定点状态泄漏：输出有限且有界
    expect(leaked).toBe(false);
    expect(maxAbs).toBeLessThanOrEqual(2);
    // 5) 缓冲内存有界：固定缓冲样本量 60s 前后一致
    expect(footprintMid).toBe(footprintStart);
    expect(guard.fixedBufferSamples).toBe(footprintStart);
  });
});
