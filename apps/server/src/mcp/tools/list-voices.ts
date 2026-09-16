/** MCP Tool: voice_list（规范第 12 节）。按 conversation_id / message_id / 时间范围查询。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { voiceListInputSchema } from '@siren/contracts';
import { serializeAsset } from '../../routes/voice-message.ts';
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
        limit: voiceListInputSchema.shape.limit
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
      const { items } = await deps.voice.listVoiceMessages({
        conversationId: parsed.data.conversation_id,
        messageId: parsed.data.message_id,
        fromMs: parsed.data.from ? Date.parse(parsed.data.from) : undefined,
        toMs: parsed.data.to ? Date.parse(parsed.data.to) : undefined,
        limit: parsed.data.limit
      });
      deps.logger.info('mcp_tool_called', { tool: 'voice_list', count: items.length });
      return { content: [{ type: 'text', text: JSON.stringify({ items: items.map(serializeAsset) }) }] };
    }
  );
}
