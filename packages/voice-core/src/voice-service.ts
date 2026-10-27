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
import { assertTtsProfileCompatible } from './voice-profile.ts';
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
  /** A01（联合审计 2026-10-27）：操作身份合成路径可指定容器格式；speak 既有消费者缺省 mp3 不变 */
  format?: AudioFormat;
  signal?: AbortSignal;
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

/** A01：同 operation_id 重放但关键合成输入与已持久资产不一致——不能静默返回错音频 */
export class OperationFingerprintConflictError extends Error {
  constructor(readonly operationId: string, readonly mismatches: string[]) {
    super(`operation_conflict: ${operationId} differs in ${mismatches.join(',')}`);
    this.name = 'OperationFingerprintConflictError';
  }
}

export class VoiceService {
  /** S1011-020：同 message_id（含 A01 operation_id）的在途任务（speak / 操作合成各一条道）——
   *  并发请求共享结果；值携带已合成字节，恢复路径免二次对象读 */
  private readonly speakInflight = new Map<string, Promise<{ record: VoiceAssetRecord; audio: Buffer }>>();
  private readonly userVoiceInflight = new Map<string, Promise<{ transcript: TranscriptResult; asset: VoiceAssetWithUrl }>>();

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

  /** signal：调用方取消（REST 客户端断开）直达 provider，不在取消后继续收费合成。 */
  async synthesizeAudio(params: SynthesizeParams, signal?: AbortSignal): Promise<TtsAudioResult & { profile: VoiceProfile }> {
    const profile = this.resolveProfile(params.voiceProfileId);
    assertTtsProfileCompatible(profile, this.deps.asyncTtsName);
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
    }, signal);
    this.deps.logger.info('tts_batch_completed', {
      profile: profile.id,
      emotion,
      duration_ms: result.durationMs,
      format: result.format
    });
    return { ...result, profile };
  }

  /**
   * 对方 -> 用户：Batch TTS -> 对象存储 -> voice_assets（规范第 11 节）。
   * message_id 幂等（P1-3）：object key 含 asset_id（不可变），并发请求各写各的
   * 物理 key；DB 唯一索引决定 winner，落败者只清理自己的对象，不会误删 winner。
   */
  async speak(params: SpeakParams): Promise<VoiceAssetWithUrl> {
    if (params.messageId) {
      const existing = this.deps.assetsRepo.findByMessageId(params.messageId);
      if (existing) {
        this.deps.logger.info('voice_asset_idempotent_hit', { message_id: params.messageId });
        return this.withAudioUrl(existing);
      }
      // S1011-020：并发同 message_id 共享在途任务——收费副作用（TTS）只发生一次；
      // DB 唯一索引仍作跨进程兜底
      const inflight = this.speakInflight.get(params.messageId);
      if (inflight) return this.withAudioUrl((await inflight).record);
      const job = this.speakNow(params).finally(() => this.speakInflight.delete(params.messageId!));
      this.speakInflight.set(params.messageId, job);
      return this.withAudioUrl((await job).record);
    }
    return this.withAudioUrl((await this.speakNow(params)).record);
  }

  /**
   * A01（联合审计 2026-10-27）：带稳定操作身份的合成——复用 speak(message_id) 的既有持久
   * 资产/幂等机制（DB 唯一索引 + 在途共享），不是第二套合成状态：
   * - 生成成功**先落 voice_assets（对象+DB）再交付响应**：响应丢失后可按 operation_id 找回；
   * - 同 operation_id 重放/并发只发生一次收费合成，直接取回同一资产；
   * - 同键但关键输入（文本/音色/情绪/语速/格式/语言/tts_script）不一致=明确冲突，不串音。
   * operation_id 是调用方（est）的操作身份，Siren 不读取 est 表、不创建聊天对象。
   */
  async synthesizeWithOperation(
    params: SynthesizeParams & { operationId: string },
    signal?: AbortSignal
  ): Promise<{ audio: Buffer; asset: VoiceAssetWithUrl; replayed: boolean }> {
    const existing = this.deps.assetsRepo.findByMessageId(params.operationId);
    if (existing) {
      await this.assertOperationFingerprint(existing, params);
      const audio = await this.deps.store.get(existing.objectKey);
      if (!audio) throw new Error(`voice_asset_object_missing:${existing.id}`);
      return { audio, asset: await this.withAudioUrl(existing), replayed: true };
    }
    const inflight = this.speakInflight.get(params.operationId);
    if (inflight) {
      const joined = await inflight;
      return { audio: joined.audio, asset: await this.withAudioUrl(joined.record), replayed: true };
    }
    const job = this.speakNow({
      text: params.text,
      ttsScript: params.ttsScript,
      voiceProfileId: params.voiceProfileId,
      emotion: parseEmotion(params.emotion),
      speed: params.speed,
      language: params.language,
      messageId: params.operationId,
      direction: 'assistant',
      format: params.format ?? 'mp3',
      signal
    }).finally(() => this.speakInflight.delete(params.operationId));
    this.speakInflight.set(params.operationId, job);
    const done = await job;
    return { audio: done.audio, asset: await this.withAudioUrl(done.record), replayed: false };
  }

  /** A01：重放命中后校验请求指纹与已持久资产一致（speed 只在 meta sidecar，操作路径资产必有） */
  private async assertOperationFingerprint(
    existing: VoiceAssetRecord,
    params: SynthesizeParams & { operationId: string }
  ): Promise<void> {
    const profile = this.resolveProfile(params.voiceProfileId);
    const emotion = parseEmotion(params.emotion) ?? profile.defaultEmotion;
    const style = resolveStyle(profile, { emotion, speed: params.speed });
    const format: AudioFormat = params.format ?? 'mp3';
    const mismatches: string[] = [];
    if (existing.text !== null && existing.text !== params.text) mismatches.push('text');
    if (existing.voiceProfile !== profile.id) mismatches.push('voice_profile');
    if (existing.emotion !== null && existing.emotion !== emotion) mismatches.push('emotion');
    if (existing.language !== null && existing.language !== (params.language ?? profile.language)) mismatches.push('language');
    if ((existing.ttsScript ?? null) !== (params.ttsScript ?? null)) mismatches.push('tts_script');
    // speed 与请求格式不在 DB 正本（DB audio_format=provider 实际产出格式，如 mock 恒 wav）：
    // 查 meta sidecar（操作路径资产必然写入）；sidecar 不可读/缺字段=无法证明一致，如实冲突
    const metaRaw = await this.deps.store.get(metaObjectKey(existing.objectKey)).catch(() => undefined);
    const meta = metaRaw ? (JSON.parse(metaRaw.toString('utf8')) as { speed?: unknown; requested_format?: unknown }) : undefined;
    if (meta?.speed !== style.speed) mismatches.push('speed');
    const requestFormat = meta?.requested_format ?? existing.audioFormat;
    if (requestFormat !== format) mismatches.push('format');
    if (mismatches.length > 0) throw new OperationFingerprintConflictError(params.operationId, mismatches);
  }

  private async speakNow(params: SpeakParams): Promise<{ record: VoiceAssetRecord; audio: Buffer }> {
    const profile = this.resolveProfile(params.voiceProfileId);
    assertTtsProfileCompatible(profile, this.deps.asyncTtsName);
    const emotion = params.emotion ?? profile.defaultEmotion;
    const style = resolveStyle(profile, { emotion, speed: params.speed });
    const format: AudioFormat = params.format ?? 'mp3';
    const synthesized = await this.deps.asyncTts.synthesize({
      text: params.text,
      ttsScript: params.ttsScript,
      profile,
      style,
      format,
      sampleRate: 24000,
      language: params.language ?? profile.language
    }, params.signal);

    const assetId = randomUUID();
    const messageId = params.messageId ?? assetId;
    const conversationId = params.conversationId ?? null;
    const objectKey = buildObjectKey(conversationId, messageId, synthesized.format, assetId);
    await this.deps.store.put(objectKey, synthesized.audio, contentTypeFor(synthesized.format));
    await this.deps.store.put(
      metaObjectKey(objectKey),
      buildAssetMeta({
        id: assetId,
        conversationId,
        messageId,
        direction: params.direction ?? 'assistant',
        voiceProfileId: profile.id,
        emotion,
        speed: style.speed,
        requestedFormat: format,
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
      // 并发同 message_id：以先落库者为准（幂等）。
      // key 含 asset_id：这里删的是自己的对象，winner 的对象不受影响（P1-3）
      await this.deps.store.delete(objectKey).catch(() => undefined);
      await this.deps.store.delete(metaObjectKey(objectKey)).catch(() => undefined);
      finalRecord = existing;
    }
    this.deps.logger.info('voice_asset_created', {
      voice_message_id: finalRecord.id,
      message_id: finalRecord.messageId,
      duration_ms: finalRecord.durationMs,
      object_key: finalRecord.objectKey
    });
    return { record: finalRecord, audio: synthesized.audio };
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
      // S1011-020：并发同 message_id 共享在途任务——识别/入库只发生一次
      const inflight = this.userVoiceInflight.get(input.messageId);
      if (inflight) return inflight;
      const job = this.storeUserVoiceNow(input).finally(() => this.userVoiceInflight.delete(input.messageId!));
      this.userVoiceInflight.set(input.messageId, job);
      return job;
    }
    return this.storeUserVoiceNow(input);
  }

  private async storeUserVoiceNow(input: {
    audio: Buffer;
    format: string;
    language?: string;
    conversationId?: string;
    messageId?: string;
    voiceProfileId?: string;
  }): Promise<{ transcript: TranscriptResult; asset: VoiceAssetWithUrl }> {
    const transcript = await this.transcribe({
      audio: input.audio,
      format: input.format,
      language: input.language
    });
    const profile = this.resolveProfile(input.voiceProfileId);
    const assetId = randomUUID();
    const messageId = input.messageId ?? assetId;
    const conversationId = input.conversationId ?? null;
    // P1-3：key 含 asset_id，并发同 message_id 不会互相覆盖/误删
    const objectKey = buildObjectKey(conversationId, messageId, normalizeContainer(input.format), assetId);
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
      // 并发落败：清理自己的对象（key 含 asset_id，不影响 winner）
      await this.deps.store.delete(objectKey).catch(() => undefined);
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

  /** R3″（2026-10-24，RE-16）：翻页快照上界（全表 MAX(rowid)）——工具层签发游标用 */
  listSnapshotCeiling(): number {
    return this.deps.assetsRepo.maxRowid();
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

