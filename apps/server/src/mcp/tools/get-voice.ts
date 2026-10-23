/** MCP Tool: voice_get（规范第 12 节）。按 voice_message_id 或 message_id 获取语音资产。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FieldDecryptionError } from '@siren/storage';
import { voiceGetInputSchema } from '@siren/contracts';
import { assetModelView } from '../asset-model-view.ts';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';

export function registerGetVoiceTool(server: McpServer, deps: { voice: VoiceService; logger: Logger }): void {
  server.registerTool(
    'voice_get',
    {
      title: 'Voice Get',
      description: '获取语音资产元数据与签名音频 URL。',
      inputSchema: {
        voice_message_id: voiceGetInputSchema.shape.voice_message_id,
        message_id: voiceGetInputSchema.shape.message_id
      }
    },
    async (args) => {
      const parsed = voiceGetInputSchema.safeParse(args);
      if (!parsed.success || (!parsed.data.voice_message_id && !parsed.data.message_id)) {
        return {
          isError: true,
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_input', details: parsed.success ? [] : parsed.error.issues }) }
          ]
        };
      }
      try {
        const asset = await deps.voice.getVoiceMessage({
          id: parsed.data.voice_message_id,
          messageId: parsed.data.message_id
        });
        deps.logger.info('mcp_tool_called', { tool: 'voice_get', found: Boolean(asset) });
        if (!asset) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'not_found' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(assetModelView(asset)) }] };
      } catch (error) {
        if (error instanceof FieldDecryptionError) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'data_unreadable' }) }] };
        }
        throw error;
      }
    }
  );
}
