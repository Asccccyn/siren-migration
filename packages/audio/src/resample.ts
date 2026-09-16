import { float32ToPcm16, pcm16ToFloat32 } from './pcm.ts';

/** 线性插值重采样（质量足够语音链路使用，且无外部依赖） */

export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  return float32ToPcm16(resampleFloat32(pcm16ToFloat32(input), fromRate, toRate));
}
