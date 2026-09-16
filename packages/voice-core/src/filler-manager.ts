/**
 * Filler 系统（规范第 24 节）。
 * - 目录：data/fillers/{profile}/{neutral|positive|low}/*.pcm（PCM16 24kHz mono）
 * - 必须提前由 scripts/generate-fillers.ts 生成缓存；运行时禁止临时 TTS filler
 * - FILLER_ENABLED=false 时整体停用
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@siren/telemetry';
import { chunkPcm16, samplesForDuration } from '@siren/audio';
import { REALTIME_OUTPUT_SAMPLE_RATE } from '@siren/contracts';
import type { FillerCategory } from './emotion.ts';

interface FillerEntry {
  file: string;
  pcm: Buffer;
}

export class FillerManager {
  private readonly cache = new Map<string, FillerEntry[]>(); // `${profileId}/${category}`
  private loadPromise: Promise<void> | null = null;
  private warnedMissing = false;
  private _available = false;

  constructor(
    private readonly fillersDir: string,
    private readonly enabled: boolean,
    private readonly logger?: Logger
  ) {}

  get available(): boolean {
    return this.enabled && this._available;
  }

  /** 预加载（通话建立时调用一次即可） */
  preload(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((error) => {
        this.logger?.warn('filler_load_failed', { error_message: (error as Error).message });
      });
    }
    return this.loadPromise;
  }

  /** 随机挑选一个 filler，切成 20ms PCM 帧 */
  pickFrames(profileId: string, category: FillerCategory): Buffer[] | null {
    if (!this.available) return null;
    const entries = this.cache.get(`${profileId}/${category}`);
    if (!entries || entries.length === 0) return null;
    const entry = entries[Math.floor(Math.random() * entries.length)];
    return chunkPcm16(entry.pcm, samplesForDuration(REALTIME_OUTPUT_SAMPLE_RATE, 20));
  }

  private async load(): Promise<void> {
    const profiles = await listDirs(this.fillersDir);
    for (const profileDir of profiles) {
      for (const category of ['neutral', 'positive', 'low'] as const) {
        const dir = join(this.fillersDir, profileDir, category);
        const files = (await readdir(dir).catch(() => [] as string[]))
          .filter((name) => name.endsWith('.pcm'))
          .sort();
        const entries: FillerEntry[] = [];
        for (const file of files) {
          try {
            entries.push({ file, pcm: await readFile(join(dir, file)) });
          } catch {
            // 单个文件损坏不阻塞整体
          }
        }
        if (entries.length > 0) {
          this.cache.set(`${profileDir}/${category}`, entries);
        }
      }
    }
    this._available = this.cache.size > 0;
    if (!this._available && !this.warnedMissing) {
      this.warnedMissing = true;
      this.logger?.warn('filler_disabled_no_files', {
        dir: this.fillersDir,
        hint: 'run `pnpm fillers` to pre-generate filler audio'
      });
    } else if (this._available) {
      this.logger?.info('filler_loaded', { categories: [...this.cache.keys()] });
    }
  }
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
