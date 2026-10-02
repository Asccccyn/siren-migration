/**
 * P0-3 / P0-4 客户端下行流路由：
 * - 新流开始清理旧流；旧流迟到 chunk 丢弃
 * - sequence duplicate 丢弃 / gap 记录但继续
 * - binary 与 header 配对（无 header 丢弃、bytes 不符丢弃、新 header 覆盖旧）
 * - pcm_end + 播放器 idle -> drained；interrupted 流不期待 drained
 */
import { describe, expect, it } from 'vitest';
import { StreamRouter, type PcmHeader } from '../apps/web/src/stream-router.ts';

interface Log {
  dropped: { reason: string; details: Record<string, unknown> }[];
  chunks: { streamId: string; sequence: number; rate: number }[];
  started: string[];
  ended: string[];
  drained: string[];
}

function buildRouter() {
  const log: Log = { dropped: [], chunks: [], started: [], ended: [], drained: [] };
  const router = new StreamRouter({
    onChunk: (buffer, header: PcmHeader) => log.chunks.push({
      streamId: header.stream_id,
      sequence: header.sequence,
      rate: header.rate
    }),
    onStreamStart: (id) => log.started.push(id),
    onStreamEnd: (id) => log.ended.push(id),
    onDrained: (id) => log.drained.push(id),
    onDropped: (reason, details) => log.dropped.push({ reason, details })
  });
  return { router, log };
}

function pcm(router: StreamRouter, streamId: string, sequence: number, rate = 24000, bytes = 4): void {
  router.handleJson({ t: 'pcm', stream_id: streamId, sequence, rate, bytes });
}

describe('StreamRouter（P0-3 stream identity / P0-4 drain）', () => {
  it('正常流：header+binary 配对通过，sequence 递增接受', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    pcm(router, 'out_a', 1);
    router.handleBinary(new ArrayBuffer(4));
    expect(log.chunks.map((c) => c.sequence)).toEqual([0, 1]);
    expect(log.dropped.length).toBe(0);
  });

  it('duplicate / stale sequence 丢弃', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    pcm(router, 'out_a', 0); // duplicate
    router.handleBinary(new ArrayBuffer(4));
    expect(log.chunks.length).toBe(1);
    expect(log.dropped.some((d) => d.reason === 'duplicate_or_stale_sequence')).toBe(true);
  });

  it('sequence gap：记录但继续播放（不杀通话）', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    pcm(router, 'out_a', 5); // gap
    router.handleBinary(new ArrayBuffer(4));
    expect(log.chunks.map((c) => c.sequence)).toEqual([0, 5]);
    expect(log.dropped.some((d) => d.reason === 'sequence_gap_continue')).toBe(true);
  });

  it('无 header 的 binary 丢弃；bytes 不符丢弃', () => {
    const { router, log } = buildRouter();
    router.handleBinary(new ArrayBuffer(4));
    expect(log.dropped.some((d) => d.reason === 'binary_without_header')).toBe(true);
    pcm(router, 'out_a', 0, 24000, 100);
    router.handleBinary(new ArrayBuffer(4)); // bytes 不符
    expect(log.dropped.some((d) => d.reason === 'bytes_mismatch')).toBe(true);
  });

  it('新 header 覆盖未消费旧 header（gap 记录）', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    pcm(router, 'out_a', 1); // 旧 header 未消费被覆盖
    expect(log.dropped.some((d) => d.reason === 'header_overwritten')).toBe(true);
    router.handleBinary(new ArrayBuffer(4));
    expect(log.chunks.map((c) => c.sequence)).toEqual([1]);
  });

  it('新流开始：onStreamStart 触发；旧流迟到 chunk 丢弃', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    pcm(router, 'out_b', 0); // 新流
    expect(log.started).toContain('out_b');
    router.handleBinary(new ArrayBuffer(4)); // 属于 out_b，正常
    expect(log.chunks.at(-1)?.streamId).toBe('out_b');
    // 旧流 out_a 迟到
    pcm(router, 'out_a', 1);
    router.handleBinary(new ArrayBuffer(4));
    expect(log.dropped.some((d) => d.reason === 'stale_stream_chunk')).toBe(true);
  });

  it('pcm_end + 播放器 idle -> drained（且只触发一次）', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    router.handleJson({ t: 'pcm_end', stream_id: 'out_a' });
    expect(log.ended).toEqual(['out_a']);
    router.notifyStreamIdle('out_a');
    router.notifyStreamIdle('out_a'); // 幂等
    expect(log.drained).toEqual(['out_a']);
  });

  it('end 前播完（缓存已空）-> end 到达即 idle 判 drained', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    router.notifyStreamIdle('out_a'); // 先播完（未 end，不 drain）
    expect(log.drained.length).toBe(0);
    router.handleJson({ t: 'pcm_end', stream_id: 'out_a' });
    expect(log.drained).toEqual(['out_a']);
  });

  it('interrupted 流永久失效：迟到 chunk 丢弃，且不期待 drained', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    router.handleJson({ t: 'interrupted', stream_id: 'out_a' });
    pcm(router, 'out_a', 1); // 旧流复活尝试
    router.handleBinary(new ArrayBuffer(4));
    expect(log.chunks.length).toBe(1); // 只放行第一块
    router.handleJson({ t: 'pcm_end', stream_id: 'out_a' });
    router.notifyStreamIdle('out_a');
    expect(log.drained.length).toBe(0); // 被打断的流不 drained
  });

  it('旧流的 pcm_end 被忽略（不影响当前流）', () => {
    const { router, log } = buildRouter();
    pcm(router, 'out_a', 0);
    router.handleBinary(new ArrayBuffer(4));
    pcm(router, 'out_b', 0);
    router.handleBinary(new ArrayBuffer(4));
    router.handleJson({ t: 'pcm_end', stream_id: 'out_a' });
    expect(log.ended.length).toBe(0);
    router.notifyStreamIdle('out_a');
    expect(log.drained.length).toBe(0);
  });
});
