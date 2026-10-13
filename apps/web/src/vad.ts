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
  | { event: 'end'; spokenMs: number; valid: boolean };

const INITIAL_NOISE_FLOOR = 0.005;
/** 噪声底自适应时间常数：平滑系数按块间隔换算（审计 F05），与回调频率无关 */
const NOISE_TAU_MS = 2000;

export class VadMachine {
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private speechStartAt: number | null = null;
  private utteranceStartAt = 0;
  private lastVoiceAt = 0;
  private inSpeech = false;
  private lastRms = 0;
  private lastNoiseUpdateAt = 0;
  private candidateParams: VadParams | null = null;

  constructor(
    private readonly getParams: () => VadParams,
    private readonly now: () => number = () => performance.now()
  ) {}

  get threshold(): number {
    return Math.max(0.003, this.noiseFloor * this.params().rmsRatio);
  }

  /** Candidate settings freeze until end; reserve a trigger block as well. */
  get requiredPreRollSamples(): number {
    return Math.ceil((Math.max(400, this.params().confirmMs + 80) * 16000) / 1000);
  }

  private params(): VadParams {
    if (this.candidateParams) return this.candidateParams;
    const raw = this.getParams();
    const bounded = (n: number, fallback: number, max: number) =>
      Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : fallback;
    return {
      confirmMs: bounded(raw.confirmMs, 200, 2000),
      minSpeechMs: bounded(raw.minSpeechMs, 400, 10000),
      endSilenceMs: bounded(raw.endSilenceMs, 700, 5000),
      rmsRatio: Math.max(1, bounded(raw.rmsRatio, 4, 20))
    };
  }

  get noiseFloorValue(): number {
    return this.noiseFloor;
  }

  get lastRmsValue(): number {
    return this.lastRms;
  }

  process(samples: Float32Array): VadOutcome {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rmsValue = Math.sqrt(sum / samples.length);
    this.lastRms = rmsValue;
    const params = this.params();
    const threshold = Math.max(0.003, this.noiseFloor * params.rmsRatio);
    const now = this.now();

    if (!this.inSpeech) {
      if (rmsValue > threshold) {
        // 候选语音（确认窗口内）：冻结噪声估计（审计 F05）——
        // 高频回调下继续学习会把噪声底追到语音电平，阈值随之抬到永远确认不了
        if (this.speechStartAt === null) {
          this.speechStartAt = now;
          this.candidateParams = params;
        }
        // Interrupt confirmation must not wait for the minimum completed utterance.
        if (now - this.speechStartAt >= params.confirmMs) {
          this.inSpeech = true;
          this.utteranceStartAt = this.speechStartAt;
          this.lastVoiceAt = now;
          return { event: 'start' };
        }
      } else {
        this.speechStartAt = null;
        this.candidateParams = null;
        // 静音期自适应噪声基线（规范第 21 节）；alpha 按真实块间隔归一化
        const dt = this.lastNoiseUpdateAt === 0 ? 0 : Math.max(0, now - this.lastNoiseUpdateAt);
        this.lastNoiseUpdateAt = now;
        const alpha = dt > 0 ? 1 - Math.exp(-dt / NOISE_TAU_MS) : 0;
        this.noiseFloor = this.noiseFloor * (1 - alpha) + rmsValue * alpha;
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
      this.speechStartAt = null;
      this.candidateParams = null;
      return { event: 'end', spokenMs, valid: spokenMs >= params.minSpeechMs };
    }
    return { event: 'none' };
  }

  reset(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR;
    this.speechStartAt = null;
    this.utteranceStartAt = 0;
    this.lastVoiceAt = 0;
    this.inSpeech = false;
    this.lastNoiseUpdateAt = 0;
    this.candidateParams = null;
  }
}
