/**
 * voice_assets 仓储。message_id 支持幂等（规范第 29/47 节）。
 */
import type { VoiceAssetRecord, VoiceDirection } from '@siren/contracts';
import { createHash } from 'node:crypto';
import type { FieldCipher } from '../field-crypto.ts';
import type { SqliteDatabase } from '../sqlite.ts';

interface AssetRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  call_id: string | null;
  turn_id: string | null;
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
  completeness: string | null;
  created_at: number;
}

function rowToRecord(row: AssetRow, cipher: FieldCipher | null): VoiceAssetRecord {
  const open = (value: string | null): string | null => (cipher ? cipher.open(value) : value);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    callId: row.call_id,
    turnId: row.turn_id,
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
    completeness: (row.completeness === 'partial' ? 'partial' : row.completeness === 'complete' ? 'complete' : undefined),
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
  /** R3″（2026-10-24，RE-16）：keyset 游标 {c: created_at, i: id, r: rowid 快照上界, q: 查询指纹}
   *  base64url JSON——并发新增不漂移；坏游标=抛错（不静默当首页）；游标绑定原查询，换过滤器=错。
   *  r=签发时刻全表 MAX(rowid)：签发后插入的行（同毫秒 created_at 也一样）不进进行中的翻页快照。 */
  cursor?: string;
}

/** 游标无效错误（工具层转为 isError；不再静默回首页） */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** 游标签发/校验共用：字段不齐/编码坏=InvalidCursorError */
export function encodeListCursor(keyset: { c: number; i: string; r: number; q: string }): string {
  return Buffer.from(JSON.stringify(keyset), 'utf8').toString('base64url');
}

export function listQueryFingerprint(filter: { conversationId?: string; messageId?: string; direction?: VoiceDirection; fromMs?: number; toMs?: number }): string {
  // JV-11（联合审计 2026-10-26）：固定长度指纹（sha256 截断）——此前指纹是 filter 的
  // base64（可变长），UUID 会话 + 时间过滤的合法游标达 207 字符，超过自身 schema 的
  // 200 上限，第二页被 -32602 拒绝。固定 16 字符后 cursor 有确定上界（<150）。
  // 编码变更：旧游标的 q 与新指纹不等 → INVALID_CURSOR 诚实拒绝（重启分页，不误读）。
  return createHash('sha256')
    .update(JSON.stringify([filter.conversationId ?? null, filter.messageId ?? null, filter.direction ?? null, filter.fromMs ?? null, filter.toMs ?? null]))
    .digest('hex')
    .slice(0, 16);
}

export function decodeListCursor(cursor: string, filter: { conversationId?: string; messageId?: string; direction?: VoiceDirection; fromMs?: number; toMs?: number }): { c: number; i: string; r: number } {
  let parsed: { c?: unknown; i?: unknown; r?: unknown; q?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new InvalidCursorError('INVALID_CURSOR: cursor is not readable');
  }
  if (typeof parsed.c !== 'number' || typeof parsed.i !== 'string' || typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 0) {
    throw new InvalidCursorError('INVALID_CURSOR: cursor fields malformed');
  }
  if (typeof parsed.q !== 'string' || parsed.q !== listQueryFingerprint(filter)) {
    throw new InvalidCursorError('INVALID_CURSOR: cursor belongs to a different query (filter changed) — restart from the first page');
  }
  return { c: parsed.c, i: parsed.i, r: parsed.r };
}

export class VoiceAssetsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    /** S1011-013：正文类字段静态加密（null=不加密，兼容既有测试与数据） */
    private readonly cipher: FieldCipher | null = null
  ) {}

  insert(record: VoiceAssetRecord): { inserted: true; existing?: never } | { inserted: false; existing: VoiceAssetRecord } {
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
        object_key, checksum, completeness, call_id, turn_id, created_at
      ) VALUES (
        @id, @conversationId, @messageId, @direction, @voiceProfile, @provider, @providerVoiceId,
        @audioFormat, @sampleRate, @durationMs, @language, @emotion, @text, @ttsScript, @transcript,
        @objectKey, @checksum, @completeness, @callId, @turnId, @createdAt
      )
    `);
    try {
      stmt.run({ ...stored, completeness: record.completeness ?? null, callId: record.callId ?? null, turnId: record.turnId ?? null });
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
    // R3″（2026-10-24，RE-16）：keyset 分页——游标 (created_at,id) 严格小于当前页尾 +
    // rowid ≤ 签发时刻上界 r（签发后插入不进进行中的快照）；游标绑定原查询指纹；
    // 坏游标/换过滤器=InvalidCursorError（调用方如实报错，不静默当首页）。
    // OFFSET 路径保留给旧内部调用
    let keyset: { c: number; i: string; r: number } | null = null;
    if (filter.cursor) {
      keyset = decodeListCursor(filter.cursor, filter);
    }
    if (keyset) {
      conditions.push('(created_at < @kc OR (created_at = @kc AND id < @ki))');
      params.kc = keyset.c;
      params.ki = keyset.i;
      conditions.push('rowid <= @kr');
      params.kr = keyset.r;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;

    const rows = this.db
      .prepare(`SELECT * FROM voice_assets ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`)
      .all({ ...params, limit }) as AssetRow[]; // JV-Q1：删 OFFSET 旧分支（keyset 已取代）
    return rows.map((row) => rowToRecord(row, this.cipher));
  }

  /** R3″（2026-10-24，RE-16）：签发翻页快照上界——全表 MAX(rowid)（签发后的插入不进快照）。 */
  maxRowid(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM voice_assets').get() as { m: number };
    return row.m;
  }
}
