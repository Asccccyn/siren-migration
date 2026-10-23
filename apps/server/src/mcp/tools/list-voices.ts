/** MCP Tool: voice_list（规范第 12 节）。按 conversation_id / message_id / 时间范围查询。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FieldDecryptionError } from '@siren/storage';
import { voiceListInputSchema } from '@siren/contracts';
import { assetListModelView } from '../asset-model-view.ts';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';

export function registerListVoicesTool(server: McpServer, deps: { voice: VoiceService; logger: Logger }): void {
  server.registerTool(
    'voice_list',
    {
      title: 'Voice List',
      description: '查询语音消息列表，支持 conversation_id / message_id / from / to / limit。',
      inputSchema: {
        conversation_id: voiceListInputSchema.shape.conversation_id,
        message_id: voiceListInputSchema.shape.message_id,
        from: voiceListInputSchema.shape.from,
        to: voiceListInputSchema.shape.to,
        limit: voiceListInputSchema.shape.limit,
        cursor: voiceListInputSchema.shape.cursor
      }
    },
    async (args) => {
      const parsed = voiceListInputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', details: parsed.error.issues }) }]
        };
      }
      try {
        const pageSize = parsed.data.limit ?? 50;
        const { items } = await deps.voice.listVoiceMessages({
          conversationId: parsed.data.conversation_id,
          messageId: parsed.data.message_id,
          fromMs: parsed.data.from ? Date.parse(parsed.data.from) : undefined,
          toMs: parsed.data.to ? Date.parse(parsed.data.to) : undefined,
          limit: pageSize,
          // R3′：keyset 游标传给仓储（并发新增不漂移）
          cursor: parsed.data.cursor
        });
        deps.logger.info('mcp_tool_called', { tool: 'voice_list', count: items.length });
        // 满页=可能有下一页（keyset 语义：下页从本页末条之后继续）
        const last = items[items.length - 1];
        const nextCursor = items.length === pageSize && last
          ? Buffer.from(JSON.stringify({ c: last.createdAt, i: last.id }), 'utf8').toString('base64url')
          : undefined;
        const payload = JSON.stringify({ items: items.map(assetListModelView), ...(nextCursor ? { next_cursor: nextCursor } : {}) });
        if (Buffer.byteLength(payload, 'utf8') > 8192 * 5) {
          deps.logger.warn('mcp_projection_over_budget', { tool: 'voice_list', bytes: Buffer.byteLength(payload, 'utf8') });
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'projection_over_budget' }) }] };
        }
        return { content: [{ type: 'text', text: payload }] };
      } catch (error) {
        if (error instanceof FieldDecryptionError) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'data_unreadable' }) }] };
        }
        throw error;
      }
    }
  );
}
