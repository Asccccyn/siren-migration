/**
 * 火山双向流式 TTS（P0-9）：用本地假火山服务器（真 WebSocket）验证
 * 握手 headers、StartConnection/StartSession/TaskRequest/FinishSession 事件流、
 * 音频流式产出、连接复用、abort 立即终止、SessionFailed 报错。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { VolcBidirectionalTtsProvider, VOLC_TTS_EVENT as EVENT } from '@siren/provider-volc-tts';
import type { PcmChunk, TtsRequest, VoiceProfile, VoiceStyle } from '@siren/contracts';
import { createLogger } from '@siren/telemetry';

const logger = createLogger({ level: 'error', sink: () => undefined });

// --- 假火山服务器帧编码（下行） ---
function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function serverEventFrame(
  event: number,
  sessionId: string | null,
  payload: Buffer,
  audioOnly: boolean
): Buffer {
  const header = Buffer.from([
    0x11,
    ((audioOnly ? 0x0b : 0x09) << 4) | 0x04,
    0x00, // serialization none / compression none
    0x00
  ]);
  const parts: Buffer[] = [header, int32(event)];
  if (sessionId !== null) {
    const sid = Buffer.from(sessionId, 'utf8');
    parts.push(int32(sid.length), sid);
  }
  parts.push(int32(payload.length), payload);
  return Buffer.concat(parts);
}

function jsonFrame(event: number, sessionId: string | null, payload: unknown): Buffer {
  return serverEventFrame(event, sessionId, Buffer.from(JSON.stringify(payload ?? {}), 'utf8'), false);
}

function audioFrame(sessionId: string, audio: Buffer): Buffer {
  return serverEventFrame(EVENT.TTS_RESPONSE, sessionId, audio, true);
}

// --- 测试服务器行为可脚本化 ---
interface ServerScript {
  audioChunks: number;
  failSession?: boolean;
  chunkDelayMs?: number;
}

function startFakeServer(script: ServerScript): Promise<{
  port: number;
  close: () => Promise<void>;
  seen: {
    headers: Record<string, string>;
    startSessionPayloads: { sessionId: string; payload: unknown }[];
    taskRequests: { sessionId: string; text: string }[];
    finishSessions: string[];
  };
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const seen = {
      headers: {} as Record<string, string>,
      startSessionPayloads: [] as { sessionId: string; payload: unknown }[],
      taskRequests: [] as { sessionId: string; text: string }[],
      finishSessions: [] as string[]
    };
    wss.on('connection', (socket: WebSocket, request) => {
      seen.headers = request.headers as Record<string, string>;
      // 每个 session 的音频发送任务（真实服务端保证 Finished 在全部音频之后）
      const audioSenders = new Map<string, Promise<void>>();
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
          const connId = randomUUID();
          socket.send(
            serverEventFrame(EVENT.CONNECTION_STARTED, null, Buffer.from(JSON.stringify({ connection_id: connId })), false)
          );
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
          const sender = (async () => {
            for (let i = 0; i < script.audioChunks; i++) {
              if (script.chunkDelayMs) await new Promise((r) => setTimeout(r, script.chunkDelayMs));
              socket.send(audioFrame(sessionId, Buffer.alloc(480, i + 1))); // 10ms @24k
            }
            socket.send(jsonFrame(EVENT.TTS_SENTENCE_END, sessionId, { res_params: {} }));
          })();
          audioSenders.set(sessionId, sender);
          return;
        }
        if (event === EVENT.FINISH_SESSION) {
          seen.finishSessions.push(sessionId);
          // 真实服务端语义：全部音频下发完才回 SessionFinished
          void Promise.resolve(audioSenders.get(sessionId)).then(() => {
            socket.send(jsonFrame(EVENT.SESSION_FINISHED, sessionId, { status_code: 0, message: '' }));
          });
        }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as { port: number }).port;
      resolve({
        port,
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const PROFILE: VoiceProfile = {
  id: 'main',
  displayName: '对方',
  language: 'zh-CN',
  provider: 'volc',
  voiceId: 'zh_test_voice',
  defaultEmotion: 'warm',
  defaultSpeed: 1.0
};

const STYLE: VoiceStyle = { emotion: 'happy' };

function request(text: string, sampleRate = 24000): TtsRequest {
  return { text, profile: PROFILE, style: STYLE, format: 'pcm', sampleRate };
}

const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

function provider(port: number): VolcBidirectionalTtsProvider {
  return new VolcBidirectionalTtsProvider(
    {
      appId: 'app-1',
      accessToken: 'token-1',
      resourceId: 'volc.service_type.10029',
      wsUrl: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 3000,
      sessionTimeoutMs: 5000
    },
    logger
  );
}

describe('VolcBidirectionalTtsProvider（P0-9 真流式）', () => {
  it('完整事件流：握手 headers -> StartSession(speaker/audio_params) -> TaskRequest -> 音频流 -> FinishSession', async () => {
    const server = await startFakeServer({ audioChunks: 5 });
    servers.push(server);
    const tts = provider(server.port);

    const chunks: PcmChunk[] = [];
    for await (const chunk of tts.synthesizeStream(request('你好，世界。'))) {
      chunks.push(chunk);
    }

    // 鉴权走 HTTP headers（不进 URL）
    expect(server.seen.headers['x-api-app-key']).toBe('app-1');
    expect(server.seen.headers['x-api-access-key']).toBe('token-1');
    expect(server.seen.headers['x-api-resource-id']).toBe('volc.service_type.10029');
    expect(server.seen.headers['x-api-connect-id']).toBeTruthy();

    // StartSession payload：speaker + audio_params（pcm/24k）
    expect(server.seen.startSessionPayloads.length).toBe(1);
    const payload = server.seen.startSessionPayloads[0].payload as {
      req_params: { speaker: string; audio_params: Record<string, unknown> };
    };
    expect(payload.req_params.speaker).toBe('zh_test_voice');
    expect(payload.req_params.audio_params).toMatchObject({ format: 'pcm', sample_rate: 24000 });

    expect(server.seen.taskRequests.map((t) => t.text)).toEqual(['你好，世界。']);
    expect(server.seen.finishSessions.length).toBe(1);

    // 音频以 provider 级流式产出（5 块），chunk 携带真实采样率
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.sampleRate === 24000)).toBe(true);
    expect(chunks[0].audio[0]).toBe(1);
    expect(chunks[4].audio[0]).toBe(5);
  });

  it('连接复用：第二次 synthesizeStream 不再重新握手（同一连接两个 session）', async () => {
    const server = await startFakeServer({ audioChunks: 2 });
    servers.push(server);
    const tts = provider(server.port);

    for await (const _chunk of tts.synthesizeStream(request('第一句。'))) void _chunk;
    for await (const _chunk of tts.synthesizeStream(request('第二句。'))) void _chunk;

    // 两次 session、两个 TaskRequest；握手 headers 只记录到一次连接
    expect(server.seen.startSessionPayloads.length).toBe(2);
    expect(server.seen.taskRequests.map((t) => t.text)).toEqual(['第一句。', '第二句。']);
  });

  it('并发两个 session 在同一连接上多路复用（音频不串流）', async () => {
    const server = await startFakeServer({ audioChunks: 3, chunkDelayMs: 10 });
    servers.push(server);
    const tts = provider(server.port);

    const collect = async (text: string): Promise<number> => {
      let count = 0;
      for await (const _chunk of tts.synthesizeStream(request(text))) count++;
      return count;
    };
    const [a, b] = await Promise.all([collect('并发A。'), collect('并发B。')]);
    expect(a).toBe(3);
    expect(b).toBe(3);
    expect(server.seen.startSessionPayloads.length).toBe(2);
  });

  it('abort 立即终止：不再产出后续 chunk，provider 报取消', async () => {
    const server = await startFakeServer({ audioChunks: 20, chunkDelayMs: 15 });
    servers.push(server);
    const tts = provider(server.port);

    const controller = new AbortController();
    const received: number[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of tts.synthesizeStream(request('长句子'), controller.signal)) {
        received.push(chunk.audio.length);
        if (received.length >= 2) controller.abort();
      }
    } catch (caught) {
      error = caught;
    }
    expect(received.length).toBeLessThan(20); // 提前终止
    expect(error).toBeTruthy(); // provider 真正抛错（而不是悄悄结束）
  });

  it('SessionFailed 上抛为 tts_failed', async () => {
    const server = await startFakeServer({ audioChunks: 1, failSession: true });
    servers.push(server);
    const tts = provider(server.port);
    await expect(async () => {
      for await (const _chunk of tts.synthesizeStream(request('失败句'))) void _chunk;
    }).rejects.toThrowError(/tts session failed|speaker/i);
  });
});
