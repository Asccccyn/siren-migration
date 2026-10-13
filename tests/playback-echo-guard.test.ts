import { describe, expect, it } from 'vitest';
import { PlaybackEchoGuard } from '../apps/web/src/playback-echo-guard.ts';

function fixture(length: number, seed: number): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state / 0x100000000) * 2 - 1) * 0.2;
  });
}

describe('render-reference echo gate (synthetic acoustic boundary, not device AEC)', () => {
  it('suppresses delayed, scaled playback but admits independent near-end/double-talk', () => {
    const echo = new PlaybackEchoGuard();
    const mixed = new PlaybackEchoGuard();
    const reference = fixture(16000, 1);
    const near = fixture(16000, 29);
    let echoSuppressed = 0;
    let doubleTalkAdmitted = 0;
    for (let at = 0; at < reference.length; at += 320) {
      const ref = reference.slice(at, at + 320);
      const mic = Float32Array.from(ref, (_, i) => (reference[at + i - 384] ?? 0) * 0.5);
      const both = Float32Array.from(mic, (v, i) => v + near[at + i]);
      const cleaned = echo.process(mic, ref);
      const accepted = mixed.process(both, ref);
      if (at > 1600) {
        if (cleaned.every((v) => v === 0)) echoSuppressed++;
        if (accepted === both) doubleTalkAdmitted++;
      }
    }
    expect(echoSuppressed).toBe(44);
    expect(doubleTalkAdmitted).toBe(44);
  });

  it('does not suppress speech without playback; reset forgets prior references', () => {
    const guard = new PlaybackEchoGuard();
    const mic = fixture(640, 8);
    expect(guard.process(mic, new Float32Array(640))).toBe(mic);
    guard.process(mic, mic);
    expect(guard.suppressingEcho).toBe(true);
    guard.reset();
    expect(guard.process(mic, new Float32Array(640))).toBe(mic);
  });

  it('retains weaker near-end residual instead of muting a dominant-echo window', () => {
    const guard = new PlaybackEchoGuard();
    const reference = fixture(16000, 1);
    const near = fixture(16000, 731);
    let expectedEnergy = 0;
    let residualEnergy = 0;
    for (let at = 0; at < reference.length; at += 320) {
      const ref = reference.slice(at, at + 320);
      const mic = Float32Array.from(ref, (_, i) => (reference[at + i - 384] ?? 0) * 0.8 + near[at + i] * 0.08);
      const residual = guard.process(mic, ref);
      if (at > 1600) {
        for (let i = 0; i < residual.length; i++) {
          expectedEnergy += (near[at + i] * 0.08) ** 2;
          residualEnergy += residual[i] ** 2;
        }
      }
    }
    expect(residualEnergy / expectedEnergy).toBeGreaterThan(0.8);
    expect(residualEnergy / expectedEnergy).toBeLessThan(1.3);
  });
});
