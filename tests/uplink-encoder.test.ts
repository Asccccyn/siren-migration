/**
 * F19 / F20（2026-09-27 审计）：上行编码。
 * - F20：44.1kHz 线性重采样跨 push 保留小数采样相位——旧实现按
 *   Math.floor 截断残余位置，60s/44.1kHz 输入多产出 ~0.49% 样本
 * - F19：Pcm16Framer 需要 flush（末帧收尾）语义，残余不再跨 utterance 串音
 */
import { describe, expect, it } from 'vitest';
import { Float32Resampler, Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';

describe('Float32Resampler（F20：分数相位）', () => {
  it('44.1kHz -> 16kHz：60s 输入按 128 样本分块，输出恰好 960,000 样本', () => {
    const input = new Float32Array(44100 * 60);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 100) * 0.5;
    const resampler = new Float32Resampler(44100, 16000);
    let produced = 0;
    for (let offset = 0; offset < input.length; offset += 128) {
      produced += resampler.push(input.subarray(offset, Math.min(offset + 128, input.length))).length;
    }
    // 旧实现：964,687（多 0.488%）
    expect(produced).toBe(960000);
  });

  it('分块方式不影响结果：128/256/1024 样本分块输出完全一致', () => {
    const input = new Float32Array(44100 * 2);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 37) * 0.8;
    const run = (chunkSize: number): Float32Array => {
      const resampler = new Float32Resampler(44100, 16000);
      const parts: Float32Array[] = [];
      for (let offset = 0; offset < input.length; offset += chunkSize) {
        parts.push(resampler.push(input.subarray(offset, Math.min(offset + chunkSize, input.length))));
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Float32Array(total);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const a = run(128);
    const b = run(256);
    const c = run(1024);
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(c.length);
    for (let i = 0; i < a.length; i += 97) {
      expect(a[i]).toBeCloseTo(b[i], 10);
      expect(a[i]).toBeCloseTo(c[i], 10);
    }
  });

  it('48kHz -> 16kHz 整数比：与直通计算一致', () => {
    const input = new Float32Array(48000);
    for (let i = 0; i < input.length; i++) input[i] = Math.cos(i / 11) * 0.3;
    const resampler = new Float32Resampler(48000, 16000);
    let produced = 0;
    for (let offset = 0; offset < input.length; offset += 128) {
      produced += resampler.push(input.subarray(offset, offset + 128)).length;
    }
    expect(produced).toBe(16000);
    resampler.reset();
    // reset 后无残留相位：320 样本恰好产出 floor((320-1)/3)+1 = 107 个，
    // 与单次 push 320 样本的结果一致（不携带上一轮相位）
    expect(resampler.push(new Float32Array(320)).length).toBe(107);
  });
});

describe('Pcm16Framer（F19：末帧 flush）', () => {
  it('不满一帧的残余在 flush 时作为短末帧发出并清空状态', () => {
    const framer = new Pcm16Framer(320);
    expect(framer.push(new Float32Array(160).fill(0.5))).toHaveLength(0); // 半帧：无整帧
    const tail = framer.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0].byteLength).toBe(320); // 160 样本 PCM16 = 320 字节
    expect(framer.flush()).toHaveLength(0); // 幂等：已清空

    // flush 后新数据从零开始（不携带上一轮残余）
    const frames = framer.push(new Float32Array(320).fill(-0.5));
    expect(frames).toHaveLength(1);
    const samples = new Int16Array(frames[0]);
    expect(samples[0]).toBeLessThan(0);
  });

  it('reset 丢弃残余（teardown 语义，不发送）', () => {
    const framer = new Pcm16Framer(320);
    framer.push(new Float32Array(160).fill(0.9));
    framer.reset();
    expect(framer.flush()).toHaveLength(0);
  });
});
