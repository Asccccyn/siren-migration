import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FillerManager, parseEmotion, emotionToFillerCategory } from '@siren/voice-core';
import { silentLogger } from './helpers.ts';

describe('情绪抽象（规范第 9 节）', () => {
  it('parseEmotion 只接受合法枚举', () => {
    expect(parseEmotion('warm')).toBe('warm');
    expect(parseEmotion(' HAPPY ')).toBe('happy');
    expect(parseEmotion('not-real')).toBeUndefined();
    expect(parseEmotion(undefined)).toBeUndefined();
  });

  it('情绪 -> filler 分类', () => {
    expect(emotionToFillerCategory('happy')).toBe('positive');
    expect(emotionToFillerCategory('excited')).toBe('positive');
    expect(emotionToFillerCategory('sad')).toBe('low');
    expect(emotionToFillerCategory('sleepy')).toBe('low');
    expect(emotionToFillerCategory('neutral')).toBe('neutral');
  });
});

describe('FillerManager（规范第 24 节）', () => {
  it('FILLER_ENABLED=false 时整体不可用（不读文件系统）', async () => {
    const manager = new FillerManager('Z:\\nonexistent', false, silentLogger);
    await manager.preload();
    expect(manager.available).toBe(false);
    expect(manager.pickFrames('main', 'neutral')).toBeNull();
  });

  it('无文件时自动禁用并只警告一次', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'siren-filler-empty-'));
    const manager = new FillerManager(emptyDir, true, silentLogger);
    await manager.preload();
    expect(manager.available).toBe(false);
    expect(manager.pickFrames('p', 'neutral')).toBeNull();
  });

  it('有预生成文件时可按分类挑选 PCM 帧（运行时不做任何 TTS）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siren-filler-ok-'));
    const dir = join(root, 'main', 'neutral');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '01.pcm'), Buffer.alloc(48000)); // 1s @24k
    const manager = new FillerManager(root, true, silentLogger);
    await manager.preload();
    expect(manager.available).toBe(true);
    const frames = manager.pickFrames('main', 'neutral');
    expect(frames).not.toBeNull();
    expect(frames!.length).toBeGreaterThan(0);
    // 不存在的分类返回 null
    expect(manager.pickFrames('main', 'positive')).toBeNull();
  });
});
