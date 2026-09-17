/**
 * Siren 全量配置（环境变量驱动，规范第 34 节）。
 * 所有 VAD / buffer / 超时参数都必须配置化（规范第 47 节第 14 条）。
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type EnvSource = Record<string, string | undefined>;

export interface SirenConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  publicUrl: string;
  internalToken: string | null;
  corsOrigins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logTranscripts: boolean;

  dataDir: string;
  databasePath: string;
  tmpDir: string;
  fillersDir: string;
  logsDir: string;
  voicesDir: string;
  playgroundDir: string;

  providers: {
    asr: string;
    asyncTts: string;
    realtimeTts: string;
  };
  volc: {
    appId: string;
    accessToken: string;
    asrCluster: string;
    asrBatchResourceId: string;
    asrWsUrl: string;
    asrBatchUrl: string;
    ttsCluster: string;
    ttsUrl: string;
    voiceId: string;
    httpTimeoutMs: number;
  };
  elevenlabs: {
    apiKey: string;
    voiceId: string;
    modelId: string;
    baseUrl: string;
    timeoutMs: number;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  localObjectDir: string;

  coreBridge: 'mock' | 'http';
  coreBaseUrl: string;
  coreApiToken: string;
  coreTimeoutMs: number;
  mockCoreReply: string;

  fillerEnabled: boolean;
  partialGraceMs: number;
  callTokenTtlS: number;
  /** 客户端 playback_drained ACK 超时（P0-4，0 = 不等待） */
  playbackDrainTimeoutMs: number;
  signedUrlTtlS: number;
  maxUploadBytes: number;
  wsMaxPayloadBytes: number;
  prebufferMaxBytes: number;
  vad: {
    confirmMs: number;
    minSpeechMs: number;
    endSilenceMs: number;
    rmsRatio: number;
  };
  ws: {
    heartbeatIntervalMs: number;
    maxBufferedBytes: number;
  };

  allowMockInProduction: boolean;
  /** 本地对象存储 / 资源签名的 HMAC 密钥 */
  signingSecret: string;
}

function num(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: EnvSource = process.env, cwd = process.cwd()): SirenConfig {
  const nodeEnvRaw = (env.NODE_ENV ?? 'development').toLowerCase();
  const envName: SirenConfig['env'] =
    nodeEnvRaw === 'production' ? 'production' : nodeEnvRaw === 'test' ? 'test' : 'development';

  const dataDir = resolve(cwd, env.DATA_ROOT ?? './data');
  const internalToken = env.SIREN_INTERNAL_TOKEN?.trim() || null;
  const signingSecret =
    env.SIREN_SIGNING_SECRET?.trim() ||
    createHash('sha256')
      .update(`siren-signing:${internalToken ?? 'dev'}`)
      .digest('hex');

  return {
    env: envName,
    host: env.SIREN_HOST ?? '127.0.0.1',
    port: num(env, 'SIREN_PORT', 8790),
    publicUrl: (env.SIREN_PUBLIC_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, ''),
    internalToken,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, envName),
    logLevel: (env.SIREN_LOG_LEVEL as SirenConfig['logLevel']) ?? 'info',
    logTranscripts: bool(env, 'LOG_TRANSCRIPTS', false),

    ...resolvePaths(env, cwd, dataDir),
    ...resolveProviderSections(env),
    ...resolveCoreSection(env),
    ...resolveRealtimeTunables(env),

    allowMockInProduction: bool(env, 'SIREN_ALLOW_MOCK_IN_PRODUCTION', false),
    signingSecret
  };
}

/** 文件系统路径段 */
function resolvePaths(env: EnvSource, cwd: string, dataDir: string) {
  return {
    dataDir,
    databasePath: resolve(cwd, env.DATABASE_PATH ?? './data/siren.db'),
    tmpDir: resolve(dataDir, 'tmp'),
    fillersDir: resolve(dataDir, 'fillers'),
    logsDir: resolve(dataDir, 'logs'),
    voicesDir: resolve(cwd, './config/voices'),
    playgroundDir: resolve(cwd, './apps/playground/public'),
    localObjectDir: resolve(cwd, env.LOCAL_OBJECT_DIR ?? './data/objects')
  };
}

