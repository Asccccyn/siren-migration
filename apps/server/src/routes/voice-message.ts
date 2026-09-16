/**
 * 异步语音 REST（规范第 14 节）：
 * POST /v1/voice/transcribe  multipart audio
 * POST /v1/voice/synthesize   JSON -> 音频字节
 * GET  /v1/voice/messages/:id
 * GET  /v1/voice/messages?conversation_id=...
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SIREN_EMOTIONS } from '@siren/contracts';
import type { AsyncVoicePipeline, SirenConfig, VoiceService } from '@siren/voice-core';
import type { Logger } from '@siren/telemetry';
import { errorFields } from '@siren/telemetry';
import { ProviderError } from '@siren/contracts';
import { removeTmpFile, saveBufferToTmp } from '../tmp-files.ts';

const synthesizeBodySchema = z.object({
  text: z.string().min(1).max(4000),
  tts_script: z.string().max(8000).optional(),
  voice_profile: z.string().min(1).max(64).optional(),
  emotion: z.enum(SIREN_EMOTIONS).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  format: z.enum(['mp3', 'wav', 'pcm']).optional(),
  language: z.string().min(2).max(16).optional()
});

const listQuerySchema = z.object({
  conversation_id: z.string().min(1).max(128).optional(),
  message_id: z.string().min(1).max(128).optional(),
  direction: z.enum(['user', 'assistant']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

export interface VoiceMessageRoutesDeps {
  config: SirenConfig;
  logger: Logger;
  voice: VoiceService;
  pipeline: AsyncVoicePipeline;
}

export function registerVoiceMessageRoutes(app: FastifyInstance, deps: VoiceMessageRoutesDeps): void {
  const { config, logger, voice, pipeline } = deps;

  app.post('/v1/voice/transcribe', async (request, reply) => {
    let audioFile: { toBuffer: () => Promise<Buffer> } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio') continue;
          if (audioFile) {
            await reply.code(400).send({ error: 'single_audio_file_only' });
            return;
          }
          audioFile = part;
        } else if (part.fieldname) {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (error) {
      await reply.code(400).send({ error: 'invalid_multipart', message: (error as Error).message });
      return;
    }
    if (!audioFile) {
      await reply.code(400).send({ error: 'audio_file_required' });
      return;
    }

    // 落临时文件（UUID 名），读完即删；大小在 multipart limits 层面已限制
    let buffer: Buffer;
    let tmpPath: string | null = null;
    try {
      buffer = await audioFile.toBuffer();
      if (buffer.length === 0) {
        await reply.code(400).send({ error: 'empty_audio' });
        return;
      }
      if (buffer.length > config.maxUploadBytes) {
        await reply.code(413).send({ error: 'audio_too_large' });
        return;
      }
      tmpPath = await saveBufferToTmp(config.tmpDir, buffer, '.upload');
      const stored = await readFile(tmpPath);
      const output = await pipeline.handleUserVoice({
        audio: stored,
        format: fields.format ?? guessAudioFormat(request.headers['content-type'] ?? ''),
        language: fields.language || undefined,
        conversationId: fields.conversation_id || undefined,
        messageId: fields.message_id || undefined,
        voiceProfileId: fields.voice_profile || undefined,
        store: fields.store === 'true'
      });
      await reply.send({
        text: output.transcript.text,
        language: output.transcript.language,
        duration_ms: output.transcript.durationMs,
        ...(output.asset ? { voice_message_id: output.asset.id } : {})
      });
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'asr_failed') {
        await reply.code(502).send({ error: 'asr_failed', message: error.message });
        return;
      }
      logger.warn('transcribe_route_failed', errorFields(error));
      await reply.code(500).send({ error: 'internal' });
    } finally {
      if (tmpPath) await removeTmpFile(tmpPath);
    }
  });

  app.post('/v1/voice/synthesize', async (request, reply) => {
    const parsed = synthesizeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body', details: zodDetails(parsed.error) });
      return;
    }
    try {
      const result = await voice.synthesizeAudio({
        text: parsed.data.text,
        ttsScript: parsed.data.tts_script,
        voiceProfileId: parsed.data.voice_profile,
        emotion: parsed.data.emotion,
        speed: parsed.data.speed,
        format: parsed.data.format ?? 'mp3',
        language: parsed.data.language
      });
      await reply
        .header('content-type', contentTypeFor(result.format))
        .header('x-siren-duration-ms', result.durationMs)
        .header('x-siren-format', result.format)
        .header('x-siren-voice-profile', result.profile.id)
        .send(result.audio);
    } catch (error) {
      if (error instanceof ProviderError) {
        await reply.code(502).send({ error: error.code, message: error.message });
        return;
      }
      logger.warn('synthesize_route_failed', errorFields(error));
      await reply.code(500).send({ error: 'internal' });
    }
  });

  app.get('/v1/voice/messages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await voice.getVoiceMessage({ id });
    if (!record) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }
    await reply.send(serializeAsset(record));
  });

  app.get('/v1/voice/messages', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_query', details: zodDetails(parsed.error) });
      return;
    }
    const { items } = await voice.listVoiceMessages({
      conversationId: parsed.data.conversation_id,
      messageId: parsed.data.message_id,
      direction: parsed.data.direction,
      fromMs: parsed.data.from ? Date.parse(parsed.data.from) : undefined,
      toMs: parsed.data.to ? Date.parse(parsed.data.to) : undefined,
      limit: parsed.data.limit
    });
    await reply.send({ items: items.map(serializeAsset) });
  });
}

export function serializeAsset(record: {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  direction: string;
  voiceProfile: string;
  audioFormat: string;
  sampleRate: number;
  durationMs: number;
  language: string | null;
  emotion: string | null;
  text: string | null;
  ttsScript: string | null;
  transcript: string | null;
  createdAt: number;
  audioUrl: string;
}): Record<string, unknown> {
  return {
    id: record.id,
    conversation_id: record.conversationId,
    message_id: record.messageId,
    direction: record.direction,
    voice_profile: record.voiceProfile,
    audio_format: record.audioFormat,
    sample_rate: record.sampleRate,
    duration_ms: record.durationMs,
    language: record.language,
    emotion: record.emotion,
    text: record.text,
    tts_script: record.ttsScript,
    transcript: record.transcript,
    created_at: new Date(record.createdAt).toISOString(),
    audio_url: record.audioUrl
  };
}

function contentTypeFor(format: string): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/mpeg';
}

function guessAudioFormat(contentType: string): string {
  const cleaned = contentType.toLowerCase().split(';')[0].trim();
  if (cleaned.includes('webm')) return 'webm';
  if (cleaned.includes('ogg')) return 'ogg';
  if (cleaned.includes('mp4') || cleaned.includes('m4a')) return 'm4a';
  if (cleaned.includes('wav')) return 'wav';
  if (cleaned.includes('mpeg') || cleaned.includes('mp3')) return 'mp3';
  return 'webm'; // 浏览器 MediaRecorder 默认容器
}

function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
