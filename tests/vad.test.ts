/**
 * F05（2026-09-27 审计）：浏览器端 VAD。
 * 旧缺陷：确认窗口（inSpeech 尚未成立）内每个 AudioWorklet 块仍更新噪声底，
 * 128 样本高频回调下阈值在 confirmMs 内追上语音电平 -> 永远 0 次 start。
 * 修复：候选语音期间冻结噪声估计；平滑系数按真实块间隔（NOISE_TAU_MS）归一化。
 */
import { describe, expect, it } from 'vitest';
import { VadMachine, type VadParams } from '../apps/web/src/vad.ts';

const PARAMS: VadParams = { confirmMs: 200, minSpeechMs: 400, endSilenceMs: 700, rmsRatio: 4 };

function block(rms: number, samples = 128): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = rms;
  return out;
}

/** 按 44.1kHz / 128 样本的真实节奏推进受控时钟 */
function machine(): { vad: VadMachine; step: (rms: number) => string } {
  let clockMs = 0;
  const vad = new VadMachine(() => PARAMS, () => clockMs);
  return {
    vad,
    step(rms: number) {
      clockMs += (128 / 44100) * 1000; // ~2.9ms/块
      return vad.process(block(rms)).event;
    }
  };
}

describe('VadMachine（F05：候选语音冻结噪声底 + 时间归一化）', () => {
  it('背景噪声后持续讲话：confirmMs 内确认 start，噪声底不追上语音', () => {
    const { vad, step } = machine();
    // 2 秒背景噪声（RMS 0.005）让噪声底稳定
    for (let i = 0; i < 700; i++) step(0.005);
    expect(vad.noiseFloorValue).toBeLessThan(0.01);

    // 持续语音 RMS 0.1：旧实现噪声底会学到 ~0.1、阈值 ~0.4，永远 start 不了
    let started = false;
    for (let i = 0; i < 400 && !started; i++) {
      started = step(0.1) === 'start';
    }
    expect(started).toBe(true);
    // 候选语音期间噪声估计被冻结：仍在背景量级
    expect(vad.noiseFloorValue).toBeLessThan(0.02);
  });

  it('48kHz 与 44.1kHz 块节奏下，同等静音时间的噪声学习一致（时间归一化）', () => {
    const run = (samplesPerBlock: number, rms: number, totalMs: number): number => {
      let clockMs = 0;
      const vad = new VadMachine(() => PARAMS, () => clockMs);
      const dt = (samplesPerBlock / 48000) * 1000;
      const steps = Math.round(totalMs / dt);
      for (let i = 0; i < steps; i++) {
        clockMs += dt;
        vad.process(block(rms, samplesPerBlock));
      }
      return vad.noiseFloorValue;
    };
    const slow = run(128, 0.05, 2000); // 44.1k 节奏换算到 48k 基准：dt 相近
    const fast = run(512, 0.05, 2000); // 更大的块（更低频回调）
    // 旧的固定 alpha=0.02/块：128 样本块 2s 内 ~700 块会收敛到 0.05，
    // 512 样本块只有 ~188 块，结果显著不同；归一化后两者一致
    expect(Math.abs(slow - fast)).toBeLessThan(0.005);
    expect(Math.abs(slow - 0.05)).toBeGreaterThan(0); // 未完全收敛（tau=2s 的温和跟踪）
  });

  it('静音期噪声底仍自适应下降（冻结只作用于候选语音窗口）', () => {
    const { vad, step } = machine();
    for (let i = 0; i < 700; i++) step(0.05); // 先学习高噪声
    const raised = vad.noiseFloorValue;
    for (let i = 0; i < 2000; i++) step(0.001); // 长静音
    expect(vad.noiseFloorValue).toBeLessThan(raised);
  });
});
