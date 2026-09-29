/**
 * 上行音频编码（规范第 16 节）：AudioWorklet Float32（如 48kHz）
 * -> 线性插值重采样 16kHz -> PCM16 20ms 帧（320 样本）。
 * F20：重采样跨 push 保留小数采样相位（旧实现按整数截断残余位置，
 * 44.1kHz 输入每分钟多产出 ~0.5% 样本）。
 */

/** 跨 push 保留残余样本与小数相位的流式重采样器 */
export class Float32Resampler {
  private buffer: Float32Array | null = null;
  /** 下一个输出样本在 buffer 中的小数位置（始终 < 1，随消费一起左移） */
  private pos = 0;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number
  ) {}

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate || input.length === 0) return input;
    const ratio = this.fromRate / this.toRate;
    const buffer = this.buffer ? concat(this.buffer, input) : input;
    // 线性插值需要 i0+1 可读：最后一个可输出样本的 srcPos <= buffer.length - 1
    const maxOut = Math.max(0, Math.floor((buffer.length - 1 - this.pos) / ratio) + 1);
    const out = new Float32Array(maxOut);
    for (let k = 0; k < maxOut; k++) {
      const srcPos = this.pos + k * ratio;
      const i0 = Math.floor(srcPos);
      const frac = srcPos - i0;
      const v0 = buffer[i0] ?? 0;
      const v1 = buffer[i0 + 1] ?? v0;
      out[k] = v0 + (v1 - v0) * frac;
    }
    const advanced = this.pos + maxOut * ratio;
    // drop 不能超过已有样本：advanced 可以越过 buffer 末尾（最后一段插值读到了边界），
    // 越过部分折算进小数相位保留给下一块
    const drop = Math.min(Math.floor(advanced), buffer.length);
    this.buffer = drop > 0 ? buffer.subarray(drop) : buffer;
    this.pos = advanced - drop;
    return out;
  }

  reset(): void {
    this.buffer = null;
    this.pos = 0;
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

  /**
   * F19：utterance 边界收尾——残余样本作为（可能短于 frameSamples 的）末帧发出并清空。
   * 不 flush 的话残余会串进下一句话的首帧（两次各 160 样本的 PTT，
   * 第二句开头会混入第一句的样本）。
   */
  flush(): ArrayBuffer[] {
    if (this.queued === 0) return [];
    const rest = new Float32Array(this.queued);
    let copied = 0;
    while (this.queue.length > 0) {
      const head = this.queue.shift() as Float32Array;
      rest.set(head, copied);
      copied += head.length;
    }
    this.queue = [];
    this.queued = 0;
    return [encodePcm16Frame(rest)];
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
    return encodePcm16Frame(frame);
  }
}

function encodePcm16Frame(frame: Float32Array): ArrayBuffer {
  const pcm = new DataView(new ArrayBuffer(frame.length * 2));
  for (let i = 0; i < frame.length; i++) {
    let s = frame[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    pcm.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return pcm.buffer;
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
