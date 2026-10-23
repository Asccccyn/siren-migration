/** MCP Tool: voice_speak（规范第 12 节）。text 与 tts_script 必须分离。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { voiceSpeakInputSchema } from '@siren/contracts';
import { errorFields, type Logger } from '@siren/telemetry';
import { FieldDecryptionError } from '@siren/storage';
import type { VoiceService } from '@siren/voice-core';
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
        // R3″（2026-10-24，RE-16）：模型面回执最小化——完整 text 本就在模型自己的工具调用
        // 参数里（回显=大正文双份：上轮实测 12261B/双份 24941B）。content 只带 spoken+摘录；
        // 播放器展示正文走 structuredContent（单份，不进模型正文），全文分页走 voice_get。
        const chars = [...asset.text];
        const excerpt = chars.length > 120 ? chars.slice(0, 120).join('') + '…' : asset.text;
        const modelPayload = {
          voice_message_id: asset.id,
          audio_url: asset.audioUrl,
          spoken: true,
          duration_ms: asset.durationMs,
          format: asset.audioFormat,
          text_excerpt: excerpt,
          note: '语音已合成；正文以你的原话为准（摘录如上，不整段回显），全文走 voice_get'
        };
        const playerPayload = {
          voice_message_id: asset.id,
          audio_url: asset.audioUrl,
          text: asset.text,
          duration_ms: asset.durationMs,
          format: asset.audioFormat
        };
        return {
          structuredContent: playerPayload,
          content: [
            {
              type: 'text',
              text: JSON.stringify(modelPayload)
            }
          ],
          _meta: VOICE_PLAYER_TOOL_META
        };
      } catch (error) {
        const code = error instanceof FieldDecryptionError ? 'data_unreadable' : 'tts_failed';
        deps.logger.warn('mcp_tool_failed', { tool: 'voice_speak', ...errorFields(error) });
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: code }) }]
        };
      }
    }
  );
}

