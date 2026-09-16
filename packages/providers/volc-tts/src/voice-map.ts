/**
 * Siren 情绪 -> 火山 TTS 参数映射（规范第 9 节）。
 * Voice Profile 的 emotionMap 字段可以逐项覆盖默认映射。
 * 音色 ID 永远来自 Voice Profile / 环境变量，不写死在这里。
 */
import type { SirenEmotion, VoiceStyle } from '@siren/contracts';

export interface VolcTtsAudioParams {
  voice_type: string;
  encoding: 'mp3' | 'pcm' | 'wav';
  sample_rate?: number;
  speed_ratio?: number;
  pitch_ratio?: number;
  volume_ratio?: number;
  emotion?: string;
  emotion_scale?: number;
}

type Mapping = Pick<VolcTtsAudioParams, 'emotion' | 'emotion_scale' | 'speed_ratio' | 'pitch_ratio' | 'volume_ratio'>;

const DEFAULT_EMOTION_MAP: Record<SirenEmotion, Mapping> = {
  neutral: {},
  warm: { speed_ratio: 0.95 },
  happy: { emotion: 'happy', emotion_scale: 2 },
  sad: { emotion: 'sad', speed_ratio: 0.9 },
  angry: { emotion: 'angry', speed_ratio: 1.05 },
  teasing: { emotion: 'happy', pitch_ratio: 1.08, speed_ratio: 1.02 },
  sleepy: { speed_ratio: 0.82, pitch_ratio: 0.95 },
  excited: { emotion: 'happy', emotion_scale: 4, speed_ratio: 1.08 },
  surprised: { emotion: 'surprised', emotion_scale: 2 }
};

export function mapStyleToVolcAudio(
  style: VoiceStyle,
  profileEmotionMap: Partial<Record<SirenEmotion, Record<string, number | string>>> | undefined
): Mapping {
  const defaults = DEFAULT_EMOTION_MAP[style.emotion] ?? {};
  const override = profileEmotionMap?.[style.emotion];
  if (!override) return defaults;
  const merged: Record<string, number | string> = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged as Mapping;
}
