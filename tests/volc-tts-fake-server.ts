/**
 * 火山双向流式 TTS 测试共享设施：假火山服务器（真 WebSocket）+ 帧编解码。
 * 服务端语义（v1.1.1）：CancelSession(101) 停止该 session 的音频生产并回
 * SessionCanceled(151)；FinishSession(102) 在全部音频下发完才回 SessionFinished(152)。
 */
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { VolcBidirectionalTtsProvider, VOLC_TTS_EVENT as EVENT } from '@siren/provider-volc-tts';
import type { TtsRequest, VoiceProfile, VoiceStyle } from '@siren/contracts';
import { createLogger } from '@siren/telemetry';

export const fakeServerLogger = createLogger({ level: 'error', sink: () => undefined });

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

export function serverEventFrame(
  event: number,
  sessionId: string | null,
  payload: Buffer,
  audioOnly: boolean
): Buffer {
  const header = Buffer.from([0x11, ((audioOnly ? 0x0b : 0x09) << 4) | 0x04, 0x00, 0x00]);
  const parts: Buffer[] = [header, int32(event)];
  if (sessionId !== null) {
    const sid = Buffer.from(sessionId, 'utf8');
    parts.push(int32(sid.length), sid);
  }
  parts.push(int32(payload.length), payload);
  return Buffer.concat(parts);
}

export function jsonFrame(event: number, sessionId: string | null, payload: unknown): Buffer {
  return serverEventFrame(event, sessionId, Buffer.from(JSON.stringify(payload ?? {}), 'utf8'), false);
}

