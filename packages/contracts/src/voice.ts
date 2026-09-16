/**
 * Siren 语音领域核心协议。
 * 所有 Provider、业务层、传输层共享的类型都在这里定义，禁止散落复制。
 */

/** Siren 统一内部情绪枚举（规范第 9 节），Provider Adapter 负责映射到具体供应商参数 */
export const SIREN_EMOTIONS = [
  'neutral',
  'warm',
  'happy',
  'sad',
  'angry',
  'teasing',
  'sleepy',
  'excited',
  'surprised'
] as const;

export type SirenEmotion = (typeof SIREN_EMOTIONS)[number];

/** 统一 Voice Style */
export interface VoiceStyle {
  emotion: SirenEmotion;
  /** 情绪强度 0~1，Provider 可映射为 emotion_scale / style */
  intensity?: number;
  /** 语速，1.0 为正常 */
  speed?: number;
}

/** Provider 类型 */
export type ProviderKind = 'volc' | 'elevenlabs' | 'mock';

/** 语音档案（config/voices/*.json），Voice ID 只允许出现在配置里 */
export interface VoiceProfile {
  id: string;
  displayName: string;
  language: string;
  provider: ProviderKind;
  /** 供应商音色 ID；为空时回退到环境变量（如 VOLC_VOICE_ID） */
  voiceId: string;
  defaultEmotion: SirenEmotion;
  defaultSpeed: number;
  /** 情绪到供应商参数的覆盖映射（可选），结构由 Provider 自行解释 */
  emotionMap?: Partial<Record<SirenEmotion, Record<string, number | string>>>;
}

export type AudioFormat = 'mp3' | 'wav' | 'pcm';

/** 实时链路统一音频约束（规范第 16/17 节） */
export const REALTIME_INPUT_SAMPLE_RATE = 16000;
export const REALTIME_OUTPUT_SAMPLE_RATE = 24000;
export const PCM_BITS = 16;
export const PCM_CHANNELS = 1;

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsRequest {
  /** 用户可见文本（用于元数据） */
  text: string;
  /** 真正交给 TTS 的表达文本，缺省等于 text */
  ttsScript?: string;
  profile: VoiceProfile;
  style: VoiceStyle;
  format: AudioFormat;
  /** pcm 格式时的目标采样率 */
  sampleRate?: number;
  language?: string;
}

export interface TtsAudioResult {
  audio: Buffer;
  format: AudioFormat;
  sampleRate: number;
  durationMs: number;
}

export interface PcmChunk {
  audio: Buffer;
  sampleRate: number;
}

export interface BatchTtsProvider {
  /** 完整文字 -> 完整音频 */
  synthesize(request: TtsRequest): Promise<TtsAudioResult>;
}

export interface StreamTtsProvider {
  /** 一句文字 -> PCM chunk 流 */
  synthesizeStream(request: TtsRequest): AsyncIterable<PcmChunk>;
}

export interface TtsProvider extends BatchTtsProvider, StreamTtsProvider {}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

export interface BatchAudioInput {
  audio: Buffer;
  /** 音频容器/编码：webm / mp3 / wav / m4a ... */
  format: string;
  language?: string;
}

export interface TranscriptResult {
  text: string;
  language: string;
  durationMs: number;
}

export interface BatchAsrProvider {
  transcribe(input: BatchAudioInput): Promise<TranscriptResult>;
}

export interface StreamAsrOptions {
  language?: string;
  profile?: VoiceProfile;
}

export interface AsrStreamHandlers {
  onPartial?(text: string): void;
  onError?(error: unknown): void;
}

/**
 * 一次讲话（utterance）对应一个 ASR 会话。
 * feed 输入 PCM16/16kHz/mono；end 返回 final 结果。
 */
export interface AsrStream {
  feed(pcm: Buffer): void;
  end(): Promise<TranscriptResult>;
  abort(): void;
}

export interface StreamAsrProvider {
  createStream(options: StreamAsrOptions, handlers: AsrStreamHandlers): Promise<AsrStream>;
}

export interface AsrProvider extends BatchAsrProvider, StreamAsrProvider {}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'asr_failed'
  | 'tts_failed'
  | 'provider_unavailable'
  | 'invalid_audio'
  | 'provider_timeout';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  override readonly cause?: unknown;

  constructor(code: ProviderErrorCode, provider: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// 语音资产（voice_assets 表对应的领域记录，规范第 29 节）
// ---------------------------------------------------------------------------

export type VoiceDirection = 'user' | 'assistant';

export interface VoiceAssetRecord {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  direction: VoiceDirection;
  voiceProfile: string;
  provider: string;
  providerVoiceId: string | null;
  audioFormat: string;
  sampleRate: number;
  durationMs: number;
  language: string | null;
  emotion: string | null;
  text: string | null;
  ttsScript: string | null;
  transcript: string | null;
  objectKey: string;
  checksum: string | null;
  createdAt: number;
}

export interface VoiceAssetWithUrl extends VoiceAssetRecord {
  audioUrl: string;
}
