import { describe, expect, it } from 'vitest';
import {
  buildWav,
  chunkPcm16,
  estimateMp3DurationMs,
  extractWavData,
  float32ToPcm16,
  pcm16ToFloat32,
  pcmDurationMs,
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

  it('MP3 时长估算', () => {
    expect(estimateMp3DurationMs(6000, 48)).toBe(1000);
  });
});
