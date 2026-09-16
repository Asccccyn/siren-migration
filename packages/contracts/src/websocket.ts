/**
 * 实时通话 WebSocket 协议（规范第 18 节）。
 * 服务端与浏览器共享的消息合同；文本帧为 JSON，音频为二进制 PCM16。
 */
import type { SirenEmotion } from './voice.ts';

/** Call 状态机（规范第 19 节） */
export type CallState =
  | 'idle'
  | 'listening'
  | 'ending'
  | 'thinking'
  | 'speaking'
  | 'interrupting'
  | 'ended'
  | 'error';

export const CALL_STATES: readonly CallState[] = [
  'idle',
  'listening',
  'ending',
  'thinking',
  'speaking',
  'interrupting',
  'ended',
  'error'
];

// ---------------------------------------------------------------------------
// Client -> Server（文本帧）
// ---------------------------------------------------------------------------

export type ClientWsMessage =
  | { t: 'ready' }
  | { t: 'start' }
  | { t: 'end' }
  | { t: 'abort' }
  | { t: 'ping' };

// ---------------------------------------------------------------------------
// Server -> Client（文本帧）
// ---------------------------------------------------------------------------

export type ServerWsMessage =
  | { t: 'partial'; text: string }
  | { t: 'asr'; text: string; language?: string; durationMs?: number }
  | { t: 'state'; state: CallState }
  | { t: 'reply'; text: string; emotion?: SirenEmotion }
  | { t: 'pcm'; rate: number }
  | { t: 'pcm_end' }
  | { t: 'interrupted' }
  | { t: 'metrics'; metrics: TurnLatencyMetrics }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };

/** 单轮延迟指标（规范第 39 节），随 metrics 帧下发给前端展示 */
export interface TurnLatencyMetrics {
  asr_latency_ms: number | null;
  llm_first_token_ms: number | null;
  tts_first_audio_ms: number | null;
  total_first_audio_ms: number | null;
  interrupted: boolean;
  filler_played: boolean;
}

/** WebSocket 关闭码约定 */
export const WS_CLOSE_CODES = {
  INVALID_TOKEN: 4001,
  SESSION_EXISTS: 4002,
  SERVER_SHUTDOWN: 4003,
  PROTOCOL_ERROR: 4004,
  BACKPRESSURE_OVERFLOW: 4005
} as const;
