import { describe, expect, it } from 'vitest';
import { MockAsrProvider } from '@siren/provider-mock';
import { buildTestVoice, silentLogger, testConfig, testProfiles } from './helpers.ts';

describe('VoiceService（MCP 与 REST 共用的唯一入口）', () => {
  it('speak：合成 -> 存对象 -> 落库 -> 返回签名 URL', async () => {
    const bundle = buildTestVoice({ coreReply: 'x' });
    const asset = await bundle.voice.speak({
      text: '你，我在。',
      ttsScript: '[softly] 你，我在。',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      emotion: 'warm'
    });
    expect(asset.id).toBeTruthy();
    expect(asset.audioUrl).toContain('/v1/assets/');
    expect(asset.durationMs).toBeGreaterThan(0);
    // 对象存储里音频与 meta 都在
    expect(await bundle.store.exists(asset.objectKey)).toBe(true);
    expect(await bundle.store.exists(asset.objectKey.replace(/audio\.\w+$/, 'meta.json'))).toBe(true);
    // text 与 tts_script 分离保存
    const record = bundle.assetsRepo.findById(asset.id);
    expect(record?.text).toBe('你，我在。');
    expect(record?.ttsScript).toBe('[softly] 你，我在。');
    // tts_script 才是真正交给 TTS 的
    expect(bundle.tts.synthesizedTexts).toContain('[softly] 你，我在。');
  });

  it('message_id 幂等：重复 speak 返回同一资产', async () => {
    const bundle = buildTestVoice();
    const first = await bundle.voice.speak({ text: '第一条', messageId: 'dup-1', conversationId: 'c' });
    const ttsCallsAfterFirst = bundle.tts.calls.batchCount;
    const second = await bundle.voice.speak({ text: '第一条', messageId: 'dup-1', conversationId: 'c' });
    expect(second.id).toBe(first.id);
    expect(bundle.tts.calls.batchCount).toBe(ttsCallsAfterFirst); // 没有重复合成
    const items = bundle.assetsRepo.list({ conversationId: 'c' });
    expect(items.length).toBe(1);
  });

  it('transcribe：ASR 失败抛 ProviderError，不猜测内容', async () => {
    const bundle = buildTestVoice();
    Object.assign(bundle.asr.script, { failEnd: true });
    await expect(
      bundle.voice.transcribe({ audio: Buffer.alloc(100), format: 'webm' })
    ).rejects.toMatchObject({ code: 'asr_failed' });
  });

  it('transcribe：正常路径返回 transcript', async () => {
    const bundle = buildTestVoice();
    const result = await bundle.voice.transcribe({ audio: Buffer.alloc(32000), format: 'webm' });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.language).toBe('zh-CN');
  });

  it('storeUserVoice：转写 + user 方向资产入库（幂等）', async () => {
    const bundle = buildTestVoice();
    const { transcript, asset } = await bundle.voice.storeUserVoice({
      audio: Buffer.alloc(32000),
      format: 'webm',
      conversationId: 'conv-9',
      messageId: 'user-msg-1'
    });
    expect(transcript.text.length).toBeGreaterThan(0);
    expect(asset.direction).toBe('user');
    expect(asset.transcript).toBe(transcript.text);
    const again = await bundle.voice.storeUserVoice({
      audio: Buffer.alloc(32000),
      format: 'webm',
      conversationId: 'conv-9',
      messageId: 'user-msg-1'
    });
    expect(again.asset.id).toBe(asset.id);
  });

  it('list / get 查询', async () => {
    const bundle = buildTestVoice();
    await bundle.voice.speak({ text: '一', messageId: 'l-1', conversationId: 'lc' });
    await bundle.voice.speak({ text: '二', messageId: 'l-2', conversationId: 'lc2' });
    const { items } = await bundle.voice.listVoiceMessages({ conversationId: 'lc' });
    expect(items.length).toBe(1);
    const found = await bundle.voice.getVoiceMessage({ messageId: 'l-2' });
    expect(found?.text).toBe('二');
    expect(await bundle.voice.getVoiceMessage({ id: 'nope' })).toBeNull();
  });

  it('Provider 抽象：VoiceService 只依赖接口，可替换实现', async () => {
    const bundle = buildTestVoice();
    const { VoiceService } = await import('@siren/voice-core');
    const failing = new VoiceService({
      config: testConfig(),
      logger: silentLogger,
      asr: new MockAsrProvider(),
      asyncTts: {
        synthesize: async () => {
          throw new Error('tts down');
        }
      },
      core: bundle.core,
      store: bundle.store,
      assetsRepo: bundle.assetsRepo,
      sessionsRepo: bundle.sessionsRepo,
      turnsRepo: bundle.turnsRepo,
      profiles: testProfiles()
    });
    await expect(failing.speak({ text: 'x' })).rejects.toThrow('tts down');
  });
});

describe('VoiceProfileRegistry', () => {
  it('voiceId 为空时回退环境变量音色', async () => {
    const { VoiceProfileRegistry } = await import('@siren/voice-core');
    const registry = new VoiceProfileRegistry({ volc: 'env-voice-123' });
    registry.loadSync([
      {
        id: 'p1',
        displayName: 'P1',
        language: 'zh-CN',
        provider: 'volc',
        voiceId: '',
        defaultEmotion: 'neutral',
        defaultSpeed: 1
      }
    ]);
    expect(registry.resolveVoiceId(registry.get(undefined, 'p1'))).toBe('env-voice-123');
  });

  it('未知 profile 报错并列出可用项', async () => {
    const registry = testProfiles();
    expect(() => registry.get('ghost', 'main')).toThrow(/not found/);
  });
});

describe('synthesizeAudio（REST /v1/voice/synthesize 底层）', () => {
  it('返回音频与元数据', async () => {
    const bundle = buildTestVoice();
    const result = await bundle.voice.synthesizeAudio({ text: '测试合成', emotion: 'happy', speed: 1.2 });
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result.profile.id).toBe('main');
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
