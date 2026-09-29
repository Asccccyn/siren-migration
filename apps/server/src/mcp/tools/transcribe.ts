/** MCP Tool: voice_transcribe（规范第 12 节）。audio_url 或 object_key 二选一。 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { voiceTranscribeInputObjectSchema, voiceTranscribeInputSchema } from '@siren/contracts';
import type { ObjectStore } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import type { VoiceService } from '@siren/voice-core';
import { downloadWithLimits } from './audio-fetch.ts';

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export function registerTranscribeTool(
  server: McpServer,
  deps: { voice: VoiceService; store: ObjectStore; logger: Logger }
): void {
  server.registerTool(
    'voice_transcribe',
    {
      title: 'Voice Transcribe',
      description: '把音频转写为文字。输入 audio_url（http/https）或 object_key（Siren 对象存储键）。',
      inputSchema: {
        audio_url: voiceTranscribeInputObjectSchema.shape.audio_url,
        object_key: voiceTranscribeInputObjectSchema.shape.object_key
      }
    },
    async (args) => {
      const parsed = voiceTranscribeInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', details: parsed.error.issues }) }]
        };
      }
      try {
        let audio: Buffer;
        let format = 'webm';
        if (parsed.data.audio_url) {
          const downloaded = await downloadWithLimits(parsed.data.audio_url, {
            maxBytes: MAX_DOWNLOAD_BYTES,
            timeoutMs: DOWNLOAD_TIMEOUT_MS
          });
          audio = downloaded.audio;
          format = guessFormatFromMime(downloaded.contentType);
        } else {
          audio = await deps.store.get(parsed.data.object_key as string);
          format = guessFormatFromKey(parsed.data.object_key as string);
        }
        const result = await deps.voice.transcribe({ audio, format });
        deps.logger.info('mcp_tool_called', { tool: 'voice_transcribe', duration_ms: result.durationMs });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                text: result.text,
                language: result.language,
                duration_ms: result.durationMs
              })
            }
          ]
        };
      } catch (error) {
        deps.logger.warn('mcp_tool_failed', { tool: 'voice_transcribe', error_message: (error as Error).message });
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'asr_failed', message: (error as Error).message }) }]
        };
      }
    }
  );
}

function guessFormatFromMime(mime: string): string {
  const cleaned = mime.toLowerCase().split(';')[0].trim();
  if (cleaned.includes('webm')) return 'webm';
  if (cleaned.includes('wav')) return 'wav';
  if (cleaned.includes('mp4') || cleaned.includes('m4a')) return 'm4a';
  if (cleaned.includes('mpeg')) return 'mp3';
  return 'webm';
}

function guessFormatFromKey(key: string): string {
  if (key.endsWith('.wav')) return 'wav';
  if (key.endsWith('.mp3')) return 'mp3';
  if (key.endsWith('.m4a')) return 'm4a';
  return 'webm';
}
