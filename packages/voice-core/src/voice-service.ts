/**
 * VoiceService：MCP 与 REST 共用的唯一语音业务入口（规范第 13 节）。
 * 禁止 MCP、REST 各自实现一套语音逻辑。
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AsrProvider,
  AudioFormat,
  BatchAudioInput,
  BatchTtsProvider,
  SirenEmotion,
  TranscriptResult,
  TtsAudioResult,
  VoiceAssetRecord,
  VoiceAssetWithUrl,
  VoiceProfile
} from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import type {
  CallSessionsRepository,
  CallTurnsRepository,
  ListAssetsFilter,
  ObjectStore
} from '@siren/storage';
import { VoiceAssetsRepository } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';
import { parseEmotion, resolveStyle } from './emotion.ts';
import type { VoiceProfileRegistry } from './voice-profile.ts';
import { buildAssetMeta, buildObjectKey, contentTypeFor, metaObjectKey, normalizeContainer } from './asset-keys.ts';

export interface VoiceServiceDeps {
  config: SirenConfig;
  logger: Logger;
  asr: AsrProvider;
  asyncTts: BatchTtsProvider;
  core: CoreBridge;
  store: ObjectStore;
  assetsRepo: VoiceAssetsRepository;
  sessionsRepo: CallSessionsRepository;
  turnsRepo: CallTurnsRepository;
  profiles: VoiceProfileRegistry;
  /** 元数据用：实际生效的 provider 名 */
  asrName?: string;
  asyncTtsName?: string;
}

export interface SpeakParams {
  text: string;
  ttsScript?: string;
  voiceProfileId?: string;
  emotion?: SirenEmotion;
  speed?: number;
  conversationId?: string;
  messageId?: string;
  language?: string;
  direction?: 'user' | 'assistant';
}

export interface SynthesizeParams {
  text: string;
  ttsScript?: string;
  voiceProfileId?: string;
  emotion?: string;
  speed?: number;
  format?: AudioFormat;
  language?: string;
}

export class VoiceService {
  constructor(protected readonly deps: VoiceServiceDeps) {}

  // -------------------------------------------------------------------------

  async transcribe(input: BatchAudioInput): Promise<TranscriptResult> {
    const started = Date.now();
    const result = await this.deps.asr.transcribe(input);
    this.deps.logger.info('asr_batch_completed', {
      duration_ms: Date.now() - started,
      audio_bytes: input.audio.length,
      format: input.format
    });
    return result;
  }

  async synthesizeAudio(params: SynthesizeParams): Promise<TtsAudioResult & { profile: VoiceProfile }> {
    const profile = this.resolveProfile(params.voiceProfileId);
    const emotion = parseEmotion(params.emotion) ?? profile.defaultEmotion;
    const style = resolveStyle(profile, { emotion, speed: params.speed });
    const result = await this.deps.asyncTts.synthesize({
      text: params.text,
      ttsScript: params.ttsScript,
      profile,
      style,
      format: params.format ?? 'mp3',
      sampleRate: 24000,
      language: params.language ?? profile.language
    });
    this.deps.logger.info('tts_batch_completed', {
      profile: profile.id,
      emotion,
      duration_ms: result.durationMs,
      format: result.format
    });
    return { ...result, profile };
  }

  /**
   * 对方 -> 用户：Batch TTS -> R2 -> voice_assets（规范第 11 节）。
   * message_id 幂等：重复调用返回既有资产。
   */
  async speak(params: SpeakParams): Promise<VoiceAssetWithUrl> {
    if (params.messageId) {
      const existing = this.deps.assetsRepo.findByMessageId(params.messageId);
      if (existing) {
        this.deps.logger.info('voice_asset_idempotent_hit', { message_id: params.messageId });
        return this.withAudioUrl(existing);
      }
    }
    const profile = this.resolveProfile(params.voiceProfileId);
    const emotion = params.emotion ?? profile.defaultEmotion;
    const style = resolveStyle(profile, { emotion, speed: params.speed });
    const synthesized = await this.deps.asyncTts.synthesize({
      text: params.text,
      ttsScript: params.ttsScript,
      profile,
      style,
      format: 'mp3',
      sampleRate: 24000,
      language: params.language ?? profile.language
    });

    const assetId = randomUUID();
    const messageId = params.messageId ?? assetId;
    const conversationId = params.conversationId ?? null;
    const objectKey = buildObjectKey(conversationId, messageId, synthesized.format);
    await this.deps.store.put(objectKey, synthesized.audio, contentTypeFor(synthesized.format));
    await this.deps.store.put(
      metaObjectKey(objectKey),
      buildAssetMeta({
        id: assetId,
        conversationId,
        messageId,
        direction: params.direction ?? 'assistant',
        voiceProfileId: profile.id,
        text: params.text,
        ttsScript: params.ttsScript,
        emotion,
        durationMs: synthesized.durationMs,
        format: synthesized.format,
        sampleRate: synthesized.sampleRate
      }),
      'application/json'
    );

    const record: VoiceAssetRecord = {
      id: assetId,
      conversationId,
      messageId,
      direction: params.direction ?? 'assistant',
      voiceProfile: profile.id,
      provider: profile.provider,
      providerVoiceId: profile.voiceId || null,
      audioFormat: synthesized.format,
      sampleRate: synthesized.sampleRate,
      durationMs: synthesized.durationMs,
      language: params.language ?? profile.language,
      emotion,
      text: params.text,
      ttsScript: params.ttsScript ?? null,
      transcript: null,
      objectKey,
      checksum: createHash('sha256').update(synthesized.audio).digest('hex'),
      createdAt: Date.now()
    };
    const { inserted, existing } = this.deps.assetsRepo.insert(record);
    let finalRecord: VoiceAssetRecord = record;
    if (!inserted && existing) {
      // 并发同 message_id：以先落库者为准（幂等）
      await this.deps.store.delete(objectKey).catch(() => undefined);
      finalRecord = existing;
    }
    this.deps.logger.info('voice_asset_created', {
      voice_message_id: finalRecord.id,
      message_id: finalRecord.messageId,
      duration_ms: finalRecord.durationMs,
      object_key: finalRecord.objectKey
    });
    return this.withAudioUrl(finalRecord);
  }

