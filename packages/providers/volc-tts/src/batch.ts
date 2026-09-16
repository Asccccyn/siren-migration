/**
 * 火山引擎批量 TTS（HTTP /api/v1/tts）。
 * - 异步链路：encoding=mp3，产出完整语音条
 * - 实时链路兜底：encoding=pcm/24000（规范第 40 节的 Batch 降级）
 */
import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  REALTIME_OUTPUT_SAMPLE_RATE,
  type AudioFormat,
  type BatchTtsProvider,
  type TtsAudioResult,
  type TtsRequest
} from '@siren/contracts';
import { mapStyleToVolcAudio } from './voice-map.ts';

export interface VolcTtsConfig {
  appId: string;
  accessToken: string;
  /** 如 volcano_icl / volcano_tts */
  cluster: string;
  endpointUrl: string;
  timeoutMs: number;
}

interface VolcTtsResponse {
  reqid?: string;
  code: number;
  message?: string;
  data?: string; // base64
  duration?: string; // 秒（字符串）
}

export class VolcBatchTtsProvider implements BatchTtsProvider {
  constructor(private readonly config: VolcTtsConfig) {}

  async synthesize(request: TtsRequest): Promise<TtsAudioResult> {
    const voiceId = request.profile.voiceId;
    if (!voiceId) {
      throw new ProviderError('provider_unavailable', 'volc-tts', 'voice id missing (set VOLC_VOICE_ID or profile voiceId)');
    }
    const sampleRate = request.sampleRate ?? (request.format === 'pcm' ? REALTIME_OUTPUT_SAMPLE_RATE : 24000);
    const styleParams = mapStyleToVolcAudio(request.style, request.profile.emotionMap);
    const body = JSON.stringify({
      app: { appid: this.config.appId, token: this.config.accessToken, cluster: this.config.cluster },
      user: { uid: 'siren' },
      audio: {
        voice_type: voiceId,
        encoding: request.format === 'pcm' ? 'pcm' : request.format,
        sample_rate: sampleRate,
        ...(styleParams.emotion ? { emotion: styleParams.emotion } : {}),
        ...(styleParams.emotion_scale !== undefined ? { emotion_scale: styleParams.emotion_scale } : {}),
        speed_ratio: clamp(request.style.speed ?? styleParams.speed_ratio ?? 1.0, 0.2, 3.0),
        ...(styleParams.pitch_ratio !== undefined ? { pitch_ratio: clamp(styleParams.pitch_ratio, 0.1, 3.0) } : {}),
        ...(styleParams.volume_ratio !== undefined ? { volume_ratio: clamp(styleParams.volume_ratio, 0.1, 3.0) } : {})
      },
      request: {
        reqid: randomUUID(),
        text: request.ttsScript ?? request.text,
        text_type: 'plain',
        operation: 'query'
      }
    });
    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer;${this.config.accessToken}`
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs)
    });
    if (!response.ok) {
      throw new ProviderError('tts_failed', 'volc-tts', `tts http ${response.status}`);
    }
    const payload = (await response.json()) as VolcTtsResponse;
    if (payload.code !== 3000) {
      throw new ProviderError('tts_failed', 'volc-tts', `tts code=${payload.code} ${payload.message ?? ''}`);
    }
    if (!payload.data) {
      throw new ProviderError('tts_failed', 'volc-tts', 'tts returned empty audio');
    }
    const audio = Buffer.from(payload.data, 'base64');
    const durationMs = Math.round(parseFloat(payload.duration ?? '0') * 1000) || 0;
    return { audio, format: request.format, sampleRate, durationMs };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export type { AudioFormat };
