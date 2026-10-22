/**
 * Conservative residual-echo gate using the actual rendered playback reference.
 * Complements browser AEC; it is not a substitute for acoustic device validation.
 * A highly correlated reference is subtracted for detection only, so a weaker
 * near-end speaker is not discarded together with dominant echo. This simple
 * single-delay model is not a calibrated nonlinear/acoustic echo canceller.
 */
export class PlaybackEchoGuard {
  private readonly reference = new Float32Array(2048); // 512ms at 4kHz
  private readonly microphone = new Float32Array(128); // 32ms matching window
  private readonly fullReference = new Float32Array(8192);
  private fullHead = 0;
  private match: { lag: number; gain: number } | null = null;
  private refHead = 0;
  private micHead = 0;
  private refCount = 0;
  private micCount = 0;
  private phase = 0;
  private echo = false;
  private analysisSamples = 0;

  get suppressingEcho(): boolean { return this.echo; }

  /** 浸泡测试用：内部三个环形缓冲均为固定容量，此值不随处理时长增长 */
  get fixedBufferSamples(): number {
    return this.reference.length + this.fullReference.length + this.microphone.length;
  }

  /** Both inputs are synchronous 16kHz samples from the same AudioContext. */
  process(mic: Float32Array, rendered: Float32Array): Float32Array {
    for (let i = 0; i < mic.length; i++) {
      this.fullReference[this.fullHead] = rendered[i] ?? 0;
      this.fullHead = (this.fullHead + 1) % this.fullReference.length;
      if (this.phase++ % 4 !== 0) continue;
      this.reference[this.refHead] = rendered[i] ?? 0;
      this.refHead = (this.refHead + 1) % this.reference.length;
      this.refCount = Math.min(this.refCount + 1, this.reference.length);
      this.microphone[this.micHead] = mic[i];
      this.micHead = (this.micHead + 1) % this.microphone.length;
      this.micCount = Math.min(this.micCount + 1, this.microphone.length);
    }
    // AudioWorklet can deliver ~3ms blocks. Correlate at most once per 20ms,
    // instead of redoing the full lag search on every tiny callback.
    this.analysisSamples += mic.length;
    if (this.analysisSamples >= 320) {
      this.analysisSamples %= 320;
      this.match = this.estimateEcho();
      this.echo = this.match !== null;
    }
    if (!this.match) return mic;
    const { lag, gain } = this.match;
    return Float32Array.from(mic, (sample, i) => {
      const index = (this.fullHead - mic.length + i - lag * 4 + this.fullReference.length * 2) % this.fullReference.length;
      const residual = sample - gain * this.fullReference[index];
      return Math.abs(residual) < 1e-6 ? 0 : residual;
    });
  }

  reset(): void {
    this.reference.fill(0);
    this.microphone.fill(0);
    this.fullReference.fill(0);
    this.fullHead = 0;
    this.match = null;
    this.refHead = this.micHead = this.refCount = this.micCount = this.phase = 0;
    this.echo = false;
    this.analysisSamples = 0;
  }

  private estimateEcho(): { lag: number; gain: number } | null {
    const n = this.microphone.length;
    if (this.micCount < n || this.refCount < n) return null;
    let micEnergy = 0;
    for (let i = 0; i < n; i++) micEnergy += this.microphone[i] ** 2;
    if (micEnergy < 1e-7) return null;
    let bestScore = 0.9;
    let best: { lag: number; gain: number } | null = null;
    const maxLag = Math.min(1400, this.refCount - n); // up to 350ms acoustic/processing delay
    for (let lag = 0; lag <= maxLag; lag += 2) {
      let cross = 0;
      let refEnergy = 0;
      for (let i = 0; i < n; i++) {
        const r = this.reference[(this.refHead - n - lag + i + this.reference.length) % this.reference.length];
        const m = this.microphone[(this.micHead + i) % n];
        cross += r * m;
        refEnergy += r * r;
      }
      const score = refEnergy > 1e-6 ? cross * cross / (micEnergy * refEnergy) : 0;
      if (score > bestScore && Math.abs(cross / refEnergy) <= 8) {
        bestScore = score;
        best = { lag, gain: cross / refEnergy };
      }
    }
    return best;
  }
}
