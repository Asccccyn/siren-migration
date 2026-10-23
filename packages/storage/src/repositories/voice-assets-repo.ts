/**
 * voice_assets 仓储。message_id 支持幂等（规范第 29/47 节）。
 */
import type { VoiceAssetRecord, VoiceDirection } from '@siren/contracts';
import type { FieldCipher } from '../field-crypto.ts';
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

function rowToRecord(row: AssetRow, cipher: FieldCipher | null): VoiceAssetRecord {
  const open = (value: string | null): string | null => (cipher ? cipher.open(value) : value);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    direction: row.direction as VoiceDirection,
    voiceProfile: row.voice_profile,
    provider: row.provider,
    providerVoiceId: open(row.provider_voice_id),
    audioFormat: row.audio_format,
    sampleRate: row.sample_rate,
    durationMs: row.duration_ms,
    language: row.language,
    emotion: row.emotion,
    text: open(row.text),
    ttsScript: open(row.tts_script),
    transcript: open(row.transcript),
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
  /** R3′（2026-10-23）：keyset 游标 {c: created_at, i: id}（base64url JSON）——并发新增不漂移 */
  cursor?: string;
}

export class VoiceAssetsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    /** S1011-013：正文类字段静态加密（null=不加密，兼容既有测试与数据） */
    private readonly cipher: FieldCipher | null = null
  ) {}

  insert(record: VoiceAssetRecord): { inserted: boolean; existing?: VoiceAssetRecord } {
    const stored: VoiceAssetRecord = this.cipher
      ? {
          ...record,
          text: record.text !== null ? this.cipher.seal(record.text) : null,
          ttsScript: record.ttsScript !== null ? this.cipher.seal(record.ttsScript) : null,
          transcript: record.transcript !== null ? this.cipher.seal(record.transcript) : null,
          providerVoiceId: record.providerVoiceId !== null ? this.cipher.seal(record.providerVoiceId) : null
        }
      : record;
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
      stmt.run(stored);
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
    return row ? rowToRecord(row, this.cipher) : undefined;
  }

  findByMessageId(messageId: string): VoiceAssetRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM voice_assets WHERE message_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(messageId) as AssetRow | undefined;
    return row ? rowToRecord(row, this.cipher) : undefined;
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
    // R3′（2026-10-23）：keyset 分页——游标 (created_at,id) 严格小于当前页尾；
    // 并发新增（更大 created_at）不进当前游标页，翻页无重复无遗漏；OFFSET 路径保留给旧内部调用
    let keyset: { c: number; i: string } | null = null;
    if (filter.cursor) {
      try { const parsed = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')) as { c?: number; i?: string }; if (typeof parsed.c === 'number' && typeof parsed.i === 'string') keyset = { c: parsed.c, i: parsed.i }; } catch { keyset = null; }
    }
    if (keyset) conditions.push('(created_at < @kc OR (created_at = @kc AND id < @ki))'), (params.kc = keyset.c), (params.ki = keyset.i);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM voice_assets ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as AssetRow[];
    return rows.map((row) => rowToRecord(row, this.cipher));
  }
}
