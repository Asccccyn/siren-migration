/**
 * voice_assets 仓储。message_id 支持幂等（规范第 29/47 节）。
 */
import type { VoiceAssetRecord, VoiceDirection } from '@siren/contracts';
import type { SqliteDatabase } from '../sqlite.ts';

interface AssetRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  direction: string;
  voice_profile: string;
  provider: string;
  provider_voice_id: string | null;
  audio_format: string;
  sample_rate: number;
  duration_ms: number;
  language: string | null;
  emotion: string | null;
  text: string | null;
  tts_script: string | null;
  transcript: string | null;
  object_key: string;
  checksum: string | null;
  created_at: number;
}

function rowToRecord(row: AssetRow): VoiceAssetRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    direction: row.direction as VoiceDirection,
    voiceProfile: row.voice_profile,
    provider: row.provider,
    providerVoiceId: row.provider_voice_id,
    audioFormat: row.audio_format,
    sampleRate: row.sample_rate,
    durationMs: row.duration_ms,
    language: row.language,
    emotion: row.emotion,
    text: row.text,
    ttsScript: row.tts_script,
    transcript: row.transcript,
    objectKey: row.object_key,
    checksum: row.checksum,
    createdAt: row.created_at
  };
}

export interface ListAssetsFilter {
  conversationId?: string;
  messageId?: string;
  direction?: VoiceDirection;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  offset?: number;
}

export class VoiceAssetsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: VoiceAssetRecord): { inserted: boolean; existing?: VoiceAssetRecord } {
    const stmt = this.db.prepare(`
      INSERT INTO voice_assets (
        id, conversation_id, message_id, direction, voice_profile, provider, provider_voice_id,
        audio_format, sample_rate, duration_ms, language, emotion, text, tts_script, transcript,
        object_key, checksum, created_at
      ) VALUES (
        @id, @conversationId, @messageId, @direction, @voiceProfile, @provider, @providerVoiceId,
        @audioFormat, @sampleRate, @durationMs, @language, @emotion, @text, @ttsScript, @transcript,
        @objectKey, @checksum, @createdAt
      )
    `);
    try {
      stmt.run(record);
      return { inserted: true };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = record.messageId ? this.findByMessageId(record.messageId) : undefined;
        if (existing) return { inserted: false, existing };
      }
      throw error;
    }
  }

  findById(id: string): VoiceAssetRecord | undefined {
    const row = this.db.prepare('SELECT * FROM voice_assets WHERE id = ?').get(id) as AssetRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  findByMessageId(messageId: string): VoiceAssetRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM voice_assets WHERE message_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(messageId) as AssetRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(filter: ListAssetsFilter): VoiceAssetRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.conversationId) {
      conditions.push('conversation_id = @conversationId');
      params.conversationId = filter.conversationId;
    }
    if (filter.messageId) {
      conditions.push('message_id = @messageId');
      params.messageId = filter.messageId;
    }
    if (filter.direction) {
      conditions.push('direction = @direction');
      params.direction = filter.direction;
    }
    if (filter.fromMs !== undefined) {
      conditions.push('created_at >= @fromMs');
      params.fromMs = filter.fromMs;
    }
    if (filter.toMs !== undefined) {
      conditions.push('created_at <= @toMs');
      params.toMs = filter.toMs;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM voice_assets ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as AssetRow[];
    return rows.map(rowToRecord);
  }
}
