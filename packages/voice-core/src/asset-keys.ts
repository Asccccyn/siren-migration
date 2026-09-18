/**
 * 语音资产的 object key 与内容类型约定（规范第 30 节 / v1.1 P1-3 + 审计修复）。
 * voice/{YYYY}/{MM}/{conversation_id}/{message_id}/{asset_id}/audio.{ext} + meta.json
 *
 * key 包含 asset_id（P1-3 immutable object key）：并发同 message_id 的两个请求
 * 写不同的物理 key，DB 唯一索引决定 winner；落败者只清理自己的 key，
 * 永远不会误删 winner 的音频对象。
 *
 * 格式闭环（审计修复）：DB 里的 audio_format、对象扩展名、Content-Type
 * 三者来自同一张 FORMAT_META 表——m4a/webm/ogg 不再被错误命名为 audio.mp3
 * 或标成 audio/mpeg。
 */

/** 容器格式 -> 物理扩展名 + MIME（对象存储 put 与资源代理共用） */
export const FORMAT_META: Readonly<Record<string, { ext: string; mime: string }>> = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg' },
  wav: { ext: 'wav', mime: 'audio/wav' },
  pcm: { ext: 'pcm', mime: 'audio/pcm' },
  m4a: { ext: 'm4a', mime: 'audio/mp4' },
  mp4: { ext: 'm4a', mime: 'audio/mp4' },
  webm: { ext: 'webm', mime: 'audio/webm' },
  ogg: { ext: 'ogg', mime: 'audio/ogg' },
  bin: { ext: 'bin', mime: 'application/octet-stream' }
};

/** 生成规范第 30 节的分形 object key（asset 维度不可变） */
export function buildObjectKey(
  conversationId: string | null,
  messageId: string,
  format: string,
  assetId: string
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const conversation = sanitizeKeyPart(conversationId ?? 'anonymous');
  const message = sanitizeKeyPart(messageId);
  const asset = sanitizeKeyPart(assetId);
  const meta = FORMAT_META[format] ?? FORMAT_META.bin;
  return `voice/${year}/${month}/${conversation}/${message}/${asset}/audio.${meta.ext}`;
}

/** key 段只允许安全字符，长度封顶（配合 isValidObjectKey 双重防护） */
export function sanitizeKeyPart(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9\-_]/g, '-').slice(0, 64);
  return cleaned || 'x';
}

export function contentTypeFor(format: string): string {
  return (FORMAT_META[format] ?? FORMAT_META.bin).mime;
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
