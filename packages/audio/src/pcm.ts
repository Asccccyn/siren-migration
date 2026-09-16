/** PCM16 与 Float32 互转（实时输入/输出链路的基础工具） */

/** Float32 [-1,1] -> PCM16 little-endian */
export function float32ToPcm16(input: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

/** PCM16 little-endian -> Float32 [-1,1] */
export function pcm16ToFloat32(input: Buffer): Float32Array {
  const sampleCount = Math.floor(input.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = input.readInt16LE(i * 2) / 0x8000;
  }
  return out;
}

/** 把 Buffer 切成等大小的 PCM 块（尾部允许小块），用于平滑发送 */
export function chunkPcm16(audio: Buffer, chunkSamples: number): Buffer[] {
  const chunkBytes = chunkSamples * 2;
  if (chunkBytes <= 0 || audio.length === 0) return [];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    chunks.push(audio.subarray(offset, Math.min(offset + chunkBytes, audio.length)));
  }
  return chunks;
}

/** 每 20ms 对应的采样数（给定采样率），实时发送的最小调度粒度 */
export function samplesForDuration(sampleRate: number, durationMs: number): number {
  return Math.round((sampleRate * durationMs) / 1000);
}
