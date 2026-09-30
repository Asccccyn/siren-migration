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
  /** 网页登录密码（人类可记，由部署者自行设置；web 登录成功后换取 internal token） */
  webPassword: string | null;
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
    /** 新版控制台单一 API Key（X-Api-Key 单头鉴权，优先于双件套） */
    apiKey: string;
    asrCluster: string;
    asrBatchResourceId: string;
    asrWsUrl: string;
    asrBatchUrl: string;
    ttsCluster: string;
    ttsUrl: string;
    /** 双向流式 TTS（v3 bidirection） */
    ttsWsUrl: string;
    ttsResourceId: string;
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
  peerName: string;
  mailboxName: string;

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
  /** SIREN_SIGNING_SECRET 是否显式配置（生产 fail-closed 检查用，P1-4） */
  signingSecretExplicit: boolean;
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
  const signingSecretExplicit = Boolean(env.SIREN_SIGNING_SECRET?.trim());
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
    webPassword: env.SIREN_WEB_PASSWORD?.trim() || null,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, envName),
    logLevel: (env.SIREN_LOG_LEVEL as SirenConfig['logLevel']) ?? 'info',
    logTranscripts: bool(env, 'LOG_TRANSCRIPTS', false),

    ...resolvePaths(env, cwd, dataDir),
    ...resolveProviderSections(env),
    ...resolveCoreSection(env),
    ...resolveRealtimeTunables(env),

    allowMockInProduction: bool(env, 'SIREN_ALLOW_MOCK_IN_PRODUCTION', false),
    signingSecret,
    signingSecretExplicit
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
    voicesDir: resolve(cwd, './data/voices'),
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
      /** 新版控制台（2.0）单一 API Key：设置后 v3 接口走 X-Api-Key 单头鉴权，
       * 优先级高于 appId/accessToken 双件套（旧版控制台） */
      apiKey: env.VOLC_API_KEY ?? '',
      asrCluster: env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
      // 极速版资源 ID（F06：v3 flash 协议要求，v1 的 auc.duration 资源不适用）
      asrBatchResourceId: env.VOLC_ASR_BATCH_RESOURCE_ID ?? 'volc.bigasr.auc_turbo',
      // 大模型流式 ASR v3（P0-8）：bigmodel=双向流式（实时出字）；可用 bigmodel_async / bigmodel_nostream 覆盖
      asrWsUrl: env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
      // 大模型录音文件识别·极速版 v3（F06：one-shot flash，成功码在响应头 X-Api-Status-Code）
      asrBatchUrl:
        env.VOLC_ASR_BATCH_URL ?? 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      ttsCluster: env.VOLC_TTS_CLUSTER ?? 'volcano_icl',
      ttsUrl: env.VOLC_TTS_URL ?? 'https://openspeech.bytedance.com/api/v1/tts',
      // 双向流式 TTS v3（P0-9）
      ttsWsUrl: env.VOLC_TTS_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      ttsResourceId: env.VOLC_TTS_RESOURCE_ID ?? 'volc.service_type.10029',
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
    mockCoreReply: env.MOCK_CORE_REPLY ?? '嗯，我在听。你说，我慢慢回。',
    /** 通话接线方的显示名（身份映射：大脑换人只改这里，页面不改） */
    peerName: env.SIREN_PEER_NAME ?? '他',
    /** 信箱侧显示名（同 peerName：真实称呼留在部署方 .env，仓库与页面默认中性） */
    mailboxName: env.SIREN_MAILBOX_NAME ?? '他'
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

export interface ProductionReadiness {
  /**
   * 安全项（P1-4 fail closed）：生产环境一律阻断启动，
   * SIREN_ALLOW_MOCK_IN_PRODUCTION 只放宽 mock provider，不得跳过这些检查。
   */
  security: string[];
  /** mock 链路项：SIREN_ALLOW_MOCK_IN_PRODUCTION=true 时允许放行（仅限调试） */
  mock: string[];
}

/**
 * 生产配置校验（P1-4：security 与 mock readiness 拆开，fail closed）。
 * - security：SIREN_INTERNAL_TOKEN / SIREN_SIGNING_SECRET 必须显式配置；
 *   R2 要么不配（整组缺失仅提示），要么配齐（account/key/secret/bucket 缺一即阻断）
 * - mock：Mock Core / Provider 禁入生产（allowMock 豁免的只有这一组）
 */
export function assertProductionReadiness(config: SirenConfig): ProductionReadiness {
  const security: string[] = [];
  const mock: string[] = [];
  if (config.env !== 'production') return { security, mock };

  if (!config.internalToken) {
    security.push('SIREN_INTERNAL_TOKEN 未配置：内部 API 与 MCP 将不鉴权，生产禁止');
  }
  if (!config.signingSecretExplicit) {
    security.push('SIREN_SIGNING_SECRET 未显式配置：资源签名密钥将由内部 token 派生，生产禁止');
  }
  const r2 = config.r2;
  const r2ConfiguredAny = Boolean(r2.accountId || r2.accessKeyId || r2.secretAccessKey);
  if (r2ConfiguredAny && !(r2.accountId && r2.accessKeyId && r2.secretAccessKey)) {
    security.push('R2 配置不完整：account id / access key / secret key 必须配齐，不允许半配置');
  }

  if (config.allowMockInProduction) return { security, mock };

  if (config.coreBridge === 'mock') {
    mock.push('SIREN_CORE_BRIDGE=mock 不允许出现在生产环境（设置 SIREN_CORE_BRIDGE=http + CORE_BASE_URL）');
  }
  if (config.providers.asr === 'mock') mock.push('ASR_PROVIDER=mock 不允许出现在生产环境');
  if (config.providers.asyncTts === 'mock' || config.providers.realtimeTts === 'mock') {
    mock.push('TTS provider=mock 不允许出现在生产环境');
  }
  return { security, mock };
}
