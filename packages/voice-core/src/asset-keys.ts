/**
 * 语音资产的 object key 与内容类型约定（规范第 30 节）。
 * voice/{YYYY}/{MM}/{conversation_id}/{message_id}/audio.{ext} + meta.json
 */

/** 生成规范第 30 节的分形 object key */
export function buildObjectKey(
  conversationId: string | null,
  messageId: string,
  format: string
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const conversation = sanitizeKeyPart(conversationId ?? 'anonymous');
  const message = sanitizeKeyPart(messageId);
  const ext = format === 'pcm' ? 'pcm' : format === 'wav' ? 'wav' : 'mp3';
  return `voice/${year}/${month}/${conversation}/${message}/audio.${ext}`;
}

/** key 段只允许安全字符，长度封顶（配合 isValidObjectKey 双重防护） */
export function sanitizeKeyPart(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9\-_]/g, '-').slice(0, 64);
  return cleaned || 'x';
}

export function contentTypeFor(format: string): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/mpeg';
}

/** 上传容器归一化（webm;codecs=opus -> webm） */
export function normalizeContainer(format: string): string {
  const cleaned = format.toLowerCase().split(';')[0].trim();
  if (cleaned === 'webm' || cleaned === 'opus') return 'webm';
  if (cleaned === 'm4a' || cleaned === 'mp4') return 'm4a';
  if (cleaned === 'wav') return 'wav';
  if (cleaned === 'mp3') return 'mp3';
  return cleaned || 'bin';
}

export interface AssetMetaInput {
  id: string;
  conversationId: string | null;
  messageId: string;
  direction: 'user' | 'assistant';
  voiceProfileId: string;
  text?: string | null;
  ttsScript?: string | null;
  transcript?: string | null;
  emotion?: string | null;
  durationMs: number;
  format: string;
  sampleRate: number;
}

/** 与音频文件同目录的 meta.json 内容（object key 由 audioKey 推导） */
export function metaObjectKey(audioObjectKey: string): string {
  return `${audioObjectKey.slice(0, audioObjectKey.lastIndexOf('/'))}/meta.json`;
}

export function buildAssetMeta(input: AssetMetaInput): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        id: input.id,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        direction: input.direction,
        voice_profile: input.voiceProfileId,
        text: input.text ?? null,
        tts_script: input.ttsScript ?? null,
        transcript: input.transcript ?? null,
        emotion: input.emotion ?? null,
        duration_ms: input.durationMs,
        format: input.format,
        sample_rate: input.sampleRate,
        created_at: new Date().toISOString()
      },
      null,
      2
    )
  );
}
