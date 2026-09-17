/**
 * Realtime Voice Provider 边界（P1-1，参考 Qwen Audio Agent 的 Provider 思想）。
 *
 * Siren v1.1 的默认实现是 cascade（Streaming ASR -> Peer Core -> Streaming TTS），
 * 用 CascadeRealtimeProvider（voice-core）表达。未来实验 Qwen / OpenAI / Gemini
 * 等 speech-to-speech realtime 模型时，只需提供新的 RealtimeVoiceProvider 实现。
 *
 * 边界约束：
 * - 采样率契约显式声明（input/output），调用方不得假设
 * - CoreBridge / conversation 所有权永远不在 Realtime Provider 手里：
 *   provider 只负责「音频进 / 音频出」，人格、记忆、上下文真源仍是Peer Core
 * - 本轮只留接口，不接入任何第三方 speech-to-speech SDK
 */
import type {
  AsrStream,
  AsrStreamHandlers,
  PcmChunk,
  StreamAsrOptions,
  StreamAsrProvider,
  TtsProvider,
  TtsRequest
} from './voice.ts';

export interface RealtimeVoiceProvider extends StreamAsrProvider {
  readonly name: string;
  /** 上行（用户麦克风 -> Siren）PCM16 采样率 */
  readonly inputSampleRate: number;
  /** 下行（Siren -> 用户扬声器）期望采样率；每个 chunk 的真实 rate 以 PcmChunk 为准 */
  readonly outputSampleRate: number;
  /** 下行 TTS 能力（cascade 实现为组合的 TtsProvider；S2S provider 也需提供） */
  readonly tts: TtsProvider;
}

/** 便捷类型：cascade 组合件的输入 */
export interface CascadeVoiceComponents {
  asr: StreamAsrProvider;
  tts: TtsProvider;
}

export type { AsrStream, AsrStreamHandlers, PcmChunk, StreamAsrOptions, TtsProvider, TtsRequest };
