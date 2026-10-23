import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatencyTracker } from '@siren/telemetry';

afterEach(() => vi.restoreAllMocks());

describe('independent audit: trustworthy server latency', () => {
  it('an inverted interval is unknown, never fabricated as zero latency', () => {
    const tracker = new LatencyTracker();
    tracker.mark('speech_end', 1000);
    tracker.mark('content_audio_play_request', 999);
    expect(tracker.compute().first_content_audio_ms).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejects a nonfinite mark %s', (value) => {
    expect(() => new LatencyTracker().mark('speech_end', value)).toThrow(RangeError);
  });

  it('uses a monotonic clock independent of wall-clock adjustments', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(500).mockReturnValueOnce(525);
    const tracker = new LatencyTracker();
    tracker.mark('speech_end');
    tracker.mark('content_audio_play_request');
    expect(tracker.compute().first_content_audio_ms).toBe(25);
    expect(clock).toHaveBeenCalledTimes(2);
  });
});
