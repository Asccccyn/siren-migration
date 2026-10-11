/**
 * Fastify 应用装配（buildApp 可注入依赖，供测试复用）。
 * 单进程统一挂载：REST / MCP / WebSocket / Health / Web（规范第 3 节）。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SqliteDatabase } from '@siren/storage';
import { deriveFieldCipher } from '@siren/storage';
import {
  CallSessionsRepository,
  CallTurnsRepository,
  LocalObjectStore,
  VoiceAssetsRepository,
  openDatabase
} from '@siren/storage';
import {
  AsyncVoicePipeline,
  CallCenter,
  FillerManager,
  VoiceProfileRegistry,
  VoiceService,
  buildProviders,
  type ProviderBundle,
  type SirenConfig,
  loadConfig
} from '@siren/voice-core';
import type { Logger } from '@siren/telemetry';
import { createLogger } from '@siren/telemetry';
import { registerAuthHook } from './auth.ts';
import { createOAuth } from './oauth/index.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerVoiceMessageRoutes } from './routes/voice-message.ts';
import { registerCallSessionRoutes } from './routes/call-session.ts';
import { registerAssetsRoute } from './routes/assets.ts';
import { registerWebAuthRoute } from './routes/web-auth.ts';
import { registerCallWebSocket } from './websocket/call-handler.ts';
import { registerMcpRoute } from './mcp/server.ts';

export const SIREN_VERSION = '1.1.1';

export interface BuildAppOptions {
  config?: SirenConfig;
  logger?: Logger;
  db?: SqliteDatabase;
  providers?: ProviderBundle;
  profiles?: VoiceProfileRegistry;
  fillers?: FillerManager;
}

export interface SirenApp {
  app: FastifyInstance;
  config: SirenConfig;
  logger: Logger;
  voice: VoiceService;
  callCenter: CallCenter;
  providers: ProviderBundle;
  dispose(): Promise<void>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<SirenApp> {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      logFile: `${config.logsDir.replace(/[\\/]+$/, '')}/siren.log`,
      logTranscripts: config.logTranscripts
    });

  const db = options.db ?? openDatabase(config.databasePath);
  // S1011-013：DB 正文字段静态加密（SIREN_DATA_KEY 优先，否则从签名密钥派生；懒迁移兼容旧行）
  const fieldCipher = deriveFieldCipher({ dataKey: config.dataKey, signingSecret: config.signingSecret });
  const providers = options.providers ?? buildProviders(config, logger);
  for (const warning of providers.warnings) {
    logger.warn('config_warning', { message: warning });
  }

  const profiles = options.profiles ?? new VoiceProfileRegistry({
    volc: config.volc.voiceId,
    elevenlabs: config.elevenlabs.voiceId
  });
  if (!options.profiles) {
    const loaded = await profiles.loadFromDir(config.voicesDir);
    for (const warning of loaded.warnings) {
      logger.warn('config_warning', { message: warning });
    }
    if (loaded.loaded === 0) {
      // 无配置文件时兜底一个内存 profile，保证服务可用
      profiles.loadSync([
        {
          id: 'main',
          displayName: '他',
          language: 'zh-CN',
          provider: providers.active.realtimeTts.startsWith('elevenlabs') ? 'elevenlabs' : 'volc',
          voiceId: '',
          defaultEmotion: 'warm',
          defaultSpeed: 1.0
        }
      ]);
      logger.warn('config_warning', { message: 'config/voices 下无可用 profile，使用内置默认（音色取环境变量）' });
    }
  }

  // S1011-022：profile.provider 与实际装配的供应商一致性——错配会让音色跨供应商
  // 错用（如 profile 标 volc 而异步链路是 elevenlabs）。生产 fail-closed，开发告警。
  const activeProviderNames = new Set(
    [providers.active.asr, providers.active.asyncTts, providers.active.realtimeTts]
      .map((name) => name.split('(')[0]!.trim())
  );
  for (const profile of profiles.list()) {
    if (profile.provider !== 'mock' && !activeProviderNames.has(profile.provider)) {
      const message = `音色档案 ${profile.id} 声明 provider=${profile.provider}，与实际装配（${[...activeProviderNames].join('/')}）不符——音色将跨供应商错配`;
      if (config.env === 'production') {
        throw new Error(message);
      }
      logger.warn('config_warning', { message });
    }
  }

  const fillers =
    options.fillers ??
    new FillerManager(config.fillersDir, config.fillerEnabled, logger.child({ component: 'filler' }));

  const assetsRepo = new VoiceAssetsRepository(db, fieldCipher);
  const sessionsRepo = new CallSessionsRepository(db);
  const turnsRepo = new CallTurnsRepository(db, fieldCipher);

  const voice = new VoiceService({
    config,
    logger,
    asr: providers.asr,
    asyncTts: providers.asyncTts,
    core: providers.core,
    store: providers.store,
    assetsRepo,
    sessionsRepo,
    turnsRepo,
    profiles,
    asrName: providers.active.asr,
    asyncTtsName: providers.active.asyncTts
  });
  const pipeline = new AsyncVoicePipeline(voice);

  const callCenter = new CallCenter({
    config,
    logger,
    realtimeAsr: providers.realtimeAsr,
    realtimeTts: providers.realtimeTts,
    core: providers.core,
    fillers,
    profiles,
    sessionsRepo,
    turnsRepo,
    asrName: providers.active.asr,
    ttsName: providers.active.realtimeTts
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024
  });

  await app.register(fastifyCors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'POST']
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 }
  });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: config.wsMaxPayloadBytes }
  });

  const oauth = createOAuth(config, logger);
  registerAuthHook(app, config, oauth.acceptBearer);
  registerHealthRoute(app, {
    version: SIREN_VERSION,
    providers: {
      asr: providers.active.asr,
      asyncTts: providers.active.asyncTts,
      realtimeTts: providers.active.realtimeTts,
      coreBridge: providers.active.coreBridge,
      storage: providers.active.storage
    },
    fillerEnabled: fillers.available,
    activeCalls: () => callCenter.activeCount,
    uptimeStart: Date.now()
  });
  registerVoiceMessageRoutes(app, { config, logger, voice, pipeline });
  registerCallSessionRoutes(app, { callCenter });
  registerAssetsRoute(app, {
    config,
    store: providers.store instanceof LocalObjectStore ? providers.store : null
  });
  registerWebAuthRoute(app, { config });
  await oauth.registerRoutes(app);
  registerCallWebSocket(app, { config, logger, callCenter });
  registerMcpRoute(app, {
    voice,
    store: providers.store,
    logger,
    version: SIREN_VERSION,
    corsOrigins: config.corsOrigins
  });

  // 根路径 = 唯一入口（一个网址，页内三标签）：注入显示名（身份映射，真实称呼在 .env）
  const voiceboxHtml = join(config.webDir, 'voicebox.html');
  app.get('/', async (_request, reply) => {
    if (existsSync(voiceboxHtml)) {
      const html = (await readFile(voiceboxHtml, 'utf8'))
        .replaceAll('__PEER_NAME__', config.peerName)
        .replaceAll('__MAILBOX_NAME__', config.mailboxName);
      // 唯一入口页禁缓存：手机浏览器对旧 JS 的粘性缓存会让她跑旧版客户端逻辑
      await reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
      return;
    }
    await reply.code(404).send({ error: 'web_not_built', hint: 'apps/web/public/voicebox.html 缺失' });
  });

  // 唯一入口页的静态资源（css / 客户端 js），无独立页面。
  // S1011-009：fastifyStatic 的 setHeaders 会被插件自身回复头逻辑覆盖——
  // 缓存策略在 onSend（最终响应头层）统一落实，并用真实响应断言
  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/assets/',
      index: false
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url.split('?')[0]!.startsWith('/assets/')) {
        reply.header('cache-control', 'no-cache');
      }
      return payload;
    });
  }

  return {
    app,
    config,
    logger,
    voice,
    callCenter,
    providers,
    dispose: async () => {
      callCenter.destroyAll();
      try {
        await app.close();
      } finally {
        providers.dispose?.();
        if (db.open) db.close();
      }
    }
  };
}
