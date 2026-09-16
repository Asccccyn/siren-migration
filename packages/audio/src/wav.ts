/** 最小 WAV 封装/解析（本地对象存储与 Mock Provider 使用） */

export function wavHeader(dataBytes: number, sampleRate: number, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function buildWav(pcm: Buffer, sampleRate: number, channels = 1, bits = 16): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate, channels, bits), pcm]);
}

/** 提取 WAV 中的原始 PCM 数据；非 WAV 输入原样返回 */
export function extractWavData(buffer: Buffer): Buffer {
  if (buffer.length < 44) return buffer;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return buffer;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return buffer.subarray(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return buffer;
}
