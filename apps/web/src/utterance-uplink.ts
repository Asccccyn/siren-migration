/**
 * 上行 utterance 编排（客户端纯逻辑，可测试）。
 *
 * 数据流（16kHz Float32）：
 *   采集块 -> [vad 模式且未发送时] pre-roll 环形缓冲
 *          -> VAD 判定
 *          -> start：flush pre-roll（含当前块）+ 开始分帧上行
 *          -> 正在发送：当前块直接分帧上行（start 块已随 flush 消费，不重复发）
 *
 * 半双工合同（对讲机模型，v2）：
 * - 仅在服务端 listening 状态采信麦克风（VAD start -> 上行）。
 * - AI 活跃（thinking/speaking）期间 VAD 触发一律吞掉：不上行、不自动打断。
 *   动机：① 播放走 WebAudio 通道，浏览器 AEC 参考信号覆盖不到，外放回声必然
 *   误触发 VAD（P0-4）；② 自动打断路径是实测故障区（打断后紧接轮次 100% 空转写），
 *   收敛掉整条交互线（1002 定案）。
 * - 句首始终留在 pre-roll：AI 回 listening 时用户仍在说话则自动接上，不丢句首。
 * - 想中途打断：UI 手动打断（状态徽章点击）直接发 abort——不经 VAD，
 *   服务端 handleAbort 机制保留专供手动打断与协议层使用。
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
      this.deps.sendJson({ t: 'end' });
      this.deps.log?.('切换模式，结束当前 utterance -> end');
    }
    this.mode = mode;
    // S1011-005：被吞的输入意图不跨模式存活——切 PTT 后未按键不得恢复上行
    this.suppressedByAi = false;
    this.deps.preRoll.clear();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      // S1011-005：静音撤销一切待恢复的输入意图
      this.suppressedByAi = false;
      this.deps.preRoll.clear(); // 静音期间不积累，避免解除静音后送出旧音频
      if (this.sending) {
        this.sending = false;
        this.flushFramerTail(); // F19：静音断句同样先发残余
        this.deps.sendJson({ t: 'end' });
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
  handleSamples(samples: Float32Array): void {
    if (this.muted || samples.length === 0) return;
    if (this.mode === 'ptt') {
      if (this.sending) this.sendFrames(samples);
      return;
    }
    if (!this.sending) {
      // pre-roll 先收当前块再判定：start 时的 drain 必然包含本块
      this.deps.preRoll.push(samples);
    }
    const outcome = this.deps.vad.process(samples);
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
    if (this.sending) return;
    this.sending = true;
    this.deps.preRoll.clear();
    this.deps.sendJson({ t: 'start' });
    this.deps.log?.('PTT: start');
  }

  endPtt(): void {
    if (!this.sending) return;
    this.sending = false;
    this.flushFramerTail(); // F19：PTT 结束把不满一帧的残余发出，不串入下一轮
    this.deps.sendJson({ t: 'end' });
    this.deps.log?.('PTT: end');
  }

  /** teardown 时复位 */
  reset(): void {
    this.sending = false;
    this.suppressedByAi = false;
    this.vadSpeech = false;
    this.deps.preRoll.clear();
    this.deps.framer.reset();
  }

  private handleVadStart(): boolean {
    // 半双工门控：AI 活跃（thinking/speaking）期间不采信 VAD——不上行、不自动打断。
    // 回声与误触发在这条线上整个消失；句首留在 pre-roll。
    if (this.deps.isAiActive()) {
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
    this.deps.sendJson({ t: 'start' });
    this.deps.log?.(`VAD: 说话开始 -> start（pre-roll ${Math.round(this.deps.preRoll.bufferedMs)}ms）`);
    // flush pre-roll：包含 confirm 窗口内的句首 + 当前块
    this.sendFrames(this.deps.preRoll.drain());
  }

  private handleVadEnd(outcome: VadOutcome): void {
    if (outcome.event !== 'end') return;
    if (!this.sending) return;
    this.sending = false;
    this.flushFramerTail(); // F19：静音断句前发出尾帧残余
    this.deps.sendJson({ t: 'end' });
    this.deps.log?.(`VAD: 静音断句 -> end（spoken ${Math.round(outcome.spokenMs)}ms）`);
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
