/**
 * Voice MCP 工具的输入输出 schema（规范第 12 节）。
 * MCP 与 REST 校验共用这些定义，避免两套规则漂移。
 */
import { z } from 'zod';
import { SIREN_EMOTIONS } from './voice.ts';

export const sirenEmotionSchema = z.enum(SIREN_EMOTIONS);

/** voice_speak：text（用户看到的）与 tts_script（交给 TTS 的）必须分离 */
export const voiceSpeakInputSchema = z.object({
  text: z.string().min(1).max(4000),
  tts_script: z.string().max(8000).optional(),
  voice_profile: z.string().min(1).max(64).optional(),
  emotion: sirenEmotionSchema.optional(),
  conversation_id: z.string().min(1).max(128).optional(),
  message_id: z.string().min(1).max(128).optional(),
  language: z.string().min(2).max(16).optional(),
  speed: z.number().min(0.5).max(2.0).optional()
});

export type VoiceSpeakInput = z.infer<typeof voiceSpeakInputSchema>;

export interface VoiceSpeakOutput {
  voice_message_id: string;
  audio_url: string;
  duration_ms: number;
  format: string;
}

/** voice_transcribe：audio_url 或 object_key 二选一（对象 schema，供 MCP 注册用） */
export const voiceTranscribeInputObjectSchema = z.object({
  audio_url: z.string().url().max(2048).optional(),
  object_key: z.string().min(1).max(512).optional()
});

/** voice_transcribe：二选一校验（完整校验用） */
export const voiceTranscribeInputSchema = voiceTranscribeInputObjectSchema.refine(
  (v) => Boolean(v.audio_url ?? v.object_key),
  { message: 'audio_url 与 object_key 必须提供其一' }
);

export type VoiceTranscribeInput = z.infer<typeof voiceTranscribeInputSchema>;

export interface VoiceTranscribeOutput {
  text: string;
  language: string;
  duration_ms: number;
}

export const voiceGetInputSchema = z.object({
  voice_message_id: z.string().min(1).max(128).optional(),
  message_id: z.string().min(1).max(128).optional()
});

export type VoiceGetInput = z.infer<typeof voiceGetInputSchema>;

export const voiceListInputSchema = z.object({
  conversation_id: z.string().min(1).max(128).optional(),
  message_id: z.string().min(1).max(128).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).optional()
});

export type VoiceListInput = z.infer<typeof voiceListInputSchema>;
