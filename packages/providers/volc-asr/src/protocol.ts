/**
 * 火山引擎大模型流式 ASR v3（sauc/bigmodel）二进制协议封装。
 * 对齐官方文档（豆包语音 6561/1354869，2026-09 核对）：
 *
 * 帧 = [4B header][payload size(4B BE)][payload]
 *   byte0: (protocol version 0b0001 << 4) | (header size 0b0001) = 0x11
 *   byte1: (message type << 4) | flags
 *     - full client request 0b0001（首帧，payload 为 gzip JSON 请求）
 *     - audio only request   0b0010（flags: 0b0000 常规 / 0b0010 last packet）
 *     - full server response 0b1001（flags 0b0001 正序 / 0b0011 负序=末包）
 *     - error                0b1111
 *   byte2: (serialization 0b0001 JSON << 4) | (compression 0b0001 gzip)
 *   byte3: reserved
 * 服务端 full response 带 4B sequence（负值表示最后一包）。
 * 所有 Provider 细节收敛在此文件，业务层不得感知。
 */

export interface VolcAsrStreamConfig {
  appId: string;
  accessToken: string;
  /** 新版控制台单一 API Key（设置后握手走 X-Api-Key 单头） */
  apiKey?: string;
  /** 资源 ID，如 volc.bigasr.sauc.duration（Seed ASR 为 volc.seedasr.sauc.duration） */
  resourceId: string;
  /** 大模型流式端点：.../bigmodel（双向流式）| bigmodel_nostream | bigmodel_async */
  wsUrl: string;
  sampleRate: number;
  connectTimeoutMs: number;
}

import { gzipSync, gunzipSync } from 'node:zlib';

export interface VolcAsrResponse {
  audio_info?: { duration?: number };
  result?: {
    text?: string;
    utterances?: { text?: string; definite?: boolean; start_time?: number; end_time?: number }[];
  };
}

export interface VolcAsrErrorResponse {
  code: number;
  message: string;
}

/** header 各半字节常量 */
const VERSION = 0x01;
const HEADER_SIZE = 0x01;
const MSG_FULL_CLIENT_REQUEST = 0x01;
const MSG_AUDIO_ONLY_REQUEST = 0x02;
const MSG_FULL_SERVER_RESPONSE = 0x09;
const MSG_ERROR = 0x0f;
const FLAG_POSITIVE_SEQ = 0x01;
const FLAG_NEGATIVE_SEQ = 0x03;
const FLAG_LAST_PACKET = 0x02;
const SERIAL_JSON = 0x01;
const COMPRESS_GZIP = 0x01;

/** 首帧 full client request 的 JSON 请求体（gzip 后作 payload） */
export interface VolcAsrFullRequest {
  app: { appid: string; token: string };
  user: { uid: string };
  audio: {
    format: string;
    codec: string;
    rate: number;
    bits: number;
    channel: number;
    /** 多语种（bigmodel_nostream）时携带 */
    language?: string;
  };
  request: {
    reqid: string;
    workflow: string;
    show_utterances: boolean;
    result_type: string;
    sequence: number;
    end_window_size: number;
  };
}

/** 首帧 full client request（options 的 language/uid 真正进入请求，不忽略） */
export function buildFullRequest(
  config: VolcAsrStreamConfig,
  requestId: string,
  options: { language?: string; uid?: string } = {}
): Buffer {
  // v3 鉴权以握手 header 为准；首帧 app 字段为兼容保留——
  // 新版 API Key 模式下以 key 作为调用方标识填充
  const appIdentity = config.apiKey || config.appId;
  const appSecret = config.apiKey || config.accessToken;
  const full: VolcAsrFullRequest = {
    app: { appid: appIdentity, token: appSecret },
    user: { uid: options.uid ?? 'siren' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: config.sampleRate,
      bits: 16,
      channel: 1,
      ...(options.language && isMultilingualEndpoint(config.wsUrl) ? { language: options.language } : {})
    },
    request: {
      reqid: requestId,
      workflow: 'audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate',
      show_utterances: true,
      result_type: 'single',
      sequence: 1,
      end_window_size: 200
    }
  };
  return encodeFrame(headerByte(MSG_FULL_CLIENT_REQUEST, 0x00), Buffer.from(JSON.stringify(full), 'utf8'));
}

/** language 参数仅 bigmodel_nostream（多语种）端点有效（官方文档），其余端点不携带 */
export function isMultilingualEndpoint(wsUrl: string): boolean {
  return wsUrl.includes('nostream');
}

/** 常规音频帧（gzip PCM16） */
export function encodeAudioFrame(pcm: Buffer): Buffer {
  return encodeFrame(headerByte(MSG_AUDIO_ONLY_REQUEST, 0x00), pcm);
}

/** 末帧：audio only + last packet flag（payload 为 gzip 空数据） */
export function encodeLastAudioFrame(): Buffer {
  return encodeFrame(headerByte(MSG_AUDIO_ONLY_REQUEST, FLAG_LAST_PACKET), Buffer.alloc(0));
}

function headerByte(messageType: number, flags: number): number[] {
  return [
    (VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (SERIAL_JSON << 4) | COMPRESS_GZIP,
    0x00
  ];
}

function encodeFrame(header: number[], payload: Buffer): Buffer {
  const compressed = gzipSync(payload);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([Buffer.from(header), size, compressed]);
}

export type VolcAsrServerFrame =
  | { kind: 'result'; sequence: number; payload: VolcAsrResponse; isLast: boolean }
  | { kind: 'error'; code: number; message: string };

/** 解析服务端下行帧（压缩方式按帧头 compression 半字节判断：1=gzip，0=不压缩） */
export function decodeServerFrame(data: Buffer): VolcAsrServerFrame {
  if (data.length < 4) throw new Error('volc asr frame too short');
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  if (messageType === MSG_ERROR) {
    const code = data.readUInt32BE(4);
    const messageSize = data.readUInt32BE(8);
    const message = data.subarray(12, 12 + messageSize).toString('utf8');
    return { kind: 'error', code, message };
  }
  if (messageType !== MSG_FULL_SERVER_RESPONSE) {
    throw new Error(`unexpected volc asr message type 0x${messageType.toString(16)}`);
  }
  let offset = 4;
  let sequence = 0;
  if (flags === FLAG_POSITIVE_SEQ || flags === FLAG_NEGATIVE_SEQ) {
    sequence = data.readInt32BE(offset);
    offset += 4;
  }
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  const payloadBytes = data.subarray(offset, offset + payloadSize);
  // Seed-ASR 2.0 等新一代服务可能返回不压缩的 JSON 载荷（compression=0）
  const compression = data[2] & 0x0f;
  const json = (compression === COMPRESS_GZIP ? gunzipSync(payloadBytes) : payloadBytes).toString('utf8');
  return {
    kind: 'result',
    sequence,
    payload: JSON.parse(json) as VolcAsrResponse,
    isLast: sequence < 0 || flags === FLAG_NEGATIVE_SEQ
  };
}
