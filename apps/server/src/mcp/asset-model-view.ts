import type { VoiceAssetWithUrl } from '@siren/contracts';

/** Model projection only. Persistence and the REST UI retain the full asset. */
export function assetModelView(asset: VoiceAssetWithUrl): Record<string, unknown> {
  return {
    // Preserve the existing get/list ID and the fresh URL for real clients.
    // voice_get accepts this id as voice_message_id after a signed URL expires.
    id: asset.id,
    direction: asset.direction,
    audio_format: asset.audioFormat,
    duration_ms: asset.durationMs,
    ...(asset.language !== null ? { language: asset.language } : {}),
    ...(asset.direction === 'user'
      ? asset.transcript !== null ? { transcript: asset.transcript } : {}
      : asset.text !== null ? { text: asset.text } : {}),
    created_at: new Date(asset.createdAt).toISOString(),
    audio_url: asset.audioUrl
  };
}
