import { describe, expect, it } from 'vitest';
import { JitteredPcmPlayer } from '../apps/web/src/pcm-player.ts';

function playerHarness() {
  const sources: { started: number; onended: (() => void) | null; stopped: boolean }[] = [];
  const ctx = {
    currentTime: 1, destination: {},
    createBuffer: (_channels: number, n: number, rate: number) => ({ duration: n / rate, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => {
      const source = { started: 0, onended: null as (() => void) | null, stopped: false,
        connect() {}, start(at: number) { source.started = at; }, stop() { source.stopped = true; } };
      sources.push(source);
      return source;
    }
  };
  const drained: string[] = [];
  return { ctx, sources, drained, player: new JitteredPcmPlayer(ctx as unknown as AudioContext, () => 350, id => drained.push(id)) };
}

describe('client-observed playback progress', () => {
  it('excludes jitter wait and freezes partial playback at interruption, even before onended', () => {
    const h = playerHarness();
    h.player.feed(new ArrayBuffer(96000), 24000, 'out'); // two seconds
    expect(h.player.playedMs('out')).toBe(0);
    h.ctx.currentTime = 2.35;
    expect(h.player.playedMs('out')).toBeCloseTo(1000);
    h.player.cancelStream('out');
    h.ctx.currentTime = 5;
    expect(h.player.playedMs('out')).toBeCloseTo(1000);
    h.sources[0].onended?.();
    expect(h.player.playedMs('out')).toBeCloseTo(1000);
    expect(h.drained).toEqual([]);
  });

  it('does not count a scheduling gap or double-count completed spans', () => {
    const h = playerHarness();
    h.player.feed(new ArrayBuffer(48000), 24000, 'out');
    h.ctx.currentTime = 2.35;
    h.sources[0].onended?.();
    expect(h.player.playedMs('out')).toBeCloseTo(1000);
    h.ctx.currentTime = 3;
    h.player.feed(new ArrayBuffer(48000), 24000, 'out');
    expect(h.player.playedMs('out')).toBeCloseTo(1000);
    h.ctx.currentTime = 3.85;
    expect(h.player.playedMs('out')).toBeCloseTo(1500);
    h.ctx.currentTime = 4.35;
    h.player.markStreamEnd('out'); h.sources[1].onended?.();
    expect(h.player.playedMs('out')).toBeCloseTo(2000);
    expect(h.drained).toEqual(['out']);
  });
});
