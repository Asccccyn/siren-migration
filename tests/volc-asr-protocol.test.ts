/** 火山大模型流式 ASR v3 二进制协议编解码（P0-8） */
import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildFullRequest,
  decodeServerFrame,
  encodeAudioFrame,
  encodeLastAudioFrame,
  type VolcAsrStreamConfig
} from '@siren/provider-volc-asr';

const config: VolcAsrStreamConfig = {
  appId: 'app-1',
  accessToken: 'token-1',
  resourceId: 'volc.bigasr.sauc.duration',
  wsUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  sampleRate: 16000,
  connectTimeoutMs: 5000
};

function payloadOf(frame: Buffer): Buffer {
  const size = frame.readUInt32BE(4);
  return gunzipSync(frame.subarray(8, 8 + size));
}

describe('Volc ASR v3 协议（P0-8）', () => {
  it('首帧：full client request（0x11 header，gzip JSON，含 app/user/audio/request）', () => {
    const frame = buildFullRequest(config, 'req-1');
    expect(frame[0]).toBe(0x11); // version=1 | header size=1
    expect(frame[1] >> 4).toBe(0x01); // message type = full client request
    expect(frame[2]).toBe(0x11); // JSON + gzip
    const payload = JSON.parse(payloadOf(frame).toString('utf8')) as Record<string, unknown>;
    expect(payload.app).toEqual({ appid: 'app-1', token: 'token-1' });
    expect(payload.audio).toMatchObject({ format: 'pcm', rate: 16000, bits: 16, channel: 1 });
    expect(payload.request).toMatchObject({ reqid: 'req-1', show_utterances: true, sequence: 1 });
  });

  it('options 真正进入请求：uid / language（多语种端点）', () => {
    const multilingual: VolcAsrStreamConfig = {
      ...config,
      wsUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
    };
    const frame = buildFullRequest(multilingual, 'req-2', { language: 'en', uid: 'siren:main' });
    const payload = JSON.parse(payloadOf(frame).toString('utf8')) as {
      user: { uid: string };
      audio: { language?: string };
    };
    expect(payload.user.uid).toBe('siren:main');
    expect(payload.audio.language).toBe('en');
    // 中文 bigmodel 端点不携带 language
    const zhFrame = buildFullRequest(config, 'req-3', { language: 'en' });
    const zhPayload = JSON.parse(payloadOf(zhFrame).toString('utf8')) as { audio: { language?: string } };
    expect(zhPayload.audio.language).toBeUndefined();
  });

  it('音频帧：audio only（0x21），payload 为 gzip PCM', () => {
    const pcm = Buffer.alloc(3200, 1);
    const frame = encodeAudioFrame(pcm);
    expect(frame[1] >> 4).toBe(0x02); // audio only request
    expect(frame[1] & 0x0f).toBe(0x00); // 常规 flags
    const size = frame.readUInt32BE(4);
    expect(gunzipSync(frame.subarray(8, 8 + size))).toEqual(pcm);
  });

  it('末帧：audio only + last packet flag（0x22）', () => {
    const frame = encodeLastAudioFrame();
    expect(frame[1] >> 4).toBe(0x02);
    expect(frame[1] & 0x0f).toBe(0x02); // last packet
  });

  it('解析服务端 full response（带正序 sequence）', () => {
    const frame = serverFrame(0x91, 5, {
      result: { text: '你好', utterances: [{ text: '你好', definite: false }] }
    });
    const decoded = decodeServerFrame(frame);
    expect(decoded.kind).toBe('result');
    if (decoded.kind === 'result') {
      expect(decoded.sequence).toBe(5);
      expect(decoded.isLast).toBe(false);
      expect(decoded.payload.result?.text).toBe('你好');
    }
  });

  it('解析末包（负 sequence）与 error 帧', () => {
    const last = decodeServerFrame(serverFrame(0x93, -1, { result: { text: '你好。' } }));
    expect(last.kind === 'result' && last.isLast).toBe(true);
    const errorJson = Buffer.from(JSON.stringify({ error: 'bad' }), 'utf8');
    const errorFrame = Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x11, 0x00]),
      int32(45000001),
      int32(errorJson.length),
      errorJson
    ]);
    const decodedError = decodeServerFrame(errorFrame);
    expect(decodedError).toMatchObject({ kind: 'error', code: 45000001 });
  });
});

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

/** 构造服务端 full server response 帧：header + sequence + payload size + gzip JSON */
function serverFrame(byte1: number, sequence: number, payload: unknown): Buffer {
  const json = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return Buffer.concat([Buffer.from([0x11, byte1, 0x11, 0x00]), int32(sequence), int32(json.length), json]);
}
