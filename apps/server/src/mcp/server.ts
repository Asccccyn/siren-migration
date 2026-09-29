/**
 * Voice MCP 服务（规范第 12/13 节）。
 * 公网挂载点：POST /mcp（Streamable HTTP，stateless JSON 模式）。
 * MCP 与 REST 共用同一个 VoiceService —— 这里没有任何独立的语音逻辑。
 */
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ObjectStore } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';
import { registerSpeakTool } from './tools/speak.ts';
import { registerTranscribeTool } from './tools/transcribe.ts';
import { registerGetVoiceTool } from './tools/get-voice.ts';
import { registerListVoicesTool } from './tools/list-voices.ts';
import { registerVoicePlayerResource } from './voice-player.ts';

export interface McpDeps {
  voice: VoiceService;
  store: ObjectStore;
  logger: Logger;
  version: string;
}

export function createSirenMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'siren-voice', version: deps.version },
    { capabilities: { tools: {}, resources: {} } }
  );
  registerVoicePlayerResource(server);
  registerSpeakTool(server, deps);
  registerTranscribeTool(server, deps);
  registerGetVoiceTool(server, deps);
  registerListVoicesTool(server, deps);
  return server;
}

/** 挂载到 Fastify：每个 POST 独立 transport（stateless，无会话状态） */
export function registerMcpRoute(app: FastifyInstance, deps: McpDeps): void {
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      if (request.method !== 'POST') {
        // stateless 模式不支持 GET(SSE)/DELETE 会话管理
        await reply.code(405).send({ error: 'method_not_allowed', hint: 'POST JSON-RPC only (stateless)' });
        return;
      }
      logMcpEnvelope(deps.logger, request.body, request.headers['user-agent']);
      reply.hijack();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      const server = createSirenMcpServer(deps);
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body as unknown);
      } catch (error) {
        deps.logger.warn('mcp_transport_error', { error_message: (error as Error).message });
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
        }
        reply.raw.end(JSON.stringify({ error: 'mcp_transport_failed' }));
      } finally {
        await server.close().catch(() => undefined);
      }
    }
  });
}

/**
 * MCP App 兼容诊断：只记录协议方法和非敏感的 UI 路由信息。
 * 不记录 tool arguments、文本、Authorization、签名 URL 或其他用户内容。
 */
function logMcpEnvelope(logger: Logger, body: unknown, userAgent: string | undefined): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as {
      method?: unknown;
      params?: {
        name?: unknown;
        uri?: unknown;
        capabilities?: { extensions?: Record<string, unknown> };
      };
    };
    if (typeof message.method !== 'string') continue;

    const fields: Record<string, unknown> = {
      method: message.method,
      user_agent: userAgent ?? null
    };
    if (message.method === 'tools/call' && typeof message.params?.name === 'string') {
      fields.tool = message.params.name;
    }
    if (message.method === 'resources/read' && typeof message.params?.uri === 'string') {
      fields.resource = message.params.uri.startsWith('ui://') ? message.params.uri : '<non-ui-resource>';
    }
    if (message.method === 'initialize') {
      const ui = message.params?.capabilities?.extensions?.['io.modelcontextprotocol/ui'] as
        | { mimeTypes?: unknown }
        | undefined;
      fields.ui_extension = Boolean(ui);
      fields.ui_mime_types = Array.isArray(ui?.mimeTypes) ? ui.mimeTypes : [];
    }
    logger.info('mcp_request', fields);
  }
}
