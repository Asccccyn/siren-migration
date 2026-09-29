/** MCP Tool: voice_speak（规范第 12 节）。text 与 tts_script 必须分离。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { voiceSpeakInputSchema } from '@siren/contracts';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';
import { serializeAsset } from '../../routes/voice-message.ts';
import { VOICE_PLAYER_TOOL_META } from '../voice-player.ts';

export function registerSpeakTool(server: McpServer, deps: { voice: VoiceService; logger: Logger }): void {
  server.registerTool(
    'voice_speak',
    {
      title: 'Voice Speak',
      description:
        '把对方的文字回复合成为语音条。text 是用户看到的内容，tts_script 是真正交给 TTS 的表达文本（可含情绪标记）。message_id 幂等。',
      inputSchema: {
        text: voiceSpeakInputSchema.shape.text,
        tts_script: voiceSpeakInputSchema.shape.tts_script,
        voice_profile: voiceSpeakInputSchema.shape.voice_profile,
        emotion: voiceSpeakInputSchema.shape.emotion,
        conversation_id: voiceSpeakInputSchema.shape.conversation_id,
        message_id: voiceSpeakInputSchema.shape.message_id,
        language: voiceSpeakInputSchema.shape.language,
        speed: voiceSpeakInputSchema.shape.speed
      },
      _meta: VOICE_PLAYER_TOOL_META
    },
    async (args) => {
      const parsed = voiceSpeakInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', details: parsed.error.issues }) }]
        };
      }
      try {
        const asset = await deps.voice.speak({
          text: parsed.data.text,
          ttsScript: parsed.data.tts_script,
          voiceProfileId: parsed.data.voice_profile,
          emotion: parsed.data.emotion,
          speed: parsed.data.speed,
          conversationId: parsed.data.conversation_id,
          messageId: parsed.data.message_id,
          language: parsed.data.language
        });
        deps.logger.info('mcp_tool_called', { tool: 'voice_speak', voice_message_id: asset.id });
        const payload = {
          voice_message_id: asset.id,
          audio_url: asset.audioUrl,
          duration_ms: asset.durationMs,
          format: asset.audioFormat,
          text: asset.text ?? parsed.data.text
        };
        return {
          structuredContent: payload,
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload)
            }
          ],
          _meta: VOICE_PLAYER_TOOL_META
        };
      } catch (error) {
        deps.logger.warn('mcp_tool_failed', { tool: 'voice_speak', error_message: (error as Error).message });
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'tts_failed', message: (error as Error).message }) }]
        };
      }
    }
  );
}

export { serializeAsset };
