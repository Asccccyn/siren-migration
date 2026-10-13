/**
 * Utterance input ownership: retain candidate samples, confirm speech promptly,
 * then submit PCM once. Negotiated voice interruption uses the turn coordinator;
 * legacy peers retain explicit half-duplex/manual behavior.
 * minSpeech validates the completed utterance, not interruption response time.
 */
import type { VadMachine, VadOutcome } from './vad.ts';
import type { AudioPreRollBuffer } from './pre-roll-buffer.ts';
import type { Pcm16Framer } from './uplink-encoder.ts';

export type UplinkMode = 'vad' | 'ptt';

export interface UtteranceUplinkDeps {
  vad: VadMachine;
  preRoll: AudioPreRollBuffer;
  framer: Pcm16Framer;
  sendJson: (message: Record<string, unknown>) => void;
  sendFrame: (frame: ArrayBuffer) => void;
  /** AI 处于 thinking/speaking 时返回 true（由服务端 state 帧驱动）——半双工门控 */
  isAiActive: () => boolean;
  /** Negotiated identity/handoff support; absent means the legacy manual mode. */
  canInterrupt?: () => boolean;
  startInput?: () => void;
  finishInput?: (valid: boolean) => void;
  log?: (message: string) => void;
}

export class UtteranceUplink {
  private mode: UplinkMode = 'vad';
  private muted = false;
  private sending = false;
  /** AI 活跃期间吞掉的 VAD start，等回 listening 再决定是否接上 */
  private suppressedByAi = false;
  /** 最近一次 VAD 判定是否处于说话中（suppression 恢复用，与 sending 解耦） */
  private vadSpeech = false;

  constructor(private readonly deps: UtteranceUplinkDeps) {}

  get sendingActive(): boolean {
    return this.sending;
  }

  /** UI 调试信息（噪声基线 / 阈值 / 最新 RMS） */
  get vadStatus(): string {
    return `noise floor: ${this.deps.vad.noiseFloorValue.toFixed(5)} / thr: ${this.deps.vad.threshold.toFixed(5)} / rms: ${this.deps.vad.lastRmsValue.toFixed(5)}`;
  }

