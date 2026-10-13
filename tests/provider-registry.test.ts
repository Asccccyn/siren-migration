import { describe, expect, it } from 'vitest';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import {
  buildProviders,
  loadConfig,
  assertProductionReadiness,
  packageBidirectionalPcmForBatch,
  assertTtsProfileCompatible,
  VoiceService
} from '@siren/voice-core';
import { buildTestVoice, silentLogger, testConfig, testProfiles, TEST_PROFILE } from './helpers.ts';

describe('Provider 注册与生产守卫（规范第 47 节）', () => {
  it('开发环境缺少火山凭据时回退 Mock 并给出警告', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      ASR_PROVIDER: 'volc',
      ASYNC_TTS_PROVIDER: 'volc',
      REALTIME_TTS_PROVIDER: 'volc'
    });
    const bundle = buildProviders(config, silentLogger);
    expect(bundle.active.asr).toContain('mock');
    expect(bundle.active.asyncTts).toContain('mock');
    expect(bundle.warnings.length).toBeGreaterThan(0);
    expect(bundle.store.kind).toBe('local');
  });

  it('配置 R2 凭据后使用 R2 存储', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'siren-voice'
    });
    const bundle = buildProviders(config, silentLogger);
    expect(bundle.store.kind).toBe('r2');
    expect(bundle.active.storage).toBe('r2:siren-voice');
  });

  it('生产环境缺少凭据直接拒绝启动（Mock 禁入生产）', () => {
    const config = loadConfig({ NODE_ENV: 'production', ASR_PROVIDER: 'volc' });
    expect(() => buildProviders(config, silentLogger)).toThrow(/VOLC_APP_ID/);
  });

  it('生产环境 MockCoreBridge 被拒绝；豁免开关可放开（仅调试）', () => {
    const env = {
      NODE_ENV: 'production',
      VOLC_APP_ID: 'app',
      VOLC_ACCESS_TOKEN: 'token',
      SIREN_CORE_BRIDGE: 'mock',
      CORE_BASE_URL: ''
    };
    const config = loadConfig(env);
    expect(() => buildProviders(config, silentLogger)).toThrow(/SIREN_CORE_BRIDGE=mock/);
    const configAllowed = loadConfig({ ...env, SIREN_ALLOW_MOCK_IN_PRODUCTION: 'true' });
    expect(() => buildProviders(configAllowed, silentLogger)).not.toThrow();
  });

  it('assertProductionReadiness 汇总风险项（P1-4：security 与 mock 拆开）', () => {
    const config = loadConfig({ NODE_ENV: 'production', SIREN_CORE_BRIDGE: 'mock' });
    const readiness = assertProductionReadiness(config);
    expect(readiness.mock.some((p) => p.includes('mock'))).toBe(true);
    // 安全项（token/签名/R2 完整性）独立于 mock 检查，allowMock 不能豁免
    expect(readiness.security.some((p) => p.includes('SIREN_INTERNAL_TOKEN'))).toBe(true);
    expect(readiness.security.some((p) => p.includes('SIREN_SIGNING_SECRET'))).toBe(true);

    // 配齐安全项 + R2 半配置 -> security 报 R2 不完整
    const partial = loadConfig({
      NODE_ENV: 'production',
      SIREN_INTERNAL_TOKEN: 't',
      SIREN_SIGNING_SECRET: 's',
      R2_ACCOUNT_ID: 'only-account'
    });
    expect(assertProductionReadiness(partial).security.some((p) => p.includes('R2'))).toBe(true);

    // 全部配齐 -> 无 security 风险
    const complete = loadConfig({
      NODE_ENV: 'production',
      SIREN_INTERNAL_TOKEN: 't',
      SIREN_SIGNING_SECRET: 's',
      R2_ACCOUNT_ID: 'a',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 'v'
    });
    expect(assertProductionReadiness(complete).security.length).toBe(0);

    // allowMock 只清空 mock 组，security 保留
    const allowed = loadConfig({
      NODE_ENV: 'production',
      SIREN_CORE_BRIDGE: 'mock',
      SIREN_ALLOW_MOCK_IN_PRODUCTION: 'true'
    });
    const allowedReadiness = assertProductionReadiness(allowed);
    expect(allowedReadiness.mock.length).toBe(0);
    expect(allowedReadiness.security.length).toBeGreaterThan(0);
  });

  it('Provider 可替换：bundle 对象满足接口（duck typing 检查）', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    const bundle = buildProviders(config, silentLogger);
    expect(typeof bundle.asr.transcribe).toBe('function');
    expect(typeof bundle.asr.createStream).toBe('function');
    expect(typeof bundle.asyncTts.synthesize).toBe('function');
    expect(typeof bundle.realtimeTts.synthesizeStream).toBe('function');
    expect(typeof bundle.core.streamReply).toBe('function');
    expect(typeof bundle.core.cancel).toBe('function');
  });

  it('显式 mock provider 在开发环境直接可用', () => {
    const config = loadConfig({ NODE_ENV: 'development', ASR_PROVIDER: 'mock' });
    const bundle = buildProviders(config, silentLogger);
    expect(bundle.asr).toBeInstanceOf(MockAsrProvider);
    expect(bundle.asyncTts).toBeInstanceOf(MockTtsProvider);
    expect(bundle.core).toBeInstanceOf(MockCoreBridge);
  });

  it('双向 TTS 聚合：PCM 不能伪装成 mp3，容器请求统一封装 WAV', () => {
    const pcm = Buffer.alloc(24_000 * 2); // 1 秒，PCM16 mono @ 24kHz
    pcm.writeInt16LE(1234, 128);

    const requestedMp3 = packageBidirectionalPcmForBatch(pcm, 24_000, 'mp3');
    expect(requestedMp3.format).toBe('wav');
    expect(requestedMp3.durationMs).toBe(1000);
    expect(requestedMp3.audio.toString('ascii', 0, 4)).toBe('RIFF');
    expect(requestedMp3.audio.toString('ascii', 8, 12)).toBe('WAVE');

    const requestedPcm = packageBidirectionalPcmForBatch(pcm, 24_000, 'pcm');
    expect(requestedPcm.format).toBe('pcm');
    expect(requestedPcm.durationMs).toBe(1000);
    expect(requestedPcm.audio.equals(pcm)).toBe(true);
  });
});

