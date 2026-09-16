import { describe, expect, it } from 'vitest';
import {
  buildWav,
  chunkPcm16,
  estimateMp3DurationMs,
  extractWavData,
  float32ToPcm16,
  normalizePcm16,
  pcm16ToFloat32,
  pcmDurationMs,
  resampleFloat32,
  rms,
  wavDurationMs
} from '@siren/audio';

describe('audio 包', () => {
  it('Float32 <-> PCM16 往返', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = float32ToPcm16(input);
    expect(pcm.length).toBe(input.length * 2);
    const back = pcm16ToFloat32(pcm);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(0.001);
    }
  });

  it('线性重采样保持时长比例', () => {
    const input = new Float32Array(4800).fill(0.1);
    const out = resampleFloat32(input, 48000, 16000);
    expect(out.length).toBe(1600);
  });

  it('PCM 时长计算', () => {
    expect(pcmDurationMs(32000, 16000)).toBe(1000); // 32000B = 16000 samples = 1s
    expect(pcmDurationMs(48000, 24000)).toBe(1000);
  });

  it('WAV 封装/解析/时长', () => {
    const pcm = float32ToPcm16(new Float32Array(24000).fill(0.2)); // 1s @24k
    const wav = buildWav(pcm, 24000);
    expect(wavDurationMs(wav)).toBe(1000);
    expect(extractWavData(wav).equals(pcm)).toBe(true);
  });

  it('chunkPcm16 均分块', () => {
    const data = Buffer.alloc(1000);
    const chunks = chunkPcm16(data, 100); // 100 samples = 200B
    expect(chunks.length).toBe(5);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it('RMS 与 normalize', () => {
    const silence = new Float32Array(1000);
    expect(rms(silence)).toBe(0);
    const loud = new Float32Array(1000).fill(0.5);
    expect(rms(loud)).toBeCloseTo(0.5, 5);

    const quiet = float32ToPcm16(new Float32Array(1000).fill(0.05));
    const boosted = normalizePcm16(quiet);
    let peak = 0;
    for (let i = 0; i + 1 < boosted.length; i += 2) {
      peak = Math.max(peak, Math.abs(boosted.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(0.2 * 0x8000); // 确实被放大（受最大增益 8x 限制）
  });

  it('MP3 时长估算', () => {
    expect(estimateMp3DurationMs(6000, 48)).toBe(1000);
  });
});
