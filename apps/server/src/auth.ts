/**
 * 内部鉴权（规范第 35/36 节）。
 * SIREN_INTERNAL_TOKEN 配置后：/v1/*（除 assets 签名资源）与 /mcp 必须携带 Bearer。
 * 浏览器永远拿不到 Provider Secret，只能拿到 Siren API / 短期 token / signed URL。
 */
import type { FastifyInstance } from 'fastify';
import type { SirenConfig } from '@siren/voice-core';

const OPEN_PREFIXES = ['/health', '/playground', '/v1/assets'];

export function registerAuthHook(app: FastifyInstance, config: SirenConfig): void {
  if (!config.internalToken) return;
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (OPEN_PREFIXES.some((prefix) => url.startsWith(prefix))) return;
    if (!url.startsWith('/v1/') && url !== '/mcp') return;
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token !== config.internalToken) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