describe('Provider/配置近邻回归', () => {
  it.each(['', ' ', '\t\n'])('生产拒绝空或空白R2 bucket %j，装配共享同一判定', (bucket) => {
    const config = loadConfig({ NODE_ENV: 'production', SIREN_ALLOW_MOCK_IN_PRODUCTION: 'true',
      SIREN_INTERNAL_TOKEN: 'synthetic', SIREN_SIGNING_SECRET: 'synthetic',
      R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: bucket });
    expect(config.r2.bucket).toBe('');
    expect(assertProductionReadiness(config).security.some((message) => message.includes('R2'))).toBe(true);
    const bundle = buildProviders(config, silentLogger);
    try { expect(bundle.active.storage).toBe('local'); } finally { bundle.dispose?.(); }
  });

  it('R2配置统一去除边缘空格，正常值仍使用R2（不进行请求）', () => {
    const config = loadConfig({ R2_ACCOUNT_ID: ' a ', R2_ACCESS_KEY_ID: ' k ', R2_SECRET_ACCESS_KEY: ' s ', R2_BUCKET: ' example-bucket ' });
    expect(config.r2).toEqual({ accountId: 'a', accessKeyId: 'k', secretAccessKey: 's', bucket: 'example-bucket' });
    const bundle = buildProviders(config, silentLogger);
    try { expect(bundle.active.storage).toBe('r2:example-bucket'); } finally { bundle.dispose?.(); }
  });

  it('voice profile按本次TTS供应商匹配，支持bidi别名和mock占位', () => {
    expect(() => assertTtsProfileCompatible(TEST_PROFILE, 'volc(seed-2.0-bidi)')).not.toThrow();
    expect(() => assertTtsProfileCompatible(TEST_PROFILE, 'mock(dev-fallback)')).not.toThrow();
    expect(() => assertTtsProfileCompatible(TEST_PROFILE, 'elevenlabs')).toThrow(/incompatible/);
    expect(() => assertTtsProfileCompatible({ ...TEST_PROFILE, provider: 'mock' }, 'volc')).toThrow(/incompatible/);
  });

  it('ASR/实时选择volc也不能使异步ElevenLabs接受volc音色；合成前拒绝', async () => {
    const base = buildTestVoice();
    const voice = new VoiceService({ config: testConfig(), logger: silentLogger, asr: base.asr,
      asyncTts: base.tts, core: base.core, store: base.store, assetsRepo: base.assetsRepo,
      sessionsRepo: base.sessionsRepo, turnsRepo: base.turnsRepo, profiles: testProfiles(),
      asrName: 'volc', asyncTtsName: 'elevenlabs' });
    try {
      await expect(voice.speak({ text: '不该合成', messageId: 'wrong-vendor' })).rejects.toThrow(/incompatible/);
      await expect(voice.synthesizeAudio({ text: '不该合成' })).rejects.toThrow(/incompatible/);
      expect(base.tts.calls.batchCount).toBe(0);
      expect(base.assetsRepo.list({}).length).toBe(0);
    } finally { base.db.close(); }
  });
});
