/**
 * 上行音频编码（规范第 16 节）：AudioWorklet Float32（如 48kHz）
 * -> 线性插值重采样 16kHz -> PCM16 20ms 帧（320 样本）。
 */

/** 跨 push 保留残余样本的流式重采样器 */
export class Float32Resampler {
  private pending: Float32Array | null = null;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number
  ) {}

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate || input.length === 0) return input;
    const merged = this.pending ? concat(this.pending, input) : input;
    const ratio = this.fromRate / this.toRate;
    const wholeCount = Math.floor(merged.length / ratio);
    this.pending = wholeCount > 0 ? merged.subarray(Math.floor(wholeCount * ratio)) : merged;
    const out = new Float32Array(wholeCount);
    for (let i = 0; i < wholeCount; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const frac = srcPos - i0;
      const v0 = merged[i0] ?? 0;
      const v1 = merged[i0 + 1] ?? v0;
      out[i] = v0 * (1 - frac) + v1 * frac;
    }
    return out;
  }

  reset(): void {
    this.pending = null;
  }
}

/** 把 Float32 流切成固定样本数的 PCM16 little-endian 帧 */
export class Pcm16Framer {
  private queue: Float32Array[] = [];
  private queued = 0;

  constructor(private readonly frameSamples: number) {}

  push(input: Float32Array): ArrayBuffer[] {
    if (input.length > 0) {
      this.queue.push(input);
      this.queued += input.length;
    }
    const frames: ArrayBuffer[] = [];
    while (this.queued >= this.frameSamples) {
      frames.push(this.takeFrame());
    }
    return frames;
  }

  reset(): void {
    this.queue = [];
    this.queued = 0;
  }

  private takeFrame(): ArrayBuffer {
    const frame = new Float32Array(this.frameSamples);
    let copied = 0;
    while (copied < this.frameSamples) {
      const head = this.queue[0];
      if (!head) break;
      const need = this.frameSamples - copied;
      const take = Math.min(need, head.length);
      frame.set(head.subarray(0, take), copied);
      copied += take;
      if (take < head.length) {
        this.queue[0] = head.subarray(take);
      } else {
        this.queue.shift();
      }
    }
    this.queued -= copied;
    const pcm = new DataView(new ArrayBuffer(this.frameSamples * 2));
    for (let i = 0; i < this.frameSamples; i++) {
      let s = frame[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
    return pcm.buffer;
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
