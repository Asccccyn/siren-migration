/**
 * PCM pre-roll ring buffer（P0-1 客户端首音保护）。
 *
 * 持续采集的 16kHz Float32 样本始终写入环形缓冲；VAD 确认 start 的瞬间
 * drain() 出最近 N ms（默认 400ms = 6400 samples @16k），随 {"t":"start"}
 * 一起发送，保证 VAD 判定窗口（约 confirmMs）内的句首音频不丢。
 *
 * 消费边界：当前采样块先 push 进 pre-roll 再做 VAD 判定，start 时 drain()
 * 的内容已包含当前块 —— 调用方该块不得再次直发，避免重复帧。
 * （服务端 asr-prebuffer 是建连期保护，与本模块互补，两者缺一不可。）
 */
export class AudioPreRollBuffer {
  private readonly ring: Float32Array;
  private writePos = 0;
  private filled = 0;

  constructor(capacitySamples: number) {
    if (!Number.isFinite(capacitySamples) || capacitySamples <= 0) {
      throw new Error(`pre-roll capacity must be positive, got ${capacitySamples}`);
    }
    this.ring = new Float32Array(Math.ceil(capacitySamples));
  }

  get capacity(): number {
    return this.ring.length;
  }

  /** 已缓冲样本数 */
  get length(): number {
    return this.filled;
  }

  /** 毫秒换算（按 16kHz） */
  get bufferedMs(): number {
    return (this.filled / 16000) * 1000;
  }

  /** 写入一段样本；超出容量时只保留最新数据（覆盖最旧） */
  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    if (samples.length >= this.ring.length) {
      // 整段比缓冲还大：只留尾部
      const tail = samples.subarray(samples.length - this.ring.length);
      this.ring.set(tail, 0);
      this.writePos = 0;
      this.filled = this.ring.length;
      return;
    }
    const headLen = Math.min(samples.length, this.ring.length - this.writePos);
    this.ring.set(samples.subarray(0, headLen), this.writePos);
    const remainder = samples.length - headLen;
    if (remainder > 0) {
      this.ring.set(samples.subarray(headLen), 0);
    }
    this.writePos = (this.writePos + samples.length) % this.ring.length;
    this.filled = Math.min(this.filled + samples.length, this.ring.length);
  }

  /** 按写入顺序取出全部缓冲样本，并清空缓冲 */
  drain(): Float32Array {
    const out = new Float32Array(this.filled);
    if (this.filled === this.ring.length) {
      // 满：从 writePos（最旧）开始
      const tail = this.ring.subarray(this.writePos);
      out.set(tail, 0);
      out.set(this.ring.subarray(0, this.writePos), tail.length);
    } else if (this.filled > 0) {
      out.set(this.ring.subarray(0, this.filled));
    }
    this.clear();
    return out;
  }

  clear(): void {
    this.writePos = 0;
    this.filled = 0;
  }
}
