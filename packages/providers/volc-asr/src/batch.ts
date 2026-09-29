/**
 * 火山引擎大模型录音文件识别·极速版（POST /api/v3/auc/bigmodel/recognize/flash）。
 * 2026-09-27 审计 F06 修复：请求、鉴权、成功码、结果与时长解析统一为官方 v3
 * 极速版协议——此前请求是 v3 风格但成功码按 1000000/0 判、文本读 resp.text，
 * 与 v1 submit/query、v3 极速版两者都对不上。
 * 官方协议要点（docs 6561/1631584）：
 * - 鉴权走 X-Api-App-Key / X-Api-Access-Key（或新版单 X-Api-Key），无 Bearer 头
 * - 成败以响应头 X-Api-Status-Code 表意（HTTP 可能恒 200），成功=20000000
 * - 文本在 result.text；result.utterances[] 带 start_time/end_time（毫秒）
 */
import { randomUUID } from 'node:crypto';
import { ProviderError, type BatchAsrProvider, type BatchAudioInput, type TranscriptResult } from '@siren/contracts';

export interface VolcBatchAsrConfig {
  appId: string;
  accessToken: string;
  /** 新版控制台单一 API Key（设置后走 X-Api-Key 单头，优先于双件套） */
  apiKey?: string;
  /** 极速版资源 ID，如 volc.bigasr.auc_turbo */
  resourceId: string;
  endpointUrl: string;
  timeoutMs: number;
}

interface VolcFlashUtterance {
  text?: string;
  start_time?: number;
  end_time?: number;
}

interface VolcFlashResponse {
  result?: {
    text?: string;
    utterances?: VolcFlashUtterance[];
  };
}

/** 官方极速版成功状态码（响应头 X-Api-Status-Code） */
export const VOLC_FLASH_SUCCESS_STATUS = '20000000';

export class VolcBatchAsrProvider implements BatchAsrProvider {
  constructor(private readonly config: VolcBatchAsrConfig) {}

  async transcribe(input: BatchAudioInput): Promise<TranscriptResult> {
    if (input.audio.length === 0) {
      throw new ProviderError('invalid_audio', 'volc-asr', 'empty audio input');
    }
    const body = JSON.stringify({
      user: { uid: 'siren' },
      audio: {
        data: input.audio.toString('base64'),
        format: normalizeAudioFormat(input.format)
      },
      request: {
        model_name: 'bigmodel',
        show_utterances: true,
        enable_punc: true,
        enable_itn: true
      }
    });
    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 新版控制台单一 API Key -> X-Api-Key；旧版 -> 双件套（v3 官方两种鉴权并存）
        ...(this.config.apiKey
          ? { 'X-Api-Key': this.config.apiKey }
          : {
              'X-Api-App-Key': this.config.appId,
              'X-Api-Access-Key': this.config.accessToken
            }),
        'X-Api-Resource-Id': this.config.resourceId,
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Sequence': '-1'
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });
    if (!response.ok) {
      throw new ProviderError('asr_failed', 'volc-asr', `asr http ${response.status}`);
    }
    // 官方以响应头状态码表意：HTTP 200 不代表成功
    const statusCode = response.headers.get('x-api-status-code') ?? '';
    if (statusCode !== VOLC_FLASH_SUCCESS_STATUS) {
      const apiMessage = response.headers.get('x-api-message') ?? '';
      throw new ProviderError(
        'asr_failed',
        'volc-asr',
        `asr status=${statusCode || 'missing'} ${apiMessage}`.trim()
      );
    }
    const payload = (await response.json().catch(() => null)) as VolcFlashResponse | null;
    const result = payload?.result;
    // ASR 失败必须明确报错，禁止猜测内容（规范第 40 节）
    if (!result) {
      throw new ProviderError('asr_failed', 'volc-asr', 'asr returned empty payload');
    }
    const text = (result.text ?? result.utterances?.map((u) => u.text ?? '').join('') ?? '').trim();
    const durationMs = result.utterances?.reduce(
      (max, u) => Math.max(max, Number.isFinite(u.end_time) ? Number(u.end_time) : 0),
      0
    );
    return {
      text,
      language: input.language ?? 'zh-CN',
      durationMs: Math.round(durationMs ?? 0)
    };
  }
}

/** 未知容器如实透传（服务端拒绝时会以明确 asr_failed 报错，不伪装成 wav） */
function normalizeAudioFormat(format: string): string {
  const cleaned = format.toLowerCase().split(';')[0].trim();
  if (cleaned === 'mpeg') return 'mp3';
  if (cleaned === 'mp4') return 'm4a';
  return cleaned || 'wav';
}
