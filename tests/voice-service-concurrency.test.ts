/**
 * P1-3：message_id 并发幂等。
 * 并发同 message_id 的 speak / storeUserVoice：
 * - 只保留一个最终 asset
 * - winner 的对象不被落败者误删（immutable object key 含 asset_id）
 */
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore, VoiceAssetsRepository, openDatabase } from '@siren/storage';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import { VoiceService } from '@siren/voice-core';
import { buildTestVoice, silentLogger, testConfig, testProfiles } from './helpers.ts';

/** 记录 put/delete 的内存存储（测试并发清理行为） */
class RecordingStore extends MemoryObjectStore {
  readonly puts: { key: string; contentType: string }[] = [];
  readonly deletes: string[] = [];

  override async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.puts.push({ key, contentType });
    return super.put(key, body, contentType);
  }

  override async delete(key: string): Promise<void> {
    this.deletes.push(key);
    return super.delete(key);
  }

  audioPuts(): { key: string; contentType: string }[] {
    return this.puts.filter((put) => put.key.includes('/audio.'));
  }
}

async function buildVoiceWithSharedStore(): Promise<{
  voice: VoiceService;
  store: RecordingStore;
  assetsRepo: VoiceAssetsRepository;
}> {
  const base = buildTestVoice();
  const db = openDatabase(':memory:');
  const assetsRepo = new VoiceAssetsRepository(db);
  const store = new RecordingStore();
  const voice = new VoiceService({
    config: testConfig(),
    logger: silentLogger,
    asr: new MockAsrProvider(),
    asyncTts: new MockTtsProvider(),
    core: new MockCoreBridge(),
    store,
    assetsRepo,
    sessionsRepo: base.sessionsRepo,
    turnsRepo: base.turnsRepo,
    profiles: testProfiles()
  });
  return { voice, store, assetsRepo };
}

describe('message_id 并发幂等（P1-3 immutable object key）', () => {
  it('并发 speak(同 message_id)：恰好一个 asset，winner 对象完好，落败者只删自己的对象', async () => {
    const { voice, store, assetsRepo } = await buildVoiceWithSharedStore();
    const messageId = 'msg-concurrent-1';

    const [a, b] = await Promise.all([
      voice.speak({ text: '第一个并发请求。', messageId, conversationId: 'conv-c' }),
      voice.speak({ text: '第二个并发请求。', messageId, conversationId: 'conv-c' })
    ]);

    // DB 只有一条 message_id 记录；两个调用方拿到同一条
    const all = assetsRepo.list({ messageId });
    expect(all.length).toBe(1);
    expect(a.id).toBe(b.id);

    // 并发产生了两个不同的物理 key（各含自己的 asset_id）
    const audioPuts = store.audioPuts();
    expect(audioPuts.length).toBe(2);
    expect(new Set(audioPuts.map((put) => put.key)).size).toBe(2);

    // winner 的音频对象仍然存在（没有被 loser 删掉）
    const winnerKey = all[0].objectKey;
    expect(await store.exists(winnerKey)).toBe(true);
    const audio = await store.get(winnerKey);
    expect(audio.length).toBeGreaterThan(0);

    // loser 的对象（另一个 key）被清理
    const loserKey = audioPuts.find((put) => put.key !== winnerKey)?.key;
    expect(loserKey).toBeTruthy();
    expect(await store.exists(loserKey as string)).toBe(false);
  });

  it('顺序重复 speak(同 message_id)：幂等命中，不新增 asset', async () => {
    const { voice, assetsRepo } = await buildVoiceWithSharedStore();
    const first = await voice.speak({ text: '同一句。', messageId: 'msg-seq-1' });
    const second = await voice.speak({ text: '同一句。', messageId: 'msg-seq-1' });
    expect(second.id).toBe(first.id);
    expect(assetsRepo.list({ messageId: 'msg-seq-1' }).length).toBe(1);
  });

  it('并发 storeUserVoice(同 message_id)：一个 user asset，winner 对象不丢', async () => {
    const { voice, store, assetsRepo } = await buildVoiceWithSharedStore();
    const audio = Buffer.alloc(2048, 7);
    const messageId = 'msg-user-1';

    const results = await Promise.all([
      voice.storeUserVoice({ audio, format: 'webm', messageId, conversationId: 'conv-u' }),
      voice.storeUserVoice({ audio, format: 'webm', messageId, conversationId: 'conv-u' })
    ]);

    const all = assetsRepo.list({ messageId });
    expect(all.length).toBe(1);
    expect(results[0].asset.id).toBe(results[1].asset.id);
    expect(await store.exists(all[0].objectKey)).toBe(true);
  });

  it('审计回归：m4a / webm 上传的对象扩展名与 Content-Type 闭环（不再伪装成 mp3）', async () => {
    const { voice, store, assetsRepo } = await buildVoiceWithSharedStore();
    const audio = Buffer.alloc(512, 3);

    await voice.storeUserVoice({ audio, format: 'm4a', messageId: 'msg-fmt-m4a', conversationId: 'conv-fmt' });
    await voice.storeUserVoice({ audio, format: 'webm', messageId: 'msg-fmt-webm', conversationId: 'conv-fmt' });

    const m4a = assetsRepo.list({ messageId: 'msg-fmt-m4a' })[0];
    const webm = assetsRepo.list({ messageId: 'msg-fmt-webm' })[0];

    // DB 格式 / 对象扩展名 / MIME 三者一致（FORMAT_META 单一来源）
    expect(m4a.audioFormat).toBe('m4a');
    expect(m4a.objectKey.endsWith('/audio.m4a')).toBe(true);
    expect(store.audioPuts().find((put) => put.key === m4a.objectKey)?.contentType).toBe('audio/mp4');

    expect(webm.audioFormat).toBe('webm');
    expect(webm.objectKey.endsWith('/audio.webm')).toBe(true);
    expect(store.audioPuts().find((put) => put.key === webm.objectKey)?.contentType).toBe('audio/webm');

    // assistant 语音条：key/MIME 与 provider 实际返回格式一致（Mock TTS 返回 wav）
    await voice.speak({ text: '语音条。', messageId: 'msg-fmt-tts', conversationId: 'conv-fmt' });
    const tts = assetsRepo.list({ messageId: 'msg-fmt-tts' })[0];
    expect(tts.objectKey.endsWith(`/audio.${tts.audioFormat}`)).toBe(true);
    const ttsMime = store.audioPuts().find((put) => put.key === tts.objectKey)?.contentType;
    expect(ttsMime).toBe(tts.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav');
  });
});
