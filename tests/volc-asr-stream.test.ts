/**
 * 火山大模型流式 ASR v3（P0-8）：本地假火山服务器（真 WebSocket）验证
 * 握手 headers、首帧 full request、分批上行、末包 last-packet、
 * partial 更新 / final 只提交一次 / duplicate final 不重复拼接 / abort / socket close。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { gunzipSync, gzipSync } from 'node:zlib';
import { VolcStreamAsrProvider } from '@siren/provider-volc-asr';
import type { VolcAsrStreamConfig } from '@siren/provider-volc-asr';
import { createLogger } from '@siren/telemetry';

const logger = createLogger({ level: 'error', sink: () => undefined });

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

/** 服务端 full response：header + sequence + payload size + gzip JSON */
function serverResult(sequence: number, payload: unknown): Buffer {
  const json = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.concat([
    Buffer.from([0x11, sequence < 0 ? 0x93 : 0x91, 0x11, 0x00]),
    int32(sequence),
    int32(json.length),
    json
  ]);
}

interface ServerScript {
  /** 收到末包后先回什么 */
  finals?: { text: string; definite: boolean }[][];
  closeOnLast?: boolean;
}

function startFakeServer(script: ServerScript): Promise<{
  port: number;
  close: () => Promise<void>;
  seen: {
    headers: Record<string, string>;
    firstRequest: Record<string, unknown> | null;
    audioFrames: number;
    lastFrameHeader: number;
  };
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const seen = {
      headers: {} as Record<string, string>,
      firstRequest: null as Record<string, unknown> | null,
      audioFrames: 0,
      lastFrameHeader: 0x00
    };
    wss.on('connection', (socket: WebSocket, request) => {
      seen.headers = request.headers as Record<string, string>;
      socket.on('message', (data) => {
        const frame = Buffer.from(data as Buffer);
        const messageType = frame[1] >> 4;
        if (messageType === 0x01) {
          const size = frame.readUInt32BE(4);
          seen.firstRequest = JSON.parse(gunzipSync(frame.subarray(8, 8 + size)).toString('utf8'));
          return;
        }
        if (messageType === 0x02) {
          if ((frame[1] & 0x0f) === 0x02) {
            // last packet
            seen.lastFrameHeader = frame[1];
            if (script.closeOnLast) {
              socket.close();
              return;
            }
            const batches = script.finals ?? [[{ text: '你好。', definite: true }]];
            let sequence = 1;
            for (const batch of batches) {
              sequence += 1;
              socket.send(
                serverResult(sequence, {
                  result: { text: batch.map((u) => u.text).join(''), utterances: batch }
                })
              );
            }
            socket.send(serverResult(-1, { result: { text: '' } })); // 末包
          } else {
            seen.audioFrames++;
          }
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

const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

function provider(port: number): VolcStreamAsrProvider {
  const config: VolcAsrStreamConfig = {
    appId: 'app-1',
    accessToken: 'token-1',
    resourceId: 'volc.bigasr.sauc.duration',
    wsUrl: `ws://127.0.0.1:${port}`,
    sampleRate: 16000,
    connectTimeoutMs: 3000
  };
  return new VolcStreamAsrProvider(config, logger);
}

const PCM = Buffer.alloc(3200, 1); // 100ms

describe('VolcStreamAsrProvider（P0-8 v3 重写）', () => {
  it('完整 utterance：header 鉴权 + 首帧请求 + 分批上行 + last packet + final', async () => {
    const server = await startFakeServer({});
    servers.push(server);
    const asr = provider(server.port);

    const partials: string[] = [];
    const stream = await asr.createStream(
      { language: 'zh-CN' },
      { onPartial: (text) => partials.push(text) }
    );
    stream.feed(PCM);
    stream.feed(PCM);
    const result = await stream.end();

    expect(server.seen.headers['x-api-app-key']).toBe('app-1');
    expect(server.seen.headers['x-api-access-key']).toBe('token-1');
    expect(server.seen.headers['x-api-resource-id']).toBe('volc.bigasr.sauc.duration');
    expect(server.seen.headers['x-api-connect-id']).toBeTruthy();
    expect(server.seen.firstRequest).toMatchObject({
      audio: { format: 'pcm', rate: 16000 },
      request: { show_utterances: true }
    });
    // 100ms 批量上行：2 块 100ms PCM 立即发 1 帧 + end 时 flush 剩余
    expect(server.seen.audioFrames).toBeGreaterThanOrEqual(2);
    expect(server.seen.lastFrameHeader & 0x0f).toBe(0x02); // last packet flag
    expect(result.text).toBe('你好。');
    expect(result.language).toBe('zh-CN');
  });

  it('partial 覆盖式更新；definite final 只提交一次（重复 final 不重复拼接）', async () => {
    const server = await startFakeServer({
      finals: [
        [{ text: '嗯，', definite: false }],
        [{ text: '嗯，我在', definite: false }],
        [{ text: '嗯，我在听。', definite: true }],
        [{ text: '嗯，我在听。', definite: true }] // 服务端重复下发 definite
      ]
    });
    servers.push(server);
    const asr = provider(server.port);
    const partials: string[] = [];
    const stream = await asr.createStream({ language: 'zh-CN' }, { onPartial: (t) => partials.push(t) });
    stream.feed(PCM);
    const result = await stream.end();
    expect(partials).toEqual(['嗯，', '嗯，我在']);
    expect(result.text).toBe('嗯，我在听。'); // 不重复
  });

  it('abort：pending final 被拒绝', async () => {
    const server = await startFakeServer({
      finals: [[{ text: '不应出现', definite: true }]]
    });
    servers.push(server);
    const asr = provider(server.port);
    const stream = await asr.createStream({}, {});
    stream.feed(PCM);
    const pending = stream.end();
    stream.abort();
    await expect(pending).rejects.toThrowError(/abort/i);
  });

  it('socket 提前关闭：end() 采用已有结果兜底', async () => {
    const server = await startFakeServer({ closeOnLast: true });
    servers.push(server);
    const asr = provider(server.port);
    const stream = await asr.createStream({}, {});
    stream.feed(PCM);
    const result = await stream.end(); // 服务端直接 close，不回 final
    expect(result.text).toBe(''); // 明确无结果，不猜内容
  });
});
