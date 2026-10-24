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
import { deriveFieldCipher, FieldDecryptionError, CallInvitesRepository } from '@siren/storage';
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
import { registerAuthHook, normalizeRequestPath } from './auth.ts';
import { createOAuth } from './oauth/index.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerVoiceMessageRoutes } from './routes/voice-message.ts';
import { registerCallSessionRoutes } from './routes/call-session.ts';
import { registerCallInviteRoutes, startInviteExpirySweeper } from './routes/call-invites.ts';
import { registerVoiceAssetAudioRoute } from './routes/voice-asset-audio.ts';
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

  // Validate key syntax before acquiring the database. Old plaintext is read-only compatibility, not a migration.
  const fieldCipher = deriveFieldCipher({ dataKey: config.dataKey, signingSecret: config.signingSecret });
  const db = options.db ?? openDatabase(config.databasePath);
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

  // Each TTS operation validates its selected profile against that exact provider.
  // An unused profile may belong to another supported chain; ASR membership cannot validate a TTS voice.

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
    ttsName: providers.active.realtimeTts,
    // 协议②（2026-10-24）：通话用户原声资产化（失败不阻断通话，audio_ref 缺省=纯文本轮）
    userAudio: { assetsRepo, store: providers.store }
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof FieldDecryptionError) {
      logger.error('stored_data_unreadable', { code: error.code });
      void reply.code(503).send({ error: error.code });
      return;
    }
    void reply.send(error);
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
  // B5/P1（2026-10-24）：来电邀请持久状态 + 服务端过期回收（重启即恢复扫描）
  const invites = new CallInvitesRepository(db);
  registerCallInviteRoutes(app, { invites });
  const stopInviteSweeper = startInviteExpirySweeper(invites);
  app.addHook('onClose', async () => stopInviteSweeper());
  // 协议②（2026-10-24）：通话用户原声字节（est 服务间取回；只读）
  registerVoiceAssetAudioRoute(app, { assetsRepo, store: providers.store instanceof LocalObjectStore ? providers.store : null });
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
    app.addHook('onRequest', async (request, reply) => {
      const path = normalizeRequestPath(request.url);
      if (path.startsWith('/assets/') && /\.html?$/i.test(path)) {
        await reply.code(404).send({ error: 'not_found' });
      }
    });
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/assets/',
      index: false
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (normalizeRequestPath(request.url).startsWith('/assets/')) {
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
