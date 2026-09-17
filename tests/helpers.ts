/** 测试共享工具 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MockAsrProvider } from '@siren/provider-mock';
import { MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import type { TtsProvider } from '@siren/contracts';
import {
  CallSessionsRepository,
  CallTurnsRepository,
  MemoryObjectStore,
  VoiceAssetsRepository,
  openDatabase
} from '@siren/storage';
import { createLogger, type Logger } from '@siren/telemetry';
import {
  CallCenter,
  CallSession,
  FillerManager,
  VoiceProfileRegistry,
  VoiceService,
  loadConfig,
  type SirenConfig
} from '@siren/voice-core';
import { buildApp, type SirenApp } from '../apps/server/src/app.ts';

export const TEST_PROFILE = {
  id: 'main',
  displayName: '对方',
  language: 'zh-CN',
  provider: 'volc' as const,
  voiceId: 'test-voice',
  defaultEmotion: 'warm' as const,
  defaultSpeed: 1.0
};

export function testConfig(extra: Record<string, string> = {}): SirenConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SIREN_LOG_LEVEL: 'error',
    DATABASE_PATH: ':memory:',
    ...extra
  });
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => undefined });

export function testProfiles(): VoiceProfileRegistry {
  const registry = new VoiceProfileRegistry({ volc: 'env-voice' });
  registry.loadSync([TEST_PROFILE]);
  return registry;
}

export interface TestVoiceBundle {
  voice: VoiceService;
  asr: MockAsrProvider;
  tts: MockTtsProvider;
  core: MockCoreBridge;
  store: MemoryObjectStore;
  db: ReturnType<typeof openDatabase>;
  assetsRepo: VoiceAssetsRepository;
  sessionsRepo: CallSessionsRepository;
  turnsRepo: CallTurnsRepository;
}

export function buildTestVoice(options: {
  asrScript?: ConstructorParameters<typeof MockAsrProvider>[0];
  coreReply?: string;
} = {}): TestVoiceBundle {
  const db = openDatabase(':memory:');
  const asr = new MockAsrProvider(options.asrScript ?? {});
  const tts = new MockTtsProvider();
  const core = new MockCoreBridge({
    reply: options.coreReply ?? '嗯，我在听。你说，我慢慢回。',
    intervalMs: 1,
    charsPerDelta: 2
  });
  const store = new MemoryObjectStore();
  const assetsRepo = new VoiceAssetsRepository(db);
  const sessionsRepo = new CallSessionsRepository(db);
  const turnsRepo = new CallTurnsRepository(db);
  const config = testConfig();
  const voice = new VoiceService({
    config,
    logger: silentLogger,
    asr,
    asyncTts: tts,
    core,
    store,
    assetsRepo,
    sessionsRepo,
    turnsRepo,
    profiles: testProfiles(),
    asrName: 'mock',
    asyncTtsName: 'mock'
  });
  return { voice, asr, tts, core, store, db, assetsRepo, sessionsRepo, turnsRepo };
}

export async function buildTestApp(extraEnv: Record<string, string> = {}): Promise<
  SirenApp & { app: FastifyInstance }
> {
  const config = testConfig(extraEnv);
  const db = openDatabase(':memory:');
  const { buildMemoryProviders } = await import('@siren/voice-core');
  return buildApp({
    config,
    logger: silentLogger,
    db,
    providers: buildMemoryProviders(),
    profiles: testProfiles(),
    fillers: new FillerManager(join(await mkdtemp(join(tmpdir(), 'siren-fillers-'))), false, silentLogger)
  });
}

/** 直连 MCP server 的测试客户端 */
export async function connectMcpClient(
  server: McpServer
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'siren-test-client', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

/** 直接构造 CallSession（不经网络），捕获输出帧 */
export interface SessionHarness {
  session: CallSession;
  frames: (string | Buffer)[];
  closeCalls: { code: number; reason: string }[];
  texts: () => Record<string, unknown>[];
  binaries: () => Buffer[];
  binaryBytes: () => number;
}

export function buildSessionHarness(deps: {
  asr?: MockAsrProvider;
  tts?: TtsProvider;
  core?: MockCoreBridge;
  config?: SirenConfig;
  turnsRepo?: CallTurnsRepository;
  sessionsRepo?: CallSessionsRepository;
  bufferedAmount?: () => number;
  onDestroyed?: (session: CallSession) => void;
}): SessionHarness {
  const frames: (string | Buffer)[] = [];
  const closeCalls: { code: number; reason: string }[] = [];
  const asr = deps.asr ?? new MockAsrProvider({ partials: ['你', '你好'], final: '你好。', finalDelayMs: 5 });
  const tts = deps.tts ?? new MockTtsProvider();
  const core =
    deps.core ?? new MockCoreBridge({ reply: '今天天气不错。我们出去走走吧。', intervalMs: 1, charsPerDelta: 2 });
  const db = deps.turnsRepo || deps.sessionsRepo ? undefined : openDatabase(':memory:');
  const turnsRepo = deps.turnsRepo ?? new CallTurnsRepository(db!);
  const sessionsRepo = deps.sessionsRepo ?? new CallSessionsRepository(db!);
  const session = new CallSession({
    config: deps.config ?? testConfig(),
    logger: silentLogger,
    callId: 'call-test-1',
    conversationId: 'conv-test',
    profile: TEST_PROFILE,
    asr,
    tts,
    core,
    fillers: new FillerManager('Z:\\nonexistent-fillers', false, silentLogger),
    turnsRepo,
    sessionsRepo,
    send: (data, binary) => {
      frames.push(binary ?? data);
    },
    bufferedAmount: deps.bufferedAmount ?? (() => 0),
    close: (code, reason) => closeCalls.push({ code, reason }),
    onDestroyed: deps.onDestroyed
  });
  return {
    session,
    frames,
    closeCalls,
    texts: () =>
      frames
        .filter((f): f is string => typeof f === 'string')
        .map((f) => JSON.parse(f) as Record<string, unknown>),
    binaries: () => frames.filter((f): f is Buffer => Buffer.isBuffer(f)),
    binaryBytes: () => frames.filter(Buffer.isBuffer).reduce((sum, b) => sum + b.length, 0)
  };
}

export { CallCenter };