  setMode(mode: UplinkMode): void {
    if (this.mode === mode) return;
    if (this.sending) {
      this.sending = false;
      this.flushFramerTail(); // F19：模式切换前把当前句残余发出
      this.finishInput(true);
      this.deps.log?.('切换模式，结束当前 utterance -> end');
    }
    this.mode = mode;
    // S1011-005：被吞的输入意图不跨模式存活——切 PTT 后未按键不得恢复上行
    this.suppressedByAi = false;
    this.vadSpeech = false;
    this.deps.vad.reset();
    this.deps.preRoll.clear();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      // S1011-005：静音撤销一切待恢复的输入意图
      this.suppressedByAi = false;
      this.vadSpeech = false;
      this.deps.vad.reset();
      this.deps.preRoll.clear(); // 静音期间不积累，避免解除静音后送出旧音频
      if (this.sending) {
        this.sending = false;
        this.flushFramerTail(); // F19：静音断句同样先发残余
        this.finishInput(true);
      }
    }
  }

  /** 服务端 state 帧驱动；回 listening/idle 时若用户仍在说话则接上被吞的 utterance。
   * S1011-005：恢复是输入许可的综合判定——仅 VAD 模式、未静音、当前未在发送时才成立 */
  onServerState(state: string): void {
    if (state === 'listening' || state === 'idle' || state === 'interrupted') {
      if (this.suppressedByAi) {
        this.suppressedByAi = false;
        if (this.vadSpeech && this.mode === 'vad' && !this.muted && !this.sending) {
          // AI 结束时你还在说话：现在开始上行，pre-roll 里保留了句首
          this.beginSending();
          this.deps.log?.('半双工门控解除：恢复上行（句首来自 pre-roll）');
        }
      }
    }
  }

  /** 16kHz Float32 采样块入口（已重采样） */
  handleSamples(samples: Float32Array, detectionSamples = samples): void {
    if (this.muted || samples.length === 0) return;
    if (this.mode === 'ptt') {
      if (this.sending) this.sendFrames(samples);
      return;
    }
    if (!this.sending) {
      this.deps.preRoll.ensureCapacity(this.deps.vad.requiredPreRollSamples + samples.length);
      // pre-roll 先收当前块再判定：start 时的 drain 必然包含本块
      this.deps.preRoll.push(samples);
    }
    // The echo gate controls detection, not candidate retention: late near-end
    // confirmation must not erase the first microphone samples of the new word.
    const outcome = this.deps.vad.process(detectionSamples);
    if (outcome.event === 'start') {
      this.vadSpeech = true;
    } else if (outcome.event === 'end') {
      this.vadSpeech = false;
    }
    let consumedByFlush = false;
    if (outcome.event === 'start') {
      consumedByFlush = this.handleVadStart();
    } else if (outcome.event === 'end') {
      this.handleVadEnd(outcome);
    }
    if (this.sending && !consumedByFlush) {
      this.sendFrames(samples);
    }
  }

  // --- PTT 入口 ---
  startPtt(): void {
    if (this.sending || this.muted || this.mode !== 'ptt') return;
    if (this.deps.isAiActive() && !this.deps.canInterrupt?.()) return;
    this.sending = true;
    this.deps.preRoll.clear();
    this.startInput();
    this.deps.log?.('PTT: start');
  }

  endPtt(): void {
    if (!this.sending) return;
    this.sending = false;
    this.flushFramerTail(); // F19：PTT 结束把不满一帧的残余发出，不串入下一轮
    this.finishInput(true);
    this.deps.log?.('PTT: end');
  }

  /** teardown 时复位 */
  reset(): void {
    this.sending = false;
    this.suppressedByAi = false;
    this.vadSpeech = false;
    this.deps.preRoll.clear();
    this.deps.framer.reset();
    this.deps.vad.reset();
  }

  private handleVadStart(): boolean {
    // 旧服务端的显式兼容模式：不协商新合同就不自动打断。
    // 回声与误触发在这条线上整个消失；句首留在 pre-roll。
    if (this.deps.isAiActive() && !this.deps.canInterrupt?.()) {
      this.suppressedByAi = true;
      this.deps.log?.('AI 活跃（半双工）：忽略本次 VAD start，句首留在 pre-roll');
      return false;
    }
    if (this.sending) return false; // 已在发送（如上一轮未收尾），当前块正常直发
    this.beginSending();
    return true; // 当前块已消费，避免重复发送
  }

  /** 开始一次上行 utterance：start + flush pre-roll（句首保护） */
  private beginSending(): void {
    this.sending = true;
    this.startInput();
    this.deps.log?.(`VAD: 说话开始 -> start（pre-roll ${Math.round(this.deps.preRoll.bufferedMs)}ms）`);
    // flush pre-roll：包含 confirm 窗口内的句首 + 当前块
    this.sendFrames(this.deps.preRoll.drain());
  }

  private handleVadEnd(outcome: VadOutcome): void {
    if (outcome.event !== 'end') return;
    if (!this.sending) return;
    this.sending = false;
    this.flushFramerTail(); // F19：静音断句前发出尾帧残余
    this.finishInput(outcome.valid);
    this.deps.log?.(`VAD: 静音断句 -> end（spoken ${Math.round(outcome.spokenMs)}ms）`);
  }

  private startInput(): void {
    if (this.deps.startInput) this.deps.startInput();
    else this.deps.sendJson({ t: 'start' });
  }

  private finishInput(valid: boolean): void {
    if (this.deps.finishInput) this.deps.finishInput(valid);
    else this.deps.sendJson({ t: valid ? 'end' : 'abort' });
  }

  private sendFrames(samples: Float32Array): void {
    if (samples.length === 0) return;
    for (const frame of this.deps.framer.push(samples)) {
      this.deps.sendFrame(frame);
    }
  }

  /** utterance 收尾：framer 残余作为末帧直发（已是 PCM16 ArrayBuffer） */
  private flushFramerTail(): void {
    for (const frame of this.deps.framer.flush()) {
      this.deps.sendFrame(frame);
    }
  }
}
