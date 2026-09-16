/**
 * 下行 PCM 播放器（规范第 17 节）：PCM16 chunk -> Web Audio 连续时间轴。
 * - nextAt 调度：首块加抖动缓冲（默认 350ms，可配置）
 * - interrupted / 新一轮 pcm 时清空队列
 */

export class JitteredPcmPlayer {
  private nextAt = 0;
  private readonly sources: AudioBufferSourceNode[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly getJitterMs: () => number
  ) {}

  /** 喂入一帧 PCM16 little-endian 二进制 */
  feed(buffer: ArrayBuffer, rate: number): void {
    const view = new DataView(buffer);
    const sampleCount = Math.floor(view.byteLength / 2);
    if (sampleCount === 0) return;
    const audioBuffer = this.ctx.createBuffer(1, sampleCount, rate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextAt < now) {
      this.nextAt = now + this.getJitterMs() / 1000; // 首块抖动缓冲
    }
    source.start(this.nextAt);
    this.nextAt += audioBuffer.duration;
    this.sources.push(source);
    source.onended = () => {
      const index = this.sources.indexOf(source);
      if (index >= 0) this.sources.splice(index, 1);
    };
  }

  /** 新一轮 PCM 流：重置时间轴（服务端 {"t":"pcm"} 时调用） */
  resetTimeline(): void {
    this.nextAt = 0;
  }

  /** 立即停止全部已调度音频（interrupted / hangup 时调用） */
  stopAll(): void {
    for (const source of this.sources.splice(0)) {
      try {
        source.stop();
      } catch {
        // 已结束
      }
    }
    this.nextAt = 0;
  }

  get scheduledCount(): number {
    return this.sources.length;
  }
}
