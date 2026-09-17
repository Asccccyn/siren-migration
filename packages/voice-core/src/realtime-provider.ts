/**
 * CascadeRealtimeProvider（P1-1）：当前默认的 Realtime Voice 实现。
 *
 *   CallSession
 *   ├─ RealtimeVoiceProvider（本类，cascade）
 *   │  ├─ StreamingAsrProvider（火山 v3 sauc / ElevenLabs / mock）
 *   │  └─ StreamingTtsProvider（火山 v3 bidirection / mock）
 *   └─ CoreBridge（Peer Core，同一 conversation）
 *
 * 它是 CallCenter 装配会话时的唯一 Provider 出口：会话层从这个边界拿 ASR 会话、
 * TTS 流与采样率契约。未来替换为 speech-to-speech 模型（Qwen Realtime /
 * OpenAI Realtime / Gemini Live / 本地 S2S）时只换这里的实现，
 * CallSession / CoreBridge / conversation 所有权不动。
 */
import {
  REALTIME_INPUT_SAMPLE_RATE,
  REALTIME_OUTPUT_SAMPLE_RATE,
  type AsrStream,
  type AsrStreamHandlers,
  type RealtimeVoiceProvider,
  type StreamAsrOptions,
  type StreamAsrProvider,
  type TtsProvider
} from '@siren/contracts';

export interface CascadeRealtimeProviderDeps {
  name: string;
  asr: StreamAsrProvider;
  tts: TtsProvider;
  inputSampleRate?: number;
  outputSampleRate?: number;
}

export class CascadeRealtimeProvider implements RealtimeVoiceProvider {
  readonly name: string;
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  readonly tts: TtsProvider;
  private readonly asr: StreamAsrProvider;

  constructor(deps: CascadeRealtimeProviderDeps) {
    this.name = deps.name;
    this.asr = deps.asr;
    this.tts = deps.tts;
    this.inputSampleRate = deps.inputSampleRate ?? REALTIME_INPUT_SAMPLE_RATE;
    this.outputSampleRate = deps.outputSampleRate ?? REALTIME_OUTPUT_SAMPLE_RATE;
  }

  createStream(options: StreamAsrOptions, handlers: AsrStreamHandlers): Promise<AsrStream> {
    return this.asr.createStream(options, handlers);
  }
}
