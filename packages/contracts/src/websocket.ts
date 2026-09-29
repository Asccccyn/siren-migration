/**
 * 实时通话 WebSocket 协议（规范第 18 节 / v1.1 协议版本 2）。
 * 服务端与浏览器共享的消息合同；文本帧为 JSON，音频为二进制 PCM16。
 *
 * 协议 v2 新增：
 * - 下行音频 Stream Identity：每个 TTS 输出流独立 output_stream_id + 递增 sequence，
 *   每个二进制帧前都有 JSON 头（{t:'pcm', stream_id, sequence, rate, bytes}），
 *   binary 与 stream_id/sequence 的对应不依赖猜测（P0-3）
 * - playback_drained：客户端真正播完该流后 ACK（P0-4）
 * - ready 能力协商：客户端上报 capabilities，服务端回报协议版本与音频约定（P1-7）
 */
import { z } from 'zod';
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

/** 当前协议版本 */
export const WS_PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Client -> Server（文本帧）
// ---------------------------------------------------------------------------

/** 客户端能力上报（ready 帧；未知能力服务端忽略） */
export interface ClientWsCapabilities {
  playback_drain?: boolean;
  stream_identity?: boolean;
  local_barge_in?: boolean;
}

export type ClientWsMessage =
  | { t: 'ready'; protocol?: number; capabilities?: ClientWsCapabilities }
  | { t: 'start' }
  | { t: 'end' }
  | { t: 'abort' }
  | { t: 'ping' }
  | { t: 'playback_drained'; stream_id: string };

// ---------------------------------------------------------------------------
// 客户端消息运行时校验（审计 F02：JSON.parse 成功 ≠ 合法消息，
// `null` / 数字 / 缺字段对象曾直接打穿 handleMessage 导致进程退出）
// ---------------------------------------------------------------------------

const clientCapabilitiesSchema = z
  .object({
    playback_drain: z.boolean().optional(),
    stream_identity: z.boolean().optional(),
    local_barge_in: z.boolean().optional()
  })
  .passthrough();

const clientWsMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('ready'),
    protocol: z.number().optional(),
    capabilities: clientCapabilitiesSchema.optional()
  }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('end') }),
  z.object({ t: z.literal('abort') }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('playback_drained'), stream_id: z.string().min(1).max(256) })
]);

/** 校验客户端文本帧；不合法返回 null（调用方只应关闭当前连接，绝不冒泡异常） */
export function parseClientWsMessage(value: unknown): ClientWsMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const parsed = clientWsMessageSchema.safeParse(value);
  return parsed.success ? (parsed.data as ClientWsMessage) : null;
}

// ---------------------------------------------------------------------------
// Server -> Client（文本帧）
// ---------------------------------------------------------------------------

/** ready 应答：协议版本 + 音频约定（rate 为期望值；每块真实 rate 以 pcm 头为准） */
export interface WsAudioContract {
  input_rate: number;
  output_rate: number;
  format: 'pcm16';
}

export type ServerWsMessage =
  | { t: 'ready'; protocol: number; audio: WsAudioContract }
  | { t: 'partial'; text: string }
  | { t: 'asr'; text: string; language?: string; durationMs?: number }
  | { t: 'state'; state: CallState }
  | { t: 'reply'; text: string; emotion?: SirenEmotion }
  | { t: 'pcm'; stream_id: string; sequence: number; rate: number; bytes: number }
  | { t: 'pcm_end'; stream_id: string }
  | { t: 'interrupted'; stream_id?: string }
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
