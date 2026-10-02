/**
 * 上行 utterance 编排（P0-1 pre-roll / P0-2 本地 barge-in 的客户端逻辑，纯逻辑可测试）。
 *
 * 数据流（16kHz Float32）：
 *   采集块 -> [vad 模式且未发送时] pre-roll 环形缓冲
 *          -> VAD 判定
 *          -> start：本地 barge-in（若 AI 活跃）+ flush pre-roll（含当前块）
 *          -> 正在发送：当前块直接分帧上行（start 块已随 flush 消费，不重复发）
 *
 * 本地 barge-in（P0-2 第一层）：VAD 确认用户重新开口且 AI 处于 thinking/speaking
 * 时，先立即停播（onLocalBargeIn -> player.stopAll()），再发 {"t":"abort"}，
 * 不等服务端 interrupted 往返。interrupted 帧仍保留作最终确认/清理。
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
  /** AI 处于 thinking/speaking 时返回 true（由服务端 state 帧驱动） */
  isAiActive: () => boolean;
  /** 本地 barge-in：先于 abort 帧立即停播 */
  onLocalBargeIn?: () => void;
  log?: (message: string) => void;
}

export class UtteranceUplink {
  private mode: UplinkMode = 'vad';
  private muted = false;
  private sending = false;
  /** 一次 AI 轮次只发一次本地 abort；回 listening 后重新武装 */
  private bargeInArmed = true;

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
    this.deps.preRoll.clear();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.deps.preRoll.clear(); // 静音期间不积累，避免解除静音后送出旧音频
      if (this.sending) {
        this.sending = false;
        this.flushFramerTail(); // F19：静音断句同样先发残余
        this.deps.sendJson({ t: 'end' });
      }
    }
  }

  /** 服务端 state 帧驱动；回 listening/idle 时重新武装本地 barge-in */
  onServerState(state: string): void {
    if (state === 'listening' || state === 'idle' || state === 'interrupted') {
      this.bargeInArmed = true;
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
    this.bargeInArmed = true;
    this.deps.preRoll.clear();
    this.deps.framer.reset();
  }

  private handleVadStart(): boolean {
    // 本地 barge-in（P0-2）：AI 讲话/思考中用户重新开口 -> 立即停播 + abort
    if (this.deps.isAiActive() && this.bargeInArmed) {
      this.bargeInArmed = false;
      this.deps.onLocalBargeIn?.();
      this.deps.sendJson({ t: 'abort' });
      this.deps.log?.('本地 barge-in：立即停播 + abort（不等服务端往返）');
    }
    if (this.sending) return false; // 已在发送（如上一轮未收尾），当前块正常直发
    this.sending = true;
    this.deps.sendJson({ t: 'start' });
    this.deps.log?.(`VAD: 说话开始 -> start（pre-roll ${Math.round(this.deps.preRoll.bufferedMs)}ms）`);
    // flush pre-roll：包含 confirm 窗口内的句首 + 当前块
    this.sendFrames(this.deps.preRoll.drain());
    return true; // 当前块已消费，避免重复发送
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
