/**
 * 浏览器端第一层 VAD（规范第 21 节）：RMS + 自适应噪声基线。
 * 纯逻辑、无 DOM，参数由调用方注入（页面输入框实时可调）。
 */

export interface VadParams {
  /** 确认讲话（ms） */
  confirmMs: number;
  /** 最短有效语音（ms） */
  minSpeechMs: number;
  /** 结束静音（ms） */
  endSilenceMs: number;
  /** RMS 相对噪声基线的倍数 */
  rmsRatio: number;
}

export type VadOutcome =
  | { event: 'none' }
  | { event: 'start' }
  | { event: 'end'; spokenMs: number };

const INITIAL_NOISE_FLOOR = 0.005;

export class VadMachine {
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private speechStartAt = 0;
  private utteranceStartAt = 0;
  private lastVoiceAt = 0;
  private inSpeech = false;
  private lastRms = 0;

  constructor(
    private readonly getParams: () => VadParams,
    private readonly now: () => number = () => performance.now()
  ) {}

  get threshold(): number {
    return this.noiseFloor * this.getParams().rmsRatio;
  }

  get noiseFloorValue(): number {
    return this.noiseFloor;
  }

  get lastRmsValue(): number {
    return this.lastRms;
  }

  get isSpeaking(): boolean {
    return this.inSpeech;
  }

  process(samples: Float32Array): VadOutcome {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rmsValue = Math.sqrt(sum / samples.length);
    this.lastRms = rmsValue;
    const params = this.getParams();
    const threshold = this.noiseFloor * params.rmsRatio;
    const now = this.now();

    if (!this.inSpeech) {
      // 静音期自适应噪声基线（规范第 21 节）
      this.noiseFloor = this.noiseFloor * 0.98 + rmsValue * 0.02;
      if (rmsValue > threshold) {
        if (this.speechStartAt === 0) this.speechStartAt = now;
        if (now - this.speechStartAt >= params.confirmMs) {
          this.inSpeech = true;
          this.utteranceStartAt = this.speechStartAt;
          this.lastVoiceAt = now;
          return { event: 'start' };
        }
      } else {
        this.speechStartAt = 0;
      }
      return { event: 'none' };
    }

    if (rmsValue > threshold) {
      this.lastVoiceAt = now;
    }
    const silenceMs = now - this.lastVoiceAt;
    const spokenMs = this.lastVoiceAt - this.utteranceStartAt;
    if (silenceMs >= params.endSilenceMs) {
      this.inSpeech = false;
      this.speechStartAt = 0;
      return { event: 'end', spokenMs };
    }
    return { event: 'none' };
  }

  reset(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR;
    this.speechStartAt = 0;
    this.utteranceStartAt = 0;
    this.lastVoiceAt = 0;
    this.inSpeech = false;
  }
}
