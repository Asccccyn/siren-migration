import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMemoryProviders, loadConfig } from '@siren/voice-core';
import { generateFillers } from '../scripts/generate-fillers.ts';
import { silentLogger } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function config() {
  const root = await mkdtemp(join(tmpdir(), 'siren-filler-generation-'));
  roots.push(root);
  return loadConfig({ NODE_ENV: 'test' }, root);
}

describe('filler生成的profile、mock与资源所有权', () => {
  it('显式mock不装配真实供应商，并为产物记录来源', async () => {
    const cfg = await config(); cfg.env = 'production';
    const factory = vi.fn(() => { throw new Error('must not create providers'); });
    const result = await generateFillers({ config: cfg, logger: silentLogger, useMock: true, createProviders: factory });
    expect(factory).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 10, provider: 'mock' });
    const manifest = JSON.parse(await readFile(join(cfg.fillersDir, 'main', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ mock: true, complete: true, count: 10 });
  });

  it('未指定mock时拒绝dev fallback且dispose', async () => {
    const cfg = await config();
    const bundle = buildMemoryProviders(); bundle.active.asyncTts = 'mock(dev-fallback)';
    const dispose = vi.fn(); bundle.dispose = dispose;
    await expect(generateFillers({ config: cfg, logger: silentLogger, createProviders: () => bundle })).rejects.toThrow(/explicitly/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('使用所选档案的供应商音色，成功和失败都释放bundle', async () => {
    const cfg = await config();
    await mkdir(cfg.voicesDir, { recursive: true });
    await writeFile(join(cfg.voicesDir, 'el.json'), JSON.stringify({ id: 'el', displayName: 'fixture', provider: 'elevenlabs',
      voiceId: 'synthetic-profile-voice', language: 'zh-CN', defaultEmotion: 'neutral', defaultSpeed: 1 }));
    const bundle = buildMemoryProviders(); bundle.active.asyncTts = 'elevenlabs';
    const synthesize = vi.spyOn(bundle.asyncTts, 'synthesize');
    const dispose = vi.fn(); bundle.dispose = dispose;
    await generateFillers({ config: cfg, logger: silentLogger, profileId: 'el', createProviders: () => bundle });
    expect(synthesize).toHaveBeenCalledTimes(10);
    expect(synthesize.mock.calls[0][0].profile).toMatchObject({ provider: 'elevenlabs', voiceId: 'synthetic-profile-voice' });
    expect(dispose).toHaveBeenCalledOnce();
    synthesize.mockRejectedValueOnce(new Error('synthetic upstream failure'));
    await expect(generateFillers({ config: cfg, logger: silentLogger, profileId: 'el', createProviders: () => bundle })).rejects.toThrow(/upstream failure/);
    expect(dispose).toHaveBeenCalledTimes(2);
    const manifest = JSON.parse(await readFile(join(cfg.fillersDir, 'el', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ provider: 'elevenlabs', mock: false, complete: false });
  });

  it('错配档案在合成前拒绝且dispose；缺档案不默换音色', async () => {
    const cfg = await config();
    await mkdir(cfg.voicesDir, { recursive: true });
    await writeFile(join(cfg.voicesDir, 'wrong.json'), JSON.stringify({ id: 'wrong', displayName: 'fixture', provider: 'volc', voiceId: 'synthetic-volc' }));
    const bundle = buildMemoryProviders(); bundle.active.asyncTts = 'elevenlabs';
    const synthesize = vi.spyOn(bundle.asyncTts, 'synthesize'); const dispose = vi.fn(); bundle.dispose = dispose;
    await expect(generateFillers({ config: cfg, logger: silentLogger, profileId: 'wrong', createProviders: () => bundle })).rejects.toThrow(/incompatible/);
    await expect(generateFillers({ config: cfg, logger: silentLogger, profileId: 'missing', createProviders: () => bundle })).rejects.toThrow(/not found/);
    expect(synthesize).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
