/**
 * 火山引擎批量 ASR（大模型 one-shot /api/v1/auc）。
 * 上传完整录音 -> 中文 transcript（规范第 10 节）。
 */
import { randomUUID } from 'node:crypto';
import { ProviderError, type BatchAsrProvider, type BatchAudioInput, type TranscriptResult } from '@siren/contracts';

export interface VolcBatchAsrConfig {
  appId: string;
  accessToken: string;
  /** one-shot 资源 ID，如 volc.bigasr.auc.duration */
  resourceId: string;
  endpointUrl: string;
  timeoutMs: number;
}

interface VolcAucResponse {
  resp?: {
    id?: string;
    text?: string;
    utterances?: { text?: string }[];
    duration?: string;
    code?: number;
    message?: string;
  };
  code?: number;
  message?: string;
}

export class VolcBatchAsrProvider implements BatchAsrProvider {
  constructor(private readonly config: VolcBatchAsrConfig) {}

  async transcribe(input: BatchAudioInput): Promise<TranscriptResult> {
    if (input.audio.length === 0) {
      throw new ProviderError('invalid_audio', 'volc-asr', 'empty audio input');
    }
    const body = JSON.stringify({
      user: { uid: 'siren' },
      audio: {
        format: normalizeAudioFormat(input.format),
        data: input.audio.toString('base64')
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true
      }
    });
    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Api-App-Key': this.config.appId,
        'X-Api-Access-Key': this.config.accessToken,
        'X-Api-Resource-Id': this.config.resourceId,
        'X-Api-Request-Id': randomUUID(),
        Authorization: `Bearer;${this.config.accessToken}`
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });
    if (!response.ok) {
      throw new ProviderError('asr_failed', 'volc-asr', `asr http ${response.status}`);
    }
    const payload = (await response.json()) as VolcAucResponse;
    const code = payload.code ?? payload.resp?.code;
    if (code !== undefined && code !== 1000000 && code !== 0) {
      throw new ProviderError('asr_failed', 'volc-asr', `asr business code=${code} ${payload.message ?? payload.resp?.message ?? ''}`);
    }
    const text = (payload.resp?.text ?? payload.resp?.utterances?.map((u) => u.text ?? '').join('') ?? '').trim();
    // ASR 失败必须明确报错，禁止猜测内容（规范第 40 节）
    if (!text && !payload.resp) {
      throw new ProviderError('asr_failed', 'volc-asr', 'asr returned empty payload');
    }
    const durationMs = Math.round(parseFloat(payload.resp?.duration ?? '0') * 1000) || 0;
    return { text, language: input.language ?? 'zh-CN', durationMs };
  }
}

function normalizeAudioFormat(format: string): string {
  const cleaned = format.toLowerCase().split(';')[0].trim();
  if (cleaned === 'webm' || cleaned === 'opus') return 'opus';
  if (cleaned === 'm4a' || cleaned === 'mp4') return 'm4a';
  return cleaned || 'wav';
}
