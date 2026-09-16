/**
 * Voice Profile 加载器：config/voices/*.json 是音色配置的唯一来源。
 * 禁止把 Voice ID 写死在业务代码（规范第 8/47 节）。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SIREN_EMOTIONS,
  type ProviderKind,
  type SirenEmotion,
  type VoiceProfile
} from '@siren/contracts';

export class VoiceProfileRegistry {
  private readonly profiles = new Map<string, VoiceProfile>();
  /** 各 Provider 的环境变量回退音色 */
  private readonly fallbackVoiceIds: Partial<Record<ProviderKind, string>>;

  constructor(fallbackVoiceIds: Partial<Record<ProviderKind, string>> = {}) {
    this.fallbackVoiceIds = fallbackVoiceIds;
  }

  loadSync(profiles: VoiceProfile[]): void {
    for (const profile of profiles) this.profiles.set(profile.id, profile);
  }

  async loadFromDir(dir: string): Promise<{ loaded: number; warnings: string[] }> {
    const warnings: string[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return { loaded: 0, warnings: [`voices dir not readable: ${dir}`] };
    }
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      try {
        const raw = JSON.parse(await readFile(join(dir, entry), 'utf8'));
        const profile = validateProfile(raw);
        if (this.profiles.has(profile.id)) {
          warnings.push(`duplicate voice profile id: ${profile.id}`);
          continue;
        }
        this.profiles.set(profile.id, profile);
      } catch (error) {
        warnings.push(`invalid voice profile ${entry}: ${(error as Error).message}`);
      }
    }
    return { loaded: this.profiles.size, warnings };
  }

  get(id: string | undefined, fallbackId: string): VoiceProfile {
    const target = id ?? fallbackId;
    const profile = this.profiles.get(target);
    if (!profile) {
      throw new Error(`voice profile not found: ${target} (available: ${[...this.profiles.keys()].join(', ') || 'none'})`);
    }
    return profile;
  }

  list(): VoiceProfile[] {
    return [...this.profiles.values()];
  }

  defaultProfileId(): string | undefined {
    return this.profiles.keys().next().value;
  }

  /** profile.voiceId 为空时回退环境变量音色 */
  resolveVoiceId(profile: VoiceProfile): string {
    return profile.voiceId || this.fallbackVoiceIds[profile.provider] || '';
  }

  withResolvedVoiceIds(): VoiceProfile[] {
    return this.list().map((profile) => ({ ...profile, voiceId: this.resolveVoiceId(profile) }));
  }
}

export function validateProfile(raw: unknown): VoiceProfile {
  if (typeof raw !== 'object' || raw === null) throw new Error('profile must be an object');
  const record = raw as Record<string, unknown>;
  const id = requireString(record, 'id');
  const displayName = requireString(record, 'displayName');
  const language = typeof record.language === 'string' ? record.language : 'zh-CN';
  const provider = requireProvider(record.provider);
  const defaultEmotion = validateEmotion(record.defaultEmotion, 'neutral');
  const defaultSpeed = typeof record.defaultSpeed === 'number' ? record.defaultSpeed : 1.0;
  const emotionMap = validateEmotionMap(record.emotionMap);
  return {
    id,
    displayName,
    language,
    provider,
    voiceId: typeof record.voiceId === 'string' ? record.voiceId : '',
    defaultEmotion,
    defaultSpeed,
    ...(emotionMap ? { emotionMap } : {})
  };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`field "${key}" must be a non-empty string`);
  return value;
}

function requireProvider(value: unknown): ProviderKind {
  if (value === 'volc' || value === 'elevenlabs' || value === 'mock') return value;
  throw new Error('field "provider" must be one of volc | elevenlabs | mock');
}

function validateEmotion(value: unknown, fallback: SirenEmotion): SirenEmotion {
  if (typeof value !== 'string') return fallback;
  return (SIREN_EMOTIONS as readonly string[]).includes(value) ? (value as SirenEmotion) : fallback;
}

function validateEmotionMap(value: unknown): VoiceProfile['emotionMap'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: NonNullable<VoiceProfile['emotionMap']> = {};
  for (const [emotion, params] of Object.entries(value as Record<string, unknown>)) {
    if (!(SIREN_EMOTIONS as readonly string[]).includes(emotion)) continue;
    if (typeof params !== 'object' || params === null) continue;
    out[emotion as SirenEmotion] = params as Record<string, number | string>;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
