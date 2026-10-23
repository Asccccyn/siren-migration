import type { VoiceAssetWithUrl } from '@siren/contracts';

/** R3′（2026-10-23，她批 R3P 方案）：模型投影正文分页——1200 汉字/页（≈3.6KB UTF-8，
 * 加结构字段在 8192B 预算内）；首页直出，续读带上页 next_cursor 再调 voice_get。
 * 游标锚 checksum：资产不可变，翻页时按 id 复取并核对 checksum——不符=快照失效如实报。
 * 列表项只带 ≤120 字摘录（全文用 voice_get 分页取），单条列表项恒在预算内。 */
const PAGE_CHARS = 1200;
const LIST_EXCERPT_CHARS = 120;

export function encodeVoiceCursor(assetId: string, checksum: string | null, offset: number): string {
  return Buffer.from(JSON.stringify({ a: assetId, ...(checksum !== null ? { s: checksum } : {}), o: offset }), 'utf8').toString('base64url');
}
export function decodeVoiceCursor(cursor: string): { a: string; s: string | null; o: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { a?: string; s?: string; o?: number };
    if (typeof parsed.a === 'string' && typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) return { a: parsed.a, s: typeof parsed.s === 'string' ? parsed.s : null, o: parsed.o };
  } catch { /* 坏游标=无效 */ }
  return null;
}

export function assetModelView(asset: VoiceAssetWithUrl, cursor?: string): Record<string, unknown> {
  const body = asset.direction === 'user' ? asset.transcript : asset.text;
  const bodyField = asset.direction === 'user' ? 'transcript' : 'text';
  const out: Record<string, unknown> = {
    // Preserve the existing get/list ID and the fresh URL for real clients.
    // voice_get accepts this id as voice_message_id after a signed URL expires.
    id: asset.id,
    direction: asset.direction,
    audio_format: asset.audioFormat,
    duration_ms: asset.durationMs,
    ...(asset.language !== null ? { language: asset.language } : {}),
    created_at: new Date(asset.createdAt).toISOString(),
    audio_url: asset.audioUrl
  };
  if (typeof body !== 'string' || body.length === 0) return out;
  const chars = [...body];
  const totalPages = Math.ceil(chars.length / PAGE_CHARS);
  let offset = 0;
  if (cursor) {
    const decoded = decodeVoiceCursor(cursor);
    if (!decoded || decoded.a !== asset.id || (decoded.s !== null && decoded.s !== asset.checksum) || (decoded.s === null && asset.checksum !== null)) {
      return { error: 'snapshot_stale', id: asset.id, message: '游标与当前资产不一致（快照失效）——请从首页重读' };
    }
    if (decoded.o >= chars.length) return { error: 'cursor_out_of_range', id: asset.id };
    offset = decoded.o;
  }
  const pageText = chars.slice(offset, offset + PAGE_CHARS).join('');
  const nextOffset = offset + [...pageText].length;
  const done = nextOffset >= chars.length;
  out[bodyField] = pageText;
  out.text_page = {
    index: Math.floor(offset / PAGE_CHARS) + 1,
    total_pages: totalPages,
    total_chars: chars.length,
    ...(done ? {} : { next_cursor: encodeVoiceCursor(asset.id, asset.checksum, nextOffset) })
  };
  return out;
}

/** 列表项投影：摘录 ≤120 字 + 提示全文走 voice_get 分页。 */
export function assetListModelView(asset: VoiceAssetWithUrl): Record<string, unknown> {
  const out = assetModelView(asset);
  const bodyField = asset.direction === 'user' ? 'transcript' : 'text';
  const body = out[bodyField];
  if (typeof body === 'string') {
    const chars = [...body];
    out[bodyField] = chars.length > LIST_EXCERPT_CHARS ? chars.slice(0, LIST_EXCERPT_CHARS).join('') + '…' : body;
    out.full_text_via = { tool: 'voice_get', voice_message_id: asset.id };
    delete out.text_page;
  }
  return out;
}