export function audioFrame(sessionId: string, audio: Buffer): Buffer {
  return serverEventFrame(EVENT.TTS_RESPONSE, sessionId, audio, true);
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 轮询等待条件成立（回环 WebSocket 的事件到达存在微小时序差） */
export async function waitForSeen(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  if (!predicate()) throw new Error('waitForSeen timeout');
}

export interface ServerScript {
  audioChunks: number;
  failSession?: boolean;
  chunkDelayMs?: number;
  /** 收到 StartConnection 后不回 ConnectionStarted（测门控/超时清理） */
  noStartAck?: boolean;
  /** 收到 StartConnection 后延迟 N ms 才回 ConnectionStarted（测 dispose in-flight） */
  startAckDelayMs?: number;
}

export interface FakeServerHandle {
  port: number;
  close: () => Promise<void>;
  seen: {
    headers: Record<string, string>;
    connections: number;
    /** 客户端断开（主动 close 或被 terminate）计数 */
    clientCloses: number;
    startSessionPayloads: { sessionId: string; payload: unknown }[];
    taskRequests: { sessionId: string; text: string }[];
    finishSessions: string[];
    cancelSessions: string[];
    sessionCanceledAcks: string[];
    /** 服务端每 session 实际下发的音频 chunk 数（验证取消真的停止生产） */
    serverSentChunks: Map<string, number>;
  };
}

export function startFakeServer(script: ServerScript): Promise<FakeServerHandle> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const seen: FakeServerHandle['seen'] = {
      headers: {},
      connections: 0,
      clientCloses: 0,
      startSessionPayloads: [],
      taskRequests: [],
      finishSessions: [],
      cancelSessions: [],
      sessionCanceledAcks: [],
      serverSentChunks: new Map()
    };
    wss.on('connection', (socket: WebSocket, request) => {
      seen.connections++;
      seen.headers = request.headers as Record<string, string>;
      socket.on('close', () => {
        seen.clientCloses++;
      });
      // 每个 session 的发送状态：真实服务端在收到 CancelSession(101) 后
      // 停止该 session 的合成（sender 检查 cancelled 标志）
      const senderStates = new Map<string, { cancelled: boolean; finished: boolean }>();
      socket.on('message', (data) => {
        const frame = Buffer.from(data as Buffer);
        const event = frame.readInt32BE(4);
        let offset = 8;
        let sessionId: string | null = null;
        // 连接级事件（StartConnection/FinishConnection）不带 session id
        if (event !== EVENT.START_CONNECTION && event !== EVENT.FINISH_CONNECTION) {
          const sidLen = frame.readUInt32BE(offset);
          offset += 4;
          sessionId = frame.subarray(offset, offset + sidLen).toString('utf8');
          offset += sidLen;
        }
        const payloadLen = frame.readUInt32BE(offset);
        const payloadText = frame.subarray(offset + 4, offset + 4 + payloadLen).toString('utf8');

        if (event === EVENT.START_CONNECTION) {
          if (script.noStartAck) return; // 不回 ConnectionStarted（测门控/超时）
          const reply = (): void => {
            socket.send(
              serverEventFrame(
                EVENT.CONNECTION_STARTED,
                null,
                Buffer.from(JSON.stringify({ connection_id: randomUUID() })),
                false
              )
            );
          };
          if (script.startAckDelayMs) setTimeout(reply, script.startAckDelayMs);
          else reply();
          return;
        }
        if (sessionId === null) return;
        if (event === EVENT.START_SESSION) {
          seen.startSessionPayloads.push({ sessionId, payload: safeJson(payloadText) });
          if (script.failSession) {
            socket.send(jsonFrame(EVENT.SESSION_FAILED, sessionId, { status_code: 40000001, message: 'bad speaker' }));
            return;
          }
          socket.send(jsonFrame(EVENT.SESSION_STARTED, sessionId, {}));
          return;
        }
        if (event === EVENT.TASK_REQUEST) {
          const text = ((safeJson(payloadText) as { req_params?: { text?: string } }).req_params ?? {}).text ?? '';
          seen.taskRequests.push({ sessionId, text });
          socket.send(jsonFrame(EVENT.TTS_SENTENCE_START, sessionId, { res_params: {} }));
          const state = { cancelled: false, finished: false };
          senderStates.set(sessionId, state);
          void (async () => {
            for (let i = 0; i < script.audioChunks; i++) {
              if (script.chunkDelayMs) await new Promise((r) => setTimeout(r, script.chunkDelayMs));
              if (state.cancelled) return; // CancelSession：服务端停止生产
              seen.serverSentChunks.set(sessionId, (seen.serverSentChunks.get(sessionId) ?? 0) + 1);
              socket.send(audioFrame(sessionId, Buffer.alloc(480, i + 1))); // 10ms @24k
            }
            state.finished = true;
            socket.send(jsonFrame(EVENT.TTS_SENTENCE_END, sessionId, { res_params: {} }));
          })();
          return;
        }
        if (event === EVENT.FINISH_SESSION) {
          seen.finishSessions.push(sessionId);
          const state = senderStates.get(sessionId);
          if (state?.cancelled) return; // 已取消：由 CANCEL_SESSION 回 151
          // 真实服务端语义：全部音频下发完才回 SessionFinished
          const waitAndFinish = (attempts = 0): void => {
            if (state?.cancelled) return;
            if (state?.finished || attempts > 200) {
              socket.send(jsonFrame(EVENT.SESSION_FINISHED, sessionId, { status_code: 0, message: '' }));
              return;
            }
            setTimeout(() => waitAndFinish(attempts + 1), 10);
          };
          waitAndFinish();
          return;
        }
        if (event === EVENT.CANCEL_SESSION) {
          seen.cancelSessions.push(sessionId);
          const state = senderStates.get(sessionId);
          if (state) state.cancelled = true; // 停止该 session 的剩余音频生产
          seen.sessionCanceledAcks.push(sessionId);
          socket.send(jsonFrame(EVENT.SESSION_CANCELED, sessionId, { status_code: 0, message: '' }));
        }
      });
    });
    wss.on('listening', () => {
      resolve({
        port: (wss.address() as { port: number }).port,
        seen,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          })
      });
    });
  });
}

export const PROFILE: VoiceProfile = {
  id: 'main',
  displayName: '对方',
  language: 'zh-CN',
  provider: 'volc',
  voiceId: 'zh_test_voice',
  defaultEmotion: 'warm',
  defaultSpeed: 1.0
};

export const STYLE: VoiceStyle = { emotion: 'happy' };

export function request(text: string, sampleRate = 24000): TtsRequest {
  return { text, profile: PROFILE, style: STYLE, format: 'pcm', sampleRate };
}

export function makeProvider(
  port: number,
  overrides: { connectTimeoutMs?: number; sessionTimeoutMs?: number } = {}
): VolcBidirectionalTtsProvider {
  return new VolcBidirectionalTtsProvider(
    {
      appId: 'app-1',
      accessToken: 'token-1',
      resourceId: 'volc.service_type.10029',
      wsUrl: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 3000,
      sessionTimeoutMs: 5000,
      ...overrides
    },
    fakeServerLogger
  );
}
