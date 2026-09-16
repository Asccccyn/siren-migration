/** 时长计算 */

export function pcmDurationMs(bytes: number, sampleRate: number, channels = 1, bits = 16): number {
  if (sampleRate <= 0 || channels <= 0 || bits <= 0) return 0;
  const bytesPerFrame = (bits / 8) * channels;
  return Math.round((bytes / bytesPerFrame / sampleRate) * 1000);
}

/** 由 WAV 头解析时长；解析失败返回 null */
export function wavDurationMs(buffer: Buffer): number | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      const channels = buffer.readUInt16LE(offset + 10);
      const sampleRate = buffer.readUInt32LE(offset + 12);
      const bits = buffer.readUInt16LE(offset + 22);
      const dataOffset = offset + 8 + chunkSize;
      if (dataOffset + 8 <= buffer.length && buffer.toString('ascii', dataOffset, dataOffset + 4) === 'data') {
        const dataLen = buffer.readUInt32LE(dataOffset + 4);
        return pcmDurationMs(dataLen, sampleRate, channels, bits);
      }
      return null;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

/** MP3 时长粗略估计（字节率法）。仅在 Provider 未返回时长时兜底使用 */
export function estimateMp3DurationMs(bytes: number, kbps = 48): number {
  if (kbps <= 0) return 0;
  return Math.round((bytes * 8) / (kbps * 1000) * 1000);
}
