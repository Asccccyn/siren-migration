/**
 * 下行 PCM 播放器（规范第 17 节 / P0-4）：PCM16 chunk -> Web Audio 连续时间轴。
 * - nextAt 调度：首块加抖动缓冲（默认 350ms，可配置）
 * - interrupted / 新一轮 pcm 时清空队列
 * - stream 感知（P0-3/P0-4）：按 stream_id 跟踪已调度节点；
 *   收到 pcm_end 且该流 scheduled sources == 0 时回调 onStreamIdle，
 *   由 StreamRouter 判定 drained 并发送 playback_drained ACK
 */

interface StreamState {
  sources: Set<AudioBufferSourceNode>;
  ended: boolean;
  cancelled: boolean;
  drainedNotified: boolean;
}

export class JitteredPcmPlayer {
  private nextAt = 0;
  private readonly streams = new Map<string, StreamState>();
  private order: string[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly getJitterMs: () => number,
    private readonly onStreamIdle?: (streamId: string) => void
  ) {}

  /** 喂入一帧 PCM16 little-endian 二进制（属于 streamId 流，rate 为该 chunk 真实采样率） */
  feed(buffer: ArrayBuffer, rate: number, streamId: string): void {
    const view = new DataView(buffer);
    const sampleCount = Math.floor(view.byteLength / 2);
    if (sampleCount === 0) return;
    const state = this.stateOf(streamId);
    if (state.cancelled) return; // 已作废的流不再调度
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
    state.sources.add(source);
    source.onended = () => {
      state.sources.delete(source);
      this.maybeIdle(streamId, state);
    };
  }

  /** 新一轮 PCM 流：重置时间轴（StreamRouter 判定新流时调用） */
  resetTimeline(): void {
    this.nextAt = 0;
  }

  /** 服务端宣告流结束（pcm_end）：sources 已排空则立即 idle */
  markStreamEnd(streamId: string): void {
    const state = this.streams.get(streamId);
    if (!state || state.cancelled) return;
    state.ended = true;
    this.maybeIdle(streamId, state);
  }

  /** 该流被打断：立即停播且不再期待 drained */
  cancelStream(streamId: string | null): void {
    const targets = streamId ? [streamId] : [...this.streams.keys()];
    for (const id of targets) {
      const state = this.streams.get(id);
      if (!state) continue;
      state.cancelled = true;
      state.ended = false;
      this.stopSources(state);
    }
    this.nextAt = 0;
  }

  /** 立即停止全部已调度音频（interrupted / hangup 时调用） */
  stopAll(): void {
    this.cancelStream(null);
  }

  get scheduledCount(): number {
    let total = 0;
    for (const state of this.streams.values()) total += state.sources.size;
    return total;
  }

  private stateOf(streamId: string): StreamState {
    let state = this.streams.get(streamId);
    if (!state) {
      state = { sources: new Set(), ended: false, cancelled: false, drainedNotified: false };
      this.streams.set(streamId, state);
      this.order.push(streamId);
      // 只保留最近几个流的状态，防慢泄漏
      if (this.order.length > 8) {
        const evict = this.order.shift();
        if (evict) this.streams.delete(evict);
      }
    }
    return state;
  }

  /** end 已收到且该流全部节点播完 -> 通知 router（drained 判定在 router） */
  private maybeIdle(streamId: string, state: StreamState): void {
    if (state.cancelled || state.drainedNotified) return;
    if (!state.ended || state.sources.size > 0) return;
    state.drainedNotified = true;
    this.onStreamIdle?.(streamId);
  }

  private stopSources(state: StreamState): void {
    for (const source of [...state.sources]) {
      try {
        source.stop();
      } catch {
        // 已结束
      }
    }
    state.sources.clear();
  }
}
