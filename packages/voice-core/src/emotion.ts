/**
 * 情绪解析与 Voice Style 合成（规范第 9 节）。
 */
import {
  SIREN_EMOTIONS,
  type SirenEmotion,
  type VoiceProfile,
  type VoiceStyle
} from '@siren/contracts';

export function parseEmotion(input: string | undefined | null): SirenEmotion | undefined {
  if (!input) return undefined;
  const lowered = input.trim().toLowerCase() as SirenEmotion;
  return SIREN_EMOTIONS.includes(lowered) ? lowered : undefined;
}

export function resolveStyle(
  profile: VoiceProfile,
  overrides: { emotion?: SirenEmotion; intensity?: number; speed?: number } = {}
): VoiceStyle {
  return {
    emotion: overrides.emotion ?? profile.defaultEmotion,
    intensity: overrides.intensity,
    speed: overrides.speed ?? profile.defaultSpeed
  };
}

/** 情绪 -> filler 分类（规范第 24 节目录结构） */
export type FillerCategory = 'neutral' | 'positive' | 'low';

export function emotionToFillerCategory(emotion: SirenEmotion): FillerCategory {
  switch (emotion) {
    case 'happy':
    case 'excited':
    case 'warm':
    case 'teasing':
      return 'positive';
    case 'sad':
    case 'sleepy':
      return 'low';
    default:
      return 'neutral';
  }
}