/** Provider / 存储配置段 */
function resolveProviderSections(env: EnvSource) {
  return {
    providers: {
      asr: env.ASR_PROVIDER ?? 'volc',
      asyncTts: env.ASYNC_TTS_PROVIDER ?? 'volc',
      realtimeTts: env.REALTIME_TTS_PROVIDER ?? 'volc'
    },
    volc: {
      appId: env.VOLC_APP_ID ?? '',
      accessToken: env.VOLC_ACCESS_TOKEN ?? '',
      asrCluster: env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
      asrBatchResourceId: env.VOLC_ASR_BATCH_RESOURCE_ID ?? 'volc.bigasr.auc.duration',
      asrWsUrl: env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v2/asr',
      asrBatchUrl: env.VOLC_ASR_BATCH_URL ?? 'https://openspeech.bytedance.com/api/v1/auc',
      ttsCluster: env.VOLC_TTS_CLUSTER ?? 'volcano_icl',
      ttsUrl: env.VOLC_TTS_URL ?? 'https://openspeech.bytedance.com/api/v1/tts',
      voiceId: env.VOLC_VOICE_ID ?? '',
      httpTimeoutMs: num(env, 'VOLC_HTTP_TIMEOUT_MS', 15000)
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY ?? '',
      voiceId: env.ELEVENLABS_VOICE_ID ?? '',
      modelId: env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2',
      baseUrl: env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io',
      timeoutMs: num(env, 'ELEVENLABS_TIMEOUT_MS', 30000)
    },
    r2: {
      accountId: env.R2_ACCOUNT_ID ?? '',
      accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      bucket: env.R2_BUCKET ?? 'siren-voice'
    }
  };
}

/** Core Bridge 配置段 */
function resolveCoreSection(env: EnvSource) {
  return {
    coreBridge: (env.SIREN_CORE_BRIDGE as 'mock' | 'http') ?? 'mock',
    coreBaseUrl: env.CORE_BASE_URL ?? '',
    coreApiToken: env.CORE_API_TOKEN ?? '',
    coreTimeoutMs: num(env, 'CORE_TIMEOUT_MS', 60000),
    mockCoreReply: env.MOCK_CORE_REPLY ?? '嗯，我在听。你说，我慢慢回。'
  };
}

/** 实时链路可调参数段（规范第 47 节第 14 条：全部配置化） */
function resolveRealtimeTunables(env: EnvSource) {
  return {
    fillerEnabled: bool(env, 'FILLER_ENABLED', false),
    partialGraceMs: num(env, 'PARTIAL_GRACE_MS', 450),
    callTokenTtlS: num(env, 'CALL_TOKEN_TTL_S', 120),
    playbackDrainTimeoutMs: num(env, 'PLAYBACK_DRAIN_TIMEOUT_MS', 4000),
    signedUrlTtlS: num(env, 'SIGNED_URL_TTL_S', 3600),
    maxUploadBytes: num(env, 'MAX_UPLOAD_MB', 25) * 1024 * 1024,
    wsMaxPayloadBytes: num(env, 'WS_MAX_PAYLOAD_MB', 2) * 1024 * 1024,
    prebufferMaxBytes: num(env, 'PREBUFFER_MAX_BYTES', 1024 * 1024),
    vad: {
      confirmMs: num(env, 'VAD_CONFIRM_MS', 200),
      minSpeechMs: num(env, 'VAD_MIN_SPEECH_MS', 400),
      endSilenceMs: num(env, 'VAD_END_SILENCE_MS', 700),
      rmsRatio: num(env, 'VAD_RMS_RATIO', 4)
    },
    ws: {
      heartbeatIntervalMs: 30000,
      maxBufferedBytes: 8 * 1024 * 1024
    }
  };
}

function parseCorsOrigins(raw: string | undefined, envName: SirenConfig['env']): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  // 开发环境默认放行本机；生产环境留空表示必须显式配置
  if (envName === 'production') return [];
  return ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];
}

/** 校验：生产环境不允许 Mock 默认链路（规范第 47 节第 21 条） */
export function assertProductionReadiness(config: SirenConfig): string[] {
  const problems: string[] = [];
  if (config.env !== 'production' || config.allowMockInProduction) return problems;
  if (config.coreBridge === 'mock') {
    problems.push('SIREN_CORE_BRIDGE=mock 不允许出现在生产环境（设置 SIREN_CORE_BRIDGE=http + CORE_BASE_URL）');
  }
  if (config.providers.asr === 'mock') problems.push('ASR_PROVIDER=mock 不允许出现在生产环境');
  if (config.providers.asyncTts === 'mock' || config.providers.realtimeTts === 'mock') {
    problems.push('TTS provider=mock 不允许出现在生产环境');
  }
  if (config.env === 'production' && !config.r2.accountId) {
    problems.push('生产环境未配置 R2（R2_ACCOUNT_ID 等），将回退到本地对象存储');
  }
  return problems;
}
