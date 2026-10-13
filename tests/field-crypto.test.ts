/**
 * S1011-013：DB 正文字段静态加密。
 * - 加解密往返；兼容读旧明文但不迁移；认证失败明确报错
 * - 仓储级：带 cipher 的写入落库为 enc1: 密文、读回明文；不带 cipher 行为不变
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FieldDecryptionError, deriveFieldCipher, type FieldCipher, type SqliteDatabase } from '@siren/storage';
import { VoiceAssetsRepository, CallTurnsRepository, openDatabase } from '@siren/storage';
import type { VoiceAssetRecord } from '@siren/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { buildMemoryProviders, metaObjectKey } from '@siren/voice-core';
import { silentLogger, testConfig, testProfiles } from './helpers.ts';

const databases: SqliteDatabase[] = [];
const dirs: string[] = [];
function testDatabase() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return db;
}
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function cipher(): FieldCipher {
  return deriveFieldCipher({ dataKey: null, signingSecret: 'test-signing-secret' });
}

describe('FieldCipher（S1011-013）', () => {
  it('加解密往返；同明文两次密文不同（随机 IV）', () => {
    const c = cipher();
    const sealed1 = c.seal('你好，世界。');
    const sealed2 = c.seal('你好，世界。');
    expect(sealed1.startsWith('enc1:')).toBe(true);
    expect(sealed1).not.toBe(sealed2);
    expect(c.open(sealed1)).toBe('你好，世界。');
    expect(c.open(sealed2)).toBe('你好，世界。');
  });

  it('旧明文兼容读取；篡改密文明确报错而非null', () => {
    const c = cipher();
    expect(c.open('历史明文行')).toBe('历史明文行');
    expect(c.open(null)).toBeNull();
    const sealed = c.seal('payload');
    expect(() => c.open(`${sealed}x`)).toThrow(FieldDecryptionError);
    expect(() => c.open('enc1:bogus.data.here')).toThrow(FieldDecryptionError);
  });

  it('错误密钥解不开（域分隔派生，与签名密钥不通用）', () => {
    const sealed = cipher().seal('secret');
    const other = deriveFieldCipher({ dataKey: null, signingSecret: 'another-secret' });
    expect(() => other.open(sealed)).toThrow(FieldDecryptionError);
    expect(cipher().open(sealed)).toBe('secret'); // The old key still recovers the unchanged value.
  });

  it('字面enc1:前缀和空串都作为业务正文加密，不能跳过seal', () => {
    const c = cipher();
    for (const text of ['', 'enc1:', 'enc1:this is literal text', 'enc1:YWJj.ZGVm.Z2hp']) {
      const stored = c.seal(text);
      expect(stored).not.toBe(text);
      expect(c.open(stored)).toBe(text);
    }
  });

  it('严格拒绝截短tag、错误IV长度、编码垃圾和真实字节篡改', () => {
    const c = cipher();
    const stored = c.seal('authenticated fixture');
    const [iv, ciphertext, tag] = stored.slice(5).split('.');
    const altered = Buffer.from(ciphertext, 'base64url');
    altered[0] ^= 1;
    const invalid = [
      `${stored}!!!`, `${stored}=`, `${stored}.extra`,
      `enc1:${iv}.${ciphertext}.${Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url')}`,
      `enc1:${Buffer.alloc(11).toString('base64url')}.${ciphertext}.${tag}`,
      `enc1:${iv}.${altered.toString('base64url')}.${tag}`
    ];
    for (const value of invalid) expect(() => c.open(value)).toThrow(FieldDecryptionError);
    expect(c.open(stored)).toBe('authenticated fixture');
  });
});

function sampleAsset(overrides: Partial<VoiceAssetRecord> = {}): VoiceAssetRecord {
  return {
    id: 'a1',
    conversationId: 'conv-1',
    messageId: 'm1',
    direction: 'assistant',
    voiceProfile: 'main',
    provider: 'volc',
    providerVoiceId: 'S_voice123',
    audioFormat: 'wav',
    sampleRate: 24000,
    durationMs: 1000,
    language: 'zh-CN',
    emotion: 'warm',
    text: '正文内容',
    ttsScript: '<happy>正文内容</happy>',
    transcript: null,
    objectKey: 'voice/a.wav',
    checksum: null,
    createdAt: 1,
    ...overrides
  };
}

describe('仓储级加密（S1011-013）', () => {
  it('voice_assets：带 cipher 写入落库为 enc1: 密文，读回明文；原始列不落明文', () => {
    const db = testDatabase();
    const repo = new VoiceAssetsRepository(db, cipher());
    repo.insert(sampleAsset());
    const raw = db.prepare('SELECT * FROM voice_assets WHERE id = ?').get('a1') as Record<string, unknown>;
    expect(String(raw.text)).toMatch(/^enc1:/);
    expect(String(raw.tts_script)).toMatch(/^enc1:/);
    expect(String(raw.provider_voice_id)).toMatch(/^enc1:/);
    const back = repo.findByMessageId('m1');
    expect(back?.text).toBe('正文内容');
    expect(back?.ttsScript).toBe('<happy>正文内容</happy>');
    expect(back?.providerVoiceId).toBe('S_voice123');
  });

  it('voice_assets：加密仓储兼容读取旧明文，但不声称已迁移', () => {
    const db = testDatabase();
    const plain = new VoiceAssetsRepository(db);
    plain.insert(sampleAsset({ id: 'a2', messageId: 'm2' }));
    const encrypted = new VoiceAssetsRepository(db, cipher());
    // 无前缀的旧行原样返回，读操作不隐式重写历史数据。
    expect(encrypted.findByMessageId('m2')?.text).toBe('正文内容');
    expect((db.prepare('SELECT text FROM voice_assets WHERE id=?').get('a2') as { text: string }).text).toBe('正文内容');
  });

  it('call_turns：user_text/assistant_text 加密落库、读回明文', () => {
    const db = testDatabase();
    db.prepare(
      `INSERT INTO call_sessions (id, voice_profile, started_at, ended_at, status, created_at) VALUES ('c1', 'main', NULL, NULL, 'ended', 1)`
    ).run();
    const repo = new CallTurnsRepository(db, cipher());
    repo.insert({
      id: 't1',
      call_id: 'c1',
      turn_index: 1,
      user_text: '你好',
      assistant_text: '在呢',
      started_at: 1,
      ended_at: 2,
      interrupted: 0,
      asr_latency_ms: 10,
      llm_first_token_ms: null,
      tts_first_audio_ms: null,
      created_at: 1
    });
    const raw = db.prepare('SELECT * FROM call_turns WHERE id = ?').get('t1') as Record<string, unknown>;
    expect(String(raw.user_text)).toMatch(/^enc1:/);
    expect(String(raw.assistant_text)).toMatch(/^enc1:/);
    const rows = repo.listByCall('c1');
    expect(rows[0]?.user_text).toBe('你好');
    expect(rows[0]?.assistant_text).toBe('在呢');
  });
});

describe('字段加密的应用边界', () => {
  async function memoryApp(signingSecret: string, db = testDatabase()) {
    const root = await mkdtemp(join(tmpdir(), 'siren-field-crypto-'));
    dirs.push(root);
    return buildApp({ db, config: testConfig({ DATA_ROOT: root, SIREN_SIGNING_SECRET: signingSecret }),
      logger: silentLogger, providers: buildMemoryProviders(), profiles: testProfiles() });
  }

  it('错钥读API返回明确503，健康检查仍可用，密文不被覆盖', async () => {
    const db = testDatabase();
    new VoiceAssetsRepository(db, cipher()).insert(sampleAsset());
    const before = db.prepare('SELECT text FROM voice_assets WHERE id=?').pluck().get('a1');
    const app = await memoryApp('different-key', db);
    try {
      const response = await app.app.inject({ method: 'GET', url: '/v1/voice/messages/a1' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'data_unreadable' });
      expect((await app.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect(db.prepare('SELECT text FROM voice_assets WHERE id=?').pluck().get('a1')).toBe(before);
      expect(new VoiceAssetsRepository(db, cipher()).findById('a1')?.text).toBe('正文内容');
    } finally { await app.dispose(); }
  });

  it('enc1正文首次与幂等读取一致，meta不再复制正文', async () => {
    const app = await memoryApp('test-signing-secret');
    try {
      const first = await app.voice.speak({ text: 'enc1:用户正文', ttsScript: '发音正文', messageId: 'prefix-fixture' });
      const again = await app.voice.speak({ text: 'enc1:用户正文', messageId: 'prefix-fixture' });
      expect(first.text).toBe('enc1:用户正文');
      expect(again.text).toBe(first.text);
      expect(again.ttsScript).toBe('发音正文');
      const meta = JSON.parse((await app.providers.store.get(metaObjectKey(first.objectKey))).toString());
      expect(meta).not.toHaveProperty('text');
      expect(meta).not.toHaveProperty('tts_script');
      expect(meta).not.toHaveProperty('transcript');
      expect(meta.id).toBe(first.id);
    } finally { await app.dispose(); }
  });
});
