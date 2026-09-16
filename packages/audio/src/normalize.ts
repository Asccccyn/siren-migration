/** 音量与 RMS 工具（服务端 normalize 与浏览器 VAD 共用算法语义） */

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function dbfs(rmsValue: number): number {
  if (rmsValue <= 0) return -96;
  return 20 * Math.log10(rmsValue);
}

/** 把 PCM16 峰值归一化到 targetPeak（0~1），返回缩放后的新 Buffer */
export function normalizePcm16(input: Buffer, targetPeak = 0.9): Buffer {
  let peak = 0;
  for (let i = 0; i + 1 < input.length; i += 2) {
    const v = Math.abs(input.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak === 0) return Buffer.from(input);
  const gain = Math.min((targetPeak * 0x8000) / peak, 8);
  if (Math.abs(gain - 1) < 0.02) return Buffer.from(input);
  const out = Buffer.allocUnsafe(input.length);
  for (let i = 0; i + 1 < input.length; i += 2) {
    let v = Math.round(input.readInt16LE(i) * gain);
    if (v > 0x7fff) v = 0x7fff;
    else if (v < -0x8000) v = -0x8000;
    out.writeInt16LE(v, i);
  }
  return out;
}
