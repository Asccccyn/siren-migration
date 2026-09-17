import { describe, expect, it } from 'vitest';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import { buildProviders, loadConfig, assertProductionReadiness } from '@siren/voice-core';
import { silentLogger } from './helpers.ts';

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
});
