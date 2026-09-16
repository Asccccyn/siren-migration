/**
 * 火山引擎流式 ASR（v2 sauc）二进制协议封装。
 * 帧格式：[4 字节大端 header 长度][header JSON][音频 payload]
 * 首帧 sequence=1 携带完整请求头，末帧 sequence=-1。
 * 所有 Provider 细节都收敛在此文件，业务层不得感知（规范第 7 节）。
 */

export interface VolcAsrStreamConfig {
  appId: string;
  accessToken: string;
  /** 如 volc.bigasr.sauc.duration */
  cluster: string;
  wsUrl: string;
  sampleRate: number;
  language?: string;
  connectTimeoutMs: number;
}

export interface VolcAsrResponse {
  reqid?: string;
  code: number;
  message?: string;
  sequence?: number;
  result?: {
    text?: string;
    utterances?: { text?: string; definite?: boolean }[];
  };
}

/** 组装首帧（full request）header JSON */
export function buildFullRequestHeader(config: VolcAsrStreamConfig, requestId: string): Buffer {
  const header = {
    app: {
      appid: config.appId,
      token: config.accessToken,
      cluster: config.cluster
    },
    user: {
      uid: 'siren'
    },
    audio: {
      format: 'pcm',
      rate: config.sampleRate,
      bits: 16,
      channel: 1,
      codec: 'raw'
    },
    request: {
      reqid: requestId,
      nbest: 1,
      workflow: 'audio_in,resample,partition,vad,fe,dc,itn,nlu,ssu',
      show_language: false,
      show_utterances: true,
      result_type: 'single',
      sequence: 1
    }
  };
  return Buffer.from(JSON.stringify(header), 'utf8');
}

/** 组装一帧上行消息 */
export function encodeFrame(headerJson: Buffer | null, payload: Buffer, sequence: number): Buffer {
  const headerBytes = headerJson ?? Buffer.from('{}', 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(headerBytes.length, 0);
  const header = headerJson
    ? applySequence(headerBytes, sequence)
    : headerBytes;
  return Buffer.concat([size, header, payload]);
}

function applySequence(headerJson: Buffer, sequence: number): Buffer {
  const parsed = JSON.parse(headerJson.toString('utf8')) as {
    request: { sequence: number };
  };
  parsed.request.sequence = sequence;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/** 解析一帧下行消息 */
export function decodeFrame(data: Buffer): VolcAsrResponse {
  const headerSize = data.readUInt32BE(0);
  const headerJson = data.subarray(4, 4 + headerSize).toString('utf8');
  return JSON.parse(headerJson) as VolcAsrResponse;
}

export const VOLC_ASR_SUCCESS_CODE = 1000;
