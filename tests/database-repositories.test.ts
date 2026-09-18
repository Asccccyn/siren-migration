import { describe, expect, it } from 'vitest';
import { CallSessionsRepository, CallTurnsRepository, VoiceAssetsRepository, openDatabase } from '@siren/storage';

describe('SQLite 仓储', () => {
  it('voice_assets：插入与查询', () => {
    const db = openDatabase(':memory:');
    const repo = new VoiceAssetsRepository(db);
    repo.insert(makeAsset('id-1', 'msg-1', 'conv-1', 'assistant'));
    const found = repo.findById('id-1');
    expect(found?.messageId).toBe('msg-1');
    expect(found?.direction).toBe('assistant');
    expect(found?.objectKey).toBe('voice/2026/09/conv-1/msg-1/audio.mp3');
  });

  it('message_id 幂等：重复插入返回既有记录', () => {
    const db = openDatabase(':memory:');
    const repo = new VoiceAssetsRepository(db);
    const first = repo.insert(makeAsset('id-1', 'msg-1', 'conv-1', 'assistant'));
    expect(first.inserted).toBe(true);
    const second = repo.insert(makeAsset('id-2', 'msg-1', 'conv-1', 'assistant'));
    expect(second.inserted).toBe(false);
    expect(second.existing?.id).toBe('id-1');
  });

  it('list 过滤 conversation / direction / 时间范围', () => {
    const db = openDatabase(':memory:');
    const repo = new VoiceAssetsRepository(db);
    const now = Date.now();
    repo.insert(makeAsset('a', 'm-a', 'conv-1', 'assistant', now - 5000));
    repo.insert(makeAsset('b', 'm-b', 'conv-1', 'user', now - 1000));
    repo.insert(makeAsset('c', 'm-c', 'conv-2', 'assistant', now));

    expect(repo.list({ conversationId: 'conv-1' }).map((r) => r.id)).toEqual(['b', 'a']);
    expect(repo.list({ conversationId: 'conv-1', direction: 'user' }).map((r) => r.id)).toEqual(['b']);
    expect(repo.list({ fromMs: now - 2000 }).map((r) => r.id)).toEqual(['c', 'b']);
    expect(repo.list({ messageId: 'm-c' }).map((r) => r.id)).toEqual(['c']);
    expect(repo.list({ limit: 2 }).length).toBe(2);
  });

  it('call_sessions / call_turns 生命周期', () => {
    const db = openDatabase(':memory:');
    const sessions = new CallSessionsRepository(db);
    const turns = new CallTurnsRepository(db);
    sessions.insert({
      id: 'call-1',
      conversation_id: 'conv-1',
      voice_profile: 'main',
      started_at: null,
      ended_at: null,
      status: 'active',
      asr_provider: 'mock',
      tts_provider: 'mock',
      created_at: Date.now()
    });
    sessions.markStarted('call-1', 111);
    expect(sessions.findById('call-1')?.started_at).toBe(111);
    sessions.markEnded('call-1', 222, 'ended');
    expect(sessions.findById('call-1')?.status).toBe('ended');

    turns.insert({
      id: 'turn-1',
      call_id: 'call-1',
      turn_index: 1,
      user_text: '你好',
      assistant_text: '你好呀。',
      started_at: 100,
      ended_at: 200,
      interrupted: 0,
      asr_latency_ms: 50,
      llm_first_token_ms: 120,
      tts_first_audio_ms: 300,
      created_at: Date.now()
    });
    const rows = turns.listByCall('call-1');
    expect(rows.length).toBe(1);
    expect(rows[0].user_text).toBe('你好');
    expect(rows[0].interrupted).toBe(0);
    expect(rows[0].llm_first_token_ms).toBe(120);
  });

  it('迁移幂等（重复打开安全）', async () => {
    const db = openDatabase(':memory:');
    // openDatabase 内部已跑迁移，再显式跑一次不应报错
    const { migrate } = await import('@siren/storage');
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM _migrations').get()).toEqual({ n: 1 });
  });

  it('审计回归：endAllActive 启动清扫（创建后从未连 WS 的 call 不永久残留 active）', () => {
    const db = openDatabase(':memory:');
    const sessions = new CallSessionsRepository(db);
    const now = Date.now();
    insertSession(sessions, 'call-stale-1', now - 60_000);
    insertSession(sessions, 'call-stale-2', now - 30_000);
    sessions.markEnded('call-stale-2', now - 1000, 'ended'); // 已正常结束的不动

    const cleaned = sessions.endAllActive(now);
    expect(cleaned).toBe(1);
    expect(sessions.findById('call-stale-1')?.status).toBe('ended');
    expect(sessions.findById('call-stale-1')?.ended_at).toBe(now);
    expect(sessions.findById('call-stale-2')?.status).toBe('ended');
    expect(sessions.findById('call-stale-2')?.ended_at).toBeLessThan(now);
    // 再次清扫无变化
    expect(sessions.endAllActive(now + 1)).toBe(0);
  });
});

function insertSession(sessions: CallSessionsRepository, id: string, createdAt: number): void {
  sessions.insert({
    id,
    conversation_id: 'conv-stale',
    voice_profile: 'main',
    started_at: null,
    ended_at: null,
    status: 'active',
    asr_provider: 'mock',
    tts_provider: 'mock',
    created_at: createdAt
  });
}

function makeAsset(
  id: string,
  messageId: string,
  conversationId: string,
  direction: 'user' | 'assistant',
  createdAt = Date.now()
) {
  return {
    id,
    conversationId,
    messageId,
    direction,
    voiceProfile: 'main',
    provider: 'volc',
    providerVoiceId: 'v1',
    audioFormat: 'mp3',
    sampleRate: 24000,
    durationMs: 1000,
    language: 'zh-CN',
    emotion: 'warm',
    text: 't',
    ttsScript: null,
    transcript: null,
    objectKey: `voice/2026/09/${conversationId}/${messageId}/audio.mp3`,
    checksum: 'x',
    createdAt
  };
}
