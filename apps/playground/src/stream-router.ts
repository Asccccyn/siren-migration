/**
 * 下行音频流路由（P0-3/P0-4 的客户端策略层，纯逻辑、可在 Node 测试）。
 *
 * 职责：
 * - 维护 activeOutputStreamId：新流开始时清旧流；旧流迟到 chunk 直接丢弃
 * - 「JSON header + next binary」配对：binary 无 header 丢弃；新 header 覆盖
 *   未消费的旧 header（记 gap）；bytes 不符丢弃
 * - sequence 检测：<= last 视为 duplicate/stale 丢弃；> last+1 记 gap 但继续
 *   （单块丢包不杀整通电话）
 * - pcm_end + 该流全部 source 播完后触发 onDrained（由播放器回调驱动）
 * - interrupted(stream_id)：该流永久失效（不允许复活），取消 drained 期待
 */
export interface PcmHeader {
  stream_id: string;
  sequence: number;
  rate: number;
  bytes: number;
}

export interface StreamRouterDeps {
  /** 校验通过的 chunk 交给播放器 */
  onChunk: (buffer: ArrayBuffer, header: PcmHeader) => void;
  /** 新输出流开始（清理旧播放队列 / 重置时间轴） */
  onStreamStart: (streamId: string, rate: number) => void;
  /** 服务端宣告该流发送完毕（等待播完） */
  onStreamEnd: (streamId: string) => void;
  /** 该流已真正播完（pcm_end + 播放器确认无残留 source） */
  onDrained: (streamId: string) => void;
  onDropped: (reason: string, details: Record<string, unknown>) => void;
}

export class StreamRouter {
  private activeStreamId: string | null = null;
  private pendingHeader: PcmHeader | null = null;
  private readonly lastSequence = new Map<string, number>();
  /** 曾出现过的流 id：用于区分「新流」与「旧流迟到」 */
  private readonly seenStreams = new Set<string>();
  private readonly endedStreams = new Set<string>();
  /** 播放器已确认播空（尚未收到 end）的流 */
  private readonly idleStreams = new Set<string>();
  private readonly cancelledStreams = new Set<string>();
  private readonly drainedStreams = new Set<string>();

  constructor(private readonly deps: StreamRouterDeps) {}

  get activeStream(): string | null {
    return this.activeStreamId;
  }

  /** 服务端文本帧中与下行流相关的部分；返回是否被本路由消费 */
  handleJson(message: Record<string, unknown>): boolean {
    switch (message.t) {
      case 'pcm':
        this.acceptHeader({
          stream_id: String(message.stream_id ?? ''),
          sequence: Number(message.sequence ?? 0),
          rate: Number(message.rate ?? 24000),
          bytes: Number(message.bytes ?? 0)
        });
        return true;
      case 'pcm_end':
        this.endStream(String(message.stream_id ?? ''));
        return true;
      case 'interrupted':
        this.cancelStream(typeof message.stream_id === 'string' ? message.stream_id : undefined);
        return true;
      default:
        return false;
    }
  }

  /** 二进制帧：必须紧随其 header，且属于当前活跃流 */
  handleBinary(buffer: ArrayBuffer): void {
    const header = this.pendingHeader;
    this.pendingHeader = null;
    if (!header) {
      this.deps.onDropped('binary_without_header', { bytes: buffer.byteLength });
      return;
    }
    if (this.cancelledStreams.has(header.stream_id)) {
      this.deps.onDropped('cancelled_stream_chunk', { stream_id: header.stream_id, sequence: header.sequence });
      return;
    }
    if (header.stream_id !== this.activeStreamId) {
      this.deps.onDropped('stale_stream_chunk', { stream_id: header.stream_id, sequence: header.sequence });
      return;
    }
    if (buffer.byteLength !== header.bytes) {
      this.deps.onDropped('bytes_mismatch', {
        stream_id: header.stream_id,
        expected: header.bytes,
        actual: buffer.byteLength
      });
      return;
    }
    const last = this.lastSequence.get(header.stream_id);
    if (last !== undefined) {
      if (header.sequence <= last) {
        this.deps.onDropped('duplicate_or_stale_sequence', {
          stream_id: header.stream_id,
          sequence: header.sequence,
          last
        });
        return;
      }
      if (header.sequence > last + 1) {
        this.deps.onDropped('sequence_gap_continue', {
          stream_id: header.stream_id,
          expected: last + 1,
          got: header.sequence
        });
        // gap 只记录，继续播放
      }
    }
    this.lastSequence.set(header.stream_id, header.sequence);
    this.idleStreams.delete(header.stream_id);
    this.deps.onChunk(buffer, header);
  }

  /** 播放器通知：某流已无待播节点；若 end 已收到则判 drained */
  notifyStreamIdle(streamId: string): void {
    if (this.canDrain(streamId)) {
      this.markDrained(streamId);
      return;
    }
    this.idleStreams.add(streamId);
  }

  /** 连接关闭等场景：取消所有 drain 期待 */
  reset(): void {
    this.pendingHeader = null;
    this.seenStreams.clear();
    this.endedStreams.clear();
    this.idleStreams.clear();
    this.cancelledStreams.clear();
    this.drainedStreams.clear();
    this.lastSequence.clear();
    this.activeStreamId = null;
  }

  private acceptHeader(header: PcmHeader): void {
    if (!header.stream_id) {
      this.deps.onDropped('header_missing_stream_id', { header });
      return;
    }
    if (this.pendingHeader) {
      this.deps.onDropped('header_overwritten', { previous: this.pendingHeader });
    }
    if (this.cancelledStreams.has(header.stream_id)) {
      // 被打断的旧流不允许复活：吞掉配对 binary
      this.pendingHeader = header;
      return;
    }
    if (header.stream_id !== this.activeStreamId) {
      if (this.seenStreams.has(header.stream_id)) {
        // 旧流迟到的 header：不切换 active，配对 binary 将按 stale 丢弃
        this.deps.onDropped('stale_stream_header', { stream_id: header.stream_id });
        this.pendingHeader = header;
        return;
      }
      this.seenStreams.add(header.stream_id);
      this.deps.onStreamStart(header.stream_id, header.rate);
      this.activeStreamId = header.stream_id;
    }
    this.pendingHeader = header;
  }

  private endStream(streamId: string): void {
    if (streamId !== this.activeStreamId) return; // 旧流的 end 忽略
    this.endedStreams.add(streamId);
    this.deps.onStreamEnd(streamId);
    // 播放器可能早已播空（缓存为空）：直接进入 drained 判定
    if (this.idleStreams.has(streamId) && this.canDrain(streamId)) {
      this.markDrained(streamId);
    }
  }

  private cancelStream(streamId: string | undefined): void {
    const target = streamId ?? this.activeStreamId;
    if (target) {
      this.cancelledStreams.add(target);
      this.endedStreams.delete(target);
      this.idleStreams.delete(target);
    }
  }

  private canDrain(streamId: string): boolean {
    return (
      this.endedStreams.has(streamId) &&
      !this.cancelledStreams.has(streamId) &&
      !this.drainedStreams.has(streamId)
    );
  }

  private markDrained(streamId: string): void {
    this.endedStreams.delete(streamId);
    this.idleStreams.delete(streamId);
    this.drainedStreams.add(streamId);
    this.deps.onDrained(streamId);
  }
}
