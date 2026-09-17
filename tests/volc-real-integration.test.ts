/**
 * 真实火山 Provider 集成测试（P0-8/P0-9 验收）。
 * 仅在 VOLC_REAL_INTEGRATION=1 且凭据存在时运行（describe.skipIf）；
 * 凭据只从环境变量读取，绝不写入仓库。
 *
 * 运行方式：
 *   VOLC_REAL_INTEGRATION=1 \
 *   VOLC_APP_ID=... VOLC_ACCESS_TOKEN=... VOLC_VOICE_ID=... \
 *   npx vitest run tests/volc-real-integration.test.ts
 */
import { describe, expect, it } from 'vitest';
import { VolcStreamAsrProvider } from '@siren/provider-volc-asr';
import { VolcBidirectionalTtsProvider } from '@siren/provider-volc-tts';
import { generateMockPcm } from '@siren/provider-mock';
import type { TtsRequest, VoiceProfile, VoiceStyle } from '@siren/contracts';

const ENABLED = process.env.VOLC_REAL_INTEGRATION === '1';
const APP_ID = process.env.VOLC_APP_ID ?? '';
const ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN ?? '';
const VOICE_ID = process.env.VOLC_VOICE_ID ?? '';

const PROFILE: VoiceProfile = {
  id: 'main',
  displayName: '对方',
  language: 'zh-CN',
  provider: 'volc',
  voiceId: VOICE_ID,
  defaultEmotion: 'warm',
  defaultSpeed: 1.0
};

describe.skipIf(!ENABLED || !APP_ID || !ACCESS_TOKEN)('真实火山 Provider 集成（VOLC_REAL_INTEGRATION=1）', () => {
  it('ASR：真实流式识别（大模型 sauc v3，喂入正弦 PCM，期待非空 transcript 或明确空结果）', async () => {
    const provider = new VolcStreamAsrProvider({
      appId: APP_ID,
      accessToken: ACCESS_TOKEN,
      resourceId: process.env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
      wsUrl: process.env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
      sampleRate: 16000,
      connectTimeoutMs: 8000
    });
    const stream = await provider.createStream({ language: 'zh-CN' }, {});
    // 注意：Mock 正弦波不是语音，真实 ASR 可能返回空文本——这里主要验证
    // 协议链路可用（建连 / feed / last packet / final 返回不抛错）
    for (let i = 0; i < 10; i++) stream.feed(generateMockPcm('测试音频' + i, 16000, 300));
    const result = await stream.end();
    expect(typeof result.text).toBe('string');
    expect(result.language).toBeTruthy();
  }, 60000);

  it.skipIf(!VOICE_ID)('TTS：真实双向流式合成（首块音频延迟记录）', async () => {
    const provider = new VolcBidirectionalTtsProvider({
      appId: APP_ID,
      accessToken: ACCESS_TOKEN,
      resourceId: process.env.VOLC_TTS_RESOURCE_ID ?? 'volc.service_type.10029',
      wsUrl: process.env.VOLC_TTS_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      connectTimeoutMs: 8000,
      sessionTimeoutMs: 30000
    });
    const request: TtsRequest = {
      text: '你好，我是对方。这是一段真实流式合成的测试语音。',
      profile: PROFILE,
      style: { emotion: 'warm', speed: 1 } as VoiceStyle,
      format: 'pcm',
      sampleRate: 24000
    };
    const started = Date.now();
    let firstAudioMs: number | null = null;
    let chunks = 0;
    let bytes = 0;
    for await (const chunk of provider.synthesizeStream(request)) {
      if (firstAudioMs === null) firstAudioMs = Date.now() - started;
      chunks++;
      bytes += chunk.audio.length;
      expect(chunk.sampleRate).toBe(24000);
    }
    console.log(JSON.stringify({ first_audio_ms: firstAudioMs, chunks, bytes }));
    expect(chunks).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(0);
    expect(firstAudioMs).toBeLessThan(5000);
  }, 60000);
});
