/**
 * 预生成 filler 音频（规范第 24 节）。
 * 用法：pnpm fillers [--profile main] [--mock]
 * 产出：data/fillers/{profile}/{neutral|positive|low}/*.pcm（PCM16 24kHz mono）
 * 运行时 FillerManager 只读文件，绝不临时 TTS。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { REALTIME_OUTPUT_SAMPLE_RATE, type VoiceStyle } from '@siren/contracts';
import { MockTtsProvider } from '@siren/provider-mock';
import { VolcBatchTtsProvider } from '@siren/provider-volc-tts';
import { loadConfig } from '@siren/voice-core';
import { createLogger } from '@siren/telemetry';

const FILLER_LINES: Record<string, string[]> = {
  neutral: ['嗯……', '唔……', '让我想想。', '我想一下。'],
  positive: ['嗯嗯。', '好呀。', '好，好。'],
  low: ['嗯……我在。', '让我缓缓。', '唉……']
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf('--profile');
  const profileId = profileIndex >= 0 ? args[profileIndex + 1] : 'main';
  const useMock = args.includes('--mock');

  try {
    process.loadEnvFile();
  } catch {
    // 无 .env
  }
  const config = loadConfig();
  const logger = createLogger({ level: 'info' });

  const volcReady = Boolean(config.volc.appId && config.volc.accessToken);
  const tts = useMock || !volcReady
    ? new MockTtsProvider()
    : new VolcBatchTtsProvider({
        appId: config.volc.appId,
        accessToken: config.volc.accessToken,
        cluster: config.volc.ttsCluster,
        endpointUrl: config.volc.ttsUrl,
        timeoutMs: config.volc.httpTimeoutMs
      });
  if (useMock || !volcReady) {
    logger.warn('config_warning', {
      message: useMock ? '按 --mock 使用 MockTtsProvider' : '火山凭据缺失，使用 MockTtsProvider 生成占位 filler'
    });
  }

  const profile = {
    id: profileId,
    displayName: profileId,
    language: 'zh-CN',
    provider: (useMock || !volcReady ? 'mock' : 'volc') as 'mock' | 'volc',
    voiceId: useMock || !volcReady ? 'mock' : config.volc.voiceId,
    defaultEmotion: 'neutral' as const,
    defaultSpeed: 1.0
  };
  if (!profile.voiceId) {
    throw new Error('缺少音色：请在 .env 设置 VOLC_VOICE_ID，或使用 --mock');
  }

  let count = 0;
  for (const [category, lines] of Object.entries(FILLER_LINES)) {
    for (const [index, line] of lines.entries()) {
      const style: VoiceStyle = {
        emotion: category === 'positive' ? 'warm' : category === 'low' ? 'sleepy' : 'neutral'
      };
      const result = await tts.synthesize({
        text: line,
        profile,
        style,
        format: 'pcm',
        sampleRate: REALTIME_OUTPUT_SAMPLE_RATE
      });
      const dir = resolve(config.fillersDir, profileId, category);
      await mkdir(dir, { recursive: true });
      const slug = `${String(index + 1).padStart(2, '0')}-${sanitize(line)}`;
      await writeFile(join(dir, `${slug}.pcm`), result.audio);
      count++;
      logger.info('filler_generated', { category, line_len: line.length, duration_ms: result.durationMs });
    }
  }
  logger.info('fillers_done', { total: count, dir: config.fillersDir });
}

function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, '-') || 'x';
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
