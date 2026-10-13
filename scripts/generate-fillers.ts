/** Offline filler generation; real synthesis is opt-in by running this command without --mock. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REALTIME_OUTPUT_SAMPLE_RATE, type VoiceProfile, type VoiceStyle } from '@siren/contracts';
import { MockTtsProvider } from '@siren/provider-mock';
import {
  assertTtsProfileCompatible,
  buildProviders,
  loadConfig,
  VoiceProfileRegistry,
  type ProviderBundle,
  type SirenConfig
} from '@siren/voice-core';
import { createLogger, type Logger } from '@siren/telemetry';

const FILLER_LINES: Record<string, string[]> = {
  neutral: ['嗯……', '唔……', '让我想想。', '我想一下。'],
  positive: ['嗯嗯。', '好呀。', '好，好。'],
  low: ['嗯……我在。', '让我缓缓。', '唉……']
};

interface GenerateFillerOptions {
  config: SirenConfig;
  logger: Logger;
  profileId?: string;
  useMock?: boolean;
  createProviders?: typeof buildProviders;
}

/** Importing this module never loads .env, creates providers, or writes audio. */
export async function generateFillers(options: GenerateFillerOptions): Promise<{ count: number; provider: string }> {
  const { config, logger, useMock = false, profileId = 'main' } = options;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) throw new Error('invalid filler profile id');
  let providers: ProviderBundle | undefined;
  try {
    // --mock must remain usable without unrelated production ASR/Core/storage credentials.
    if (!useMock) providers = (options.createProviders ?? buildProviders)(config, logger);
    for (const message of providers?.warnings ?? []) logger.warn('config_warning', { message });
    const provider = providers?.active.asyncTts ?? 'mock';
    if (!useMock && provider.split('(')[0] === 'mock') {
      throw new Error('real filler generation requires a configured TTS provider; use --mock explicitly for placeholders');
    }
    const tts = providers?.asyncTts ?? new MockTtsProvider();
    const profile = useMock ? mockProfile(profileId) : await resolveFillerProfile(config, provider, profileId);
    assertTtsProfileCompatible(profile, provider);
    if (!profile.voiceId) throw new Error('filler voice id is missing in the selected profile and provider configuration');
    const root = join(config.fillersDir, profileId);
    await mkdir(root, { recursive: true });
    const manifest = { profile_id: profileId, provider, mock: useMock, sample_rate: REALTIME_OUTPUT_SAMPLE_RATE };
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, complete: false }));
    const count = await synthesizeFillers(root, profile, tts, logger);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, complete: true, count }));
    logger.info('fillers_done', { total: count, provider, mock: useMock });
    return { count, provider };
  } finally {
    providers?.dispose?.();
  }
}

async function resolveFillerProfile(config: SirenConfig, provider: string, id: string): Promise<VoiceProfile> {
  const registry = new VoiceProfileRegistry({ volc: config.volc.voiceId, elevenlabs: config.elevenlabs.voiceId });
  const loaded = await registry.loadFromDir(config.voicesDir);
  if (loaded.loaded === 0) {
    if (id !== 'main' || loaded.warnings.some((warning) => warning.startsWith('invalid voice profile'))) {
      throw new Error('requested filler profile is unavailable');
    }
    const kind = provider.split('(')[0];
    if (kind !== 'volc' && kind !== 'elevenlabs') throw new Error('unsupported filler TTS provider');
    registry.loadSync([{ ...mockProfile(id), provider: kind, voiceId: '' }]);
  }
  const profile = registry.get(id, id);
  return { ...profile, voiceId: registry.resolveVoiceId(profile) };
}

function mockProfile(id: string): VoiceProfile {
  return { id, displayName: id, language: 'zh-CN', provider: 'mock', voiceId: 'mock', defaultEmotion: 'neutral', defaultSpeed: 1 };
}

async function synthesizeFillers(
  root: string, profile: VoiceProfile, tts: ProviderBundle['asyncTts'], logger: Logger
): Promise<number> {
  let count = 0;
  for (const [category, lines] of Object.entries(FILLER_LINES)) {
    for (const [index, line] of lines.entries()) {
      const style: VoiceStyle = { emotion: category === 'positive' ? 'warm' : category === 'low' ? 'sleepy' : 'neutral' };
      const result = await tts.synthesize({ text: line, profile, style, format: 'pcm', sampleRate: REALTIME_OUTPUT_SAMPLE_RATE });
      if (result.format !== 'pcm' || result.sampleRate !== REALTIME_OUTPUT_SAMPLE_RATE) {
        throw new Error('filler provider must return PCM at the requested sample rate');
      }
      const dir = join(root, category);
      await mkdir(dir, { recursive: true });
      const slug = `${String(index + 1).padStart(2, '0')}-${line.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, '-') || 'x'}`;
      await writeFile(join(dir, `${slug}.pcm`), result.audio);
      count++;
      logger.info('filler_generated', { category, line_len: line.length, duration_ms: result.durationMs });
    }
  }
  return count;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf('--profile');
  if (profileIndex >= 0 && (!args[profileIndex + 1] || args[profileIndex + 1].startsWith('--'))) {
    throw new Error('--profile requires an id');
  }
  try { process.loadEnvFile(); } catch { /* .env is optional for explicit --mock. */ }
  await generateFillers({ config: loadConfig(), logger: createLogger({ level: 'info' }),
    profileId: profileIndex >= 0 ? args[profileIndex + 1] : 'main', useMock: args.includes('--mock') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
