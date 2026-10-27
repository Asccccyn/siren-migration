/** 协议②（2026-10-24）：GET /v1/voice-assets/:id/audio —— 通话用户原声字节（服务间）。
 *  est 后端（持内部凭据）按 CoreTurnInput.audio_ref=siren:<asset_id> 取回字节，
 *  落本地资产绑定语音消息供 oído 快证据/按需深听。不经签名 URL（那是浏览器面），
 *  只读，不修改资产。 */
import type { FastifyInstance } from 'fastify';
import type { VoiceAssetsRepository, ObjectStore } from '@siren/storage';

export interface VoiceAssetAudioDeps {
  assetsRepo: VoiceAssetsRepository;
  /** JV-13：服务间取回只依赖 ObjectStore.get——任意实现（Local/R2/内存）可读 */
  store: ObjectStore | null;
}

const CONTENT_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'application/octet-stream'
};

export function registerVoiceAssetAudioRoute(app: FastifyInstance, deps: VoiceAssetAudioDeps): void {
  app.get('/v1/voice-assets/:id/audio', async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = deps.assetsRepo.findById(id);
    if (!asset) { await reply.code(404).send({ error: 'asset_not_found' }); return; }
    if (!deps.store) { await reply.code(404).send({ error: 'local_assets_disabled' }); return; }
    try {
      const bytes = await deps.store.get(asset.objectKey);
      await reply.code(200)
        .header('Content-Type', CONTENT_TYPES[asset.audioFormat] ?? 'application/octet-stream')
        .header('Content-Length', bytes.length)
        .send(bytes);
    } catch {
      await reply.code(404).send({ error: 'object_missing' });
    }
  });
}
