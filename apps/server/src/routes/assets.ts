/**
 * GET /v1/assets/*：本地对象存储的签名代理（R2 模式下走 presigned URL，不经此路由）。
 * 签名校验 + 路径穿越防护（规范第 31/33/47 节）。
 */
import type { FastifyInstance } from 'fastify';
import { LocalObjectStore, verifyObjectSignature } from '@siren/storage';
import type { SirenConfig } from '@siren/voice-core';

export interface AssetsRoutesDeps {
  config: SirenConfig;
  store: LocalObjectStore | null;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/\-_.*]*$/;

export function registerAssetsRoute(app: FastifyInstance, deps: AssetsRoutesDeps): void {
  app.get('/v1/assets/*', async (request, reply) => {
    const store = deps.store;
    if (!store) {
      await reply.code(404).send({ error: 'local_assets_disabled' });
      return;
    }
    const key = decodeURIComponent(request.url.replace(/^\/v1\/assets\//, '').split('?')[0]);
    const query = request.query as { expires?: string; sig?: string };
    if (!KEY_PATTERN.test(key) || key.includes('..')) {
      await reply.code(400).send({ error: 'invalid_key' });
      return;
    }
    const expires = Number(query.expires ?? '');
    const signature = query.sig ?? '';
    if (!Number.isFinite(expires) || !signature) {
      await reply.code(401).send({ error: 'signature_required' });
      return;
    }
    if (!verifyObjectSignature(key, expires, signature, deps.config.signingSecret)) {
      await reply.code(403).send({ error: 'invalid_or_expired_signature' });
      return;
    }
    try {
      const size = await store.size(key);
      const range = parseByteRange(request.headers.range, size);
      if (range === 'invalid') {
        await reply
          .code(416)
          .header('accept-ranges', 'bytes')
          .header('content-range', `bytes */${size}`)
          .send();
        return;
      }

      reply.header('content-type', contentTypeForKey(key)).header('accept-ranges', 'bytes');
      if (range) {
        const length = range.end - range.start + 1;
        const stream = store.openStream(key, range);
        await reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
          .header('content-length', String(length))
          .send(stream);
        return;
      }

      const stream = store.openStream(key);
      await reply.header('content-length', String(size)).send(stream);
    } catch {
      await reply.code(404).send({ error: 'not_found' });
    }
  });
}

type ByteRange = { start: number; end: number };

/** 单 Range 足够满足 HTMLAudioElement / Safari 媒体探测；多 Range 明确拒绝。 */
function parseByteRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  if (size <= 0) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
    if (start < 0 || start >= size || end < start) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function contentTypeForKey(key: string): string {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.wav')) return 'audio/wav';
  if (key.endsWith('.pcm')) return 'audio/pcm';
  if (key.endsWith('.webm')) return 'audio/webm';
  if (key.endsWith('.m4a')) return 'audio/mp4';
  return 'audio/mpeg';
}
