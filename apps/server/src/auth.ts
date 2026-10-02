/**
 * 内部鉴权（规范第 35/36 节）。
 * SIREN_INTERNAL_TOKEN 配置后：除显式开放路径外默认拒绝（含 /v1/* 与 /mcp），
 * 路径判定在 percent-decode 与斜杠归一化之后进行——URL 编码（如 /%76%31/calls）
 * 不再能绕过（审计 F01）。
 * 浏览器永远拿不到 Provider Secret，只能拿到 Siren API / 短期 token / signed URL。
 * Bearer 接受两种：静态 SIREN_INTERNAL_TOKEN（机器直连）或 OAuth access token
 * （oauth/index.ts 签发，extraBearer 校验）——两者权限等同，存量客户端无需重连。
 */
import type { FastifyInstance } from 'fastify';
import type { SirenConfig } from '@siren/voice-core';

/**
 * 显式开放路径前缀（默认拒绝之外的白名单）：
 * - /：语音信箱页（唯一入口，客户端凭 web 登录换取的 token 调 API，页面本身公开）
 * - /assets：唯一入口页的静态资源（css/js，无独立页面）
 * - /health：公开探活
 * - /.well-known、/oauth：OAuth 发现与授权端点（MCP 客户端接入用，密码门在 /oauth/authorize）
 * - /v1/assets：签名资源（鉴权在签名层，规范第 36 节）
 * - /v1/web/login：网页密码登录（人类入口，服务端自限速）
 * - /play：语音播放页（id 为不可枚举 UUID，页面即凭证）
 * - /ws：实时通话握手，自带 call token 校验（verifyToken），不经 Bearer
 */
const OPEN_PREFIXES = ['/', '/health', '/assets', '/.well-known', '/oauth', '/v1/assets', '/v1/web', '/play', '/ws'];

/**
 * 把请求 URL 归一化成路由器实际匹配的路径：去 query/fragment、折叠重复斜杠、
 * 循环 percent-decode（与 find-my-way 的解码语义对齐，双层编码更保守无害）。
 * decode 失败时保留原样——非法编码序列只会落入受保护一侧，不会误放行。
 */
export function normalizeRequestPath(rawUrl: string): string {
  let path = rawUrl.split('?')[0].split('#')[0];
  path = path.replace(/\/{2,}/g, '/');
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded.replace(/\/{2,}/g, '/');
  }
  return path;
}

function isOpenPath(path: string): boolean {
  return OPEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function registerAuthHook(
  app: FastifyInstance,
  config: SirenConfig,
  extraBearer?: (token: string) => boolean
): void {
  if (!config.internalToken) return;
  app.addHook('onRequest', async (request, reply) => {
    const path = normalizeRequestPath(request.url);
    if (isOpenPath(path)) return;
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token !== config.internalToken && !(token && extraBearer?.(token))) {
      // /mcp 的 401 带 RFC 9727 资源元数据指针，OAuth 客户端据此自动发起发现与授权。
      // 注意 header() 必须同步调——单独 await reply 会在 send 前把 reply 当 thenable 挂起
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        reply.header(
          'www-authenticate',
          `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`
        );
      }
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
