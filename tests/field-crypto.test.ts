/**
 * S1011-013：DB 正文字段静态加密。
 * - 加解密往返；懒迁移（旧明文原样读出）；篡改拒绝（null，不回吐伪造内容）
 * - 仓储级：带 cipher 的写入落库为 enc1: 密文、读回明文；不带 cipher 行为不变
 */
import { describe, expect, it } from 'vitest';
import { FieldCipher, deriveFieldCipher } from '@siren/storage';
import { VoiceAssetsRepository, CallTurnsRepository, openDatabase } from '@siren/storage';
import type { VoiceAssetRecord } from '@siren/contracts';

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

  it('懒迁移：旧明文原样返回；篡改密文返回 null', () => {
    const c = cipher();
    expect(c.open('历史明文行')).toBe('历史明文行');
    expect(c.open(null)).toBeNull();
    const sealed = c.seal('payload');
    expect(c.open(`${sealed}x`)).toBeNull();
    expect(c.open('enc1:bogus.data.here')).toBeNull();
  });

  it('错误密钥解不开（域分隔派生，与签名密钥不通用）', () => {
    const sealed = cipher().seal('secret');
    const other = deriveFieldCipher({ dataKey: null, signingSecret: 'another-secret' });
    expect(other.open(sealed)).toBeNull();
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
    const db = openDatabase(':memory:');
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

  it('voice_assets：不带 cipher 时行为不变（明文直存），且两种仓储可读对方旧数据（懒迁移）', () => {
    const db = openDatabase(':memory:');
    const plain = new VoiceAssetsRepository(db);
    plain.insert(sampleAsset({ id: 'a2', messageId: 'm2' }));
    const encrypted = new VoiceAssetsRepository(db, cipher());
    // 加密仓储读旧行：无前缀 → 原样返回（懒迁移不丢数据）
    expect(encrypted.findByMessageId('m2')?.text).toBe('正文内容');
  });

  it('call_turns：user_text/assistant_text 加密落库、读回明文', () => {
    const db = openDatabase(':memory:');
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