  /** 用户 -> 对方：录音转写并可入库 user 方向资产（规范第 10/42 节） */
  async storeUserVoice(input: {
    audio: Buffer;
    format: string;
    language?: string;
    conversationId?: string;
    messageId?: string;
    voiceProfileId?: string;
  }): Promise<{ transcript: TranscriptResult; asset: VoiceAssetWithUrl }> {
    if (input.messageId) {
      const existing = this.deps.assetsRepo.findByMessageId(input.messageId);
      if (existing && existing.direction === 'user') {
        return {
          transcript: {
            text: existing.transcript ?? '',
            language: existing.language ?? 'zh-CN',
            durationMs: existing.durationMs
          },
          asset: await this.withAudioUrl(existing)
        };
      }
    }
    const transcript = await this.transcribe({
      audio: input.audio,
      format: input.format,
      language: input.language
    });
    const profile = this.resolveProfile(input.voiceProfileId);
    const assetId = randomUUID();
    const messageId = input.messageId ?? assetId;
    const conversationId = input.conversationId ?? null;
    const objectKey = buildObjectKey(conversationId, messageId, normalizeContainer(input.format));
    await this.deps.store.put(objectKey, input.audio, contentTypeFor(normalizeContainer(input.format)));
    const record: VoiceAssetRecord = {
      id: assetId,
      conversationId,
      messageId,
      direction: 'user',
      voiceProfile: profile.id,
      provider: this.deps.asrName ?? 'asr',
      providerVoiceId: null,
      audioFormat: normalizeContainer(input.format),
      sampleRate: 0,
      durationMs: transcript.durationMs,
      language: transcript.language,
      emotion: null,
      text: null,
      ttsScript: null,
      transcript: transcript.text,
      objectKey,
      checksum: createHash('sha256').update(input.audio).digest('hex'),
      createdAt: Date.now()
    };
    const { inserted, existing } = this.deps.assetsRepo.insert(record);
    let finalRecord: VoiceAssetRecord = record;
    if (!inserted && existing) {
      finalRecord = existing;
    }
    this.deps.logger.info('user_voice_stored', {
      voice_message_id: finalRecord.id,
      message_id: finalRecord.messageId,
      transcript_len: transcript.text.length
    });
    return { transcript, asset: await this.withAudioUrl(finalRecord) };
  }

  async getVoiceMessage(query: { id?: string; messageId?: string }): Promise<VoiceAssetWithUrl | null> {
    let record: VoiceAssetRecord | undefined;
    if (query.id) record = this.deps.assetsRepo.findById(query.id);
    if (!record && query.messageId) record = this.deps.assetsRepo.findByMessageId(query.messageId);
    return record ? this.withAudioUrl(record) : null;
  }

  async listVoiceMessages(filter: ListAssetsFilter): Promise<{ items: VoiceAssetWithUrl[] }> {
    const items = await Promise.all(this.deps.assetsRepo.list(filter).map((r) => this.withAudioUrl(r)));
    return { items };
  }

  // -------------------------------------------------------------------------

  protected resolveProfile(voiceProfileId?: string): VoiceProfile {
    const fallback = this.deps.profiles.defaultProfileId() ?? 'main';
    const profile = this.deps.profiles.get(voiceProfileId ?? undefined, fallback);
    // 音色 ID 统一回退环境变量后再交给 Provider
    return { ...profile, voiceId: this.deps.profiles.resolveVoiceId(profile) };
  }


  private async withAudioUrl(record: VoiceAssetRecord): Promise<VoiceAssetWithUrl> {
    const audioUrl = await this.deps.store.signedUrl(record.objectKey, this.deps.config.signedUrlTtlS);
    return { ...record, audioUrl };
  }
}

