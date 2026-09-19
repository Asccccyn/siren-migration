/**
 * 火山引擎双向流式 TTS（/api/v3/tts/bidirection）二进制协议封装。
 * 对齐官方文档（豆包语音 6561/1329505 & 2532486，2026-09 核对）：
 *
 * 帧 = [4B header][event 4B BE][连接/会话 id][payload size 4B][payload]
 *   byte0: (version 0b0001 << 4) | (header size 0b0001) = 0x11
 *   byte1: (message type << 4) | 0b0100(带 event 序号)
 *     - full client request  0b0001 -> 0x14
 *     - full server response 0b1001 -> 0x94
 *     - audio only response  0b1011 -> 0xB4（TTSResponse 音频）
 *     - error                0b1111 -> 0xF4
 *   byte2: (serialization 0b0001 JSON << 4) | (compression 0b0000 none / 0b0001 gzip)
 *   byte3: reserved
 * 连接级事件（StartConnection 等）不带 session id；会话级带 [sid size][sid]。
 * JSON 不压缩（serialization=JSON, compression=none），音频 payload 为原始字节。
 */
import { gunzipSync } from 'node:zlib';

export const EVENT = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  START_SESSION: 100,
  /** 取消会话（barge-in）：服务端停止合成并回 SessionCanceled(151)，区别于 FinishSession(102) */
  CANCEL_SESSION: 101,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_CANCELED: 151,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TASK_REQUEST: 200,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352
} as const;

const VERSION = 0x01;
const HEADER_SIZE = 0x01;
const MSG_FULL_CLIENT_REQUEST = 0x01;
const MSG_AUDIO_ONLY_RESPONSE = 0x0b;
const MSG_ERROR = 0x0f;
const FLAG_WITH_EVENT = 0x04;
const SERIAL_NONE = 0x00;
const SERIAL_JSON = 0x01;
const COMPRESS_NONE = 0x00;
const COMPRESS_GZIP = 0x01;

/** 客户端上行帧：JSON payload 不压缩（与官方 demo 一致） */
export function encodeClientEventFrame(event: number, sessionId: string | null, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const sid = sessionId ? Buffer.from(sessionId, 'utf8') : null;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length, 0);
  const parts: Buffer[] = [
    Buffer.from([
      (VERSION << 4) | HEADER_SIZE,
      (MSG_FULL_CLIENT_REQUEST << 4) | FLAG_WITH_EVENT,
      (SERIAL_JSON << 4) | COMPRESS_NONE,
      0x00
    ]),
    int32(event)
  ];
  if (sid) {
    parts.push(int32(sid.length), sid);
  }
  parts.push(size, json);
  return Buffer.concat(parts);
}

export type BidirectionServerFrame =
  | { kind: 'connection-event'; event: number; connectionId: string; payload: unknown }
  | { kind: 'session-event'; event: number; sessionId: string; payload: unknown }
  | { kind: 'session-audio'; event: number; sessionId: string; audio: Buffer }
  | { kind: 'error'; code: number; message: string };

/** 解析服务端下行帧（处理 gzip 压缩 payload） */
export function decodeServerFrame(data: Buffer): BidirectionServerFrame {
  if (data.length < 4) throw new Error('tts frame too short');
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;

  if (messageType === MSG_ERROR) {
    let offset = 4;
    const code = data.readInt32BE(offset);
    offset += 4;
    const messageSize = flags === FLAG_WITH_EVENT ? data.readUInt32BE(offset) : 0;
    offset += 4;
    return {
      kind: 'error',
      code,
      message: data.subarray(offset, offset + messageSize).toString('utf8') || 'unknown error'
    };
  }

  if (flags !== FLAG_WITH_EVENT) throw new Error('tts frame without event number');
  let offset = 4;
  const event = data.readInt32BE(offset);
  offset += 4;

  // 连接级事件：[conn id size][conn id][payload size][payload]
  if (event === EVENT.CONNECTION_STARTED || event === EVENT.CONNECTION_FAILED || event === EVENT.CONNECTION_FINISHED) {
    const connectionId = readLengthPrefixedString(data, offset);
    offset = connectionId.next;
    const payload = readPayload(data, offset, serialization, compression);
    return { kind: 'connection-event', event, connectionId: connectionId.value, payload: payload.value };
  }

  // 会话级事件：[sid size][sid][payload size][payload]
  const session = readLengthPrefixedString(data, offset);
  offset = session.next;
  if (messageType === MSG_AUDIO_ONLY_RESPONSE) {
    // 音频事件（352）：payload 为原始字节
    const size = data.readUInt32BE(offset);
    const audio = data.subarray(offset + 4, offset + 4 + size);
    return { kind: 'session-audio', event, sessionId: session.value, audio };
  }
  const payload = readPayload(data, offset, serialization, compression);
  return { kind: 'session-event', event, sessionId: session.value, payload: payload.value };
}

function readPayload(
  data: Buffer,
  offset: number,
  serialization: number,
  compression: number
): { value: unknown; next: number } {
  if (offset + 4 > data.length) return { value: null, next: offset };
  const size = data.readUInt32BE(offset);
  let raw = data.subarray(offset + 4, offset + 4 + size);
  if (compression === COMPRESS_GZIP) {
    raw = gunzipSync(raw);
  }
  if (serialization === SERIAL_NONE) return { value: raw, next: offset + 4 + size };
  const text = raw.toString('utf8');
  let value: unknown = text;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { value, next: offset + 4 + size };
}

function readLengthPrefixedString(data: Buffer, offset: number): { value: string; next: number } {
  if (offset + 4 > data.length) return { value: '', next: offset };
  const size = data.readUInt32BE(offset);
  const value = data.subarray(offset + 4, offset + 4 + size).toString('utf8');
  return { value, next: offset + 4 + size };
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}
