/**
 * Provider 注册中心：按环境变量装配 ASR / TTS Provider。
 * - 优先使用显式指定的 provider（volc / elevenlabs / mock）
 * - 开发环境缺少凭据时自动回退 mock 并给出警告
 * - 生产环境缺少凭据直接抛错（不允许 Mock 混入，规范第 47 节第 15/21 条）
 */
import type {
  AsrProvider,
  BatchTtsProvider,
  TtsProvider
} from '@siren/contracts';
import { HttpCoreBridge, MockCoreBridge } from '@siren/core-bridge';
import type { CoreBridge } from '@siren/core-bridge';
import { ElevenLabsTtsProvider } from '@siren/provider-elevenlabs';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { VolcBatchAsrProvider, VolcStreamAsrProvider } from '@siren/provider-volc-asr';
import { VolcBatchTtsProvider, VolcBidirectionalTtsProvider } from '@siren/provider-volc-tts';
import { buildWav, pcmDurationMs } from '@siren/audio';
import type { ObjectStore } from '@siren/storage';
import { LocalObjectStore, MemoryObjectStore, R2ObjectStore } from '@siren/storage';
import type { Logger } from '@siren/telemetry';
import type { SirenConfig } from './config.ts';

export interface ProviderBundle {
  asr: AsrProvider;
  realtimeAsr: AsrProvider;
  asyncTts: BatchTtsProvider;
  realtimeTts: TtsProvider;
  core: CoreBridge;
  store: ObjectStore;
  warnings: string[];
  /** 实际生效的 provider 名（写入 call_sessions 元数据） */
  active: { asr: string; asyncTts: string; realtimeTts: string; coreBridge: string; storage: string };
  /** 长生命周期资源清理（如火山双向流式 WebSocket 共享连接），app 关停时调用 */
  dispose?: () => void;
}

export function buildProviders(config: SirenConfig, logger?: Logger): ProviderBundle {
  const warnings: string[] = [];
  const isProd = config.env === 'production' && !config.allowMockInProduction;
  const disposeHooks: (() => void)[] = [];

  // --- ASR ---
  let asr: AsrProvider;
  let asrName = config.providers.asr;
  // 新版控制台单一 API Key（VOLC_API_KEY）与旧版双件套任一齐备即算就绪
  const volcAsrReady = Boolean(
    (config.volc.appId && config.volc.accessToken) || config.volc.apiKey
  );
  if (asrName === 'mock') {
    assertMockAllowed(isProd, 'ASR_PROVIDER');
    asr = new MockAsrProvider();
  } else if (asrName === 'volc' && volcAsrReady) {
    asr = compositeVolcAsr(config);
  } else if (asrName === 'volc' && !volcAsrReady) {
    if (isProd) throw new Error('VOLC_API_KEY 或 VOLC_APP_ID/VOLC_ACCESS_TOKEN 未配置，生产环境禁止回退 mock');
    warnings.push('火山 ASR 凭据缺失，开发环境回退 MockAsrProvider');
    asrName = 'mock(dev-fallback)';
    asr = new MockAsrProvider();
  } else {
    throw new Error(`不支持的 ASR_PROVIDER: ${asrName}`);
  }

  // --- TTS ---
  // forRealtime=true 返回完整 TtsProvider（真流式）；false 返回纯 BatchTtsProvider
  const buildTts = (
    configured: string,
    forRealtime: boolean
  ): { tts: TtsProvider | BatchTtsProvider; name: string } => {
    if (configured === 'mock') {
      assertMockAllowed(isProd, 'TTS provider');
      return { tts: new MockTtsProvider(), name: 'mock' };
    }
    if (configured === 'elevenlabs') {
      if (!config.elevenlabs.apiKey) {
        if (isProd) throw new Error('ELEVENLABS_API_KEY 未配置，生产环境禁止回退 mock');
        warnings.push('ElevenLabs 凭据缺失，开发环境回退 MockTtsProvider');
        return { tts: new MockTtsProvider(), name: 'mock(dev-fallback)' };
      }
      return {
        tts: new ElevenLabsTtsProvider({
          apiKey: config.elevenlabs.apiKey,
          modelId: config.elevenlabs.modelId,
          baseUrl: config.elevenlabs.baseUrl,
          timeoutMs: config.elevenlabs.timeoutMs
        }),
        name: 'elevenlabs'
      };
    }
    if (configured === 'volc') {
      if (!volcAsrReady) {
        if (isProd) throw new Error('火山 TTS 凭据缺失，生产环境禁止回退 mock');
        warnings.push('火山 TTS 凭据缺失，开发环境回退 MockTtsProvider');
        return { tts: new MockTtsProvider(), name: 'mock(dev-fallback)' };
      }
      const makeBatch = (): VolcBatchTtsProvider =>
        new VolcBatchTtsProvider({
          appId: config.volc.appId,
          accessToken: config.volc.accessToken,
          cluster: config.volc.ttsCluster,
          endpointUrl: config.volc.ttsUrl,
          timeoutMs: config.volc.httpTimeoutMs
        });
      const makeBidirectional = (): VolcBidirectionalTtsProvider =>
        new VolcBidirectionalTtsProvider(
          {
            appId: config.volc.appId,
            accessToken: config.volc.accessToken,
            apiKey: config.volc.apiKey || undefined,
            resourceId: config.volc.ttsResourceId,
            wsUrl: config.volc.ttsWsUrl,
            connectTimeoutMs: config.volc.httpTimeoutMs,
            sessionTimeoutMs: 20000
          },
          logger
        );
      if (forRealtime) {
        // 实时链路：v3 双向流式为主，批量兜底（降级链规范第 40 节）。
        // apiKey 账号没有 v1 批量端点权限——兜底同样用双向流式聚合（审计 F-A 修复）
        const bidirectional = makeBidirectional();
        disposeHooks.push(() => bidirectional.dispose());
        let fallback: BatchTtsProvider;
        if (config.volc.apiKey) {
          const fallbackBidi = makeBidirectional();
          disposeHooks.push(() => fallbackBidi.dispose());
          fallback = aggregateBidiAsBatch(fallbackBidi);
        } else {
          fallback = makeBatch();
        }
        const realtime: TtsProvider = {
          synthesize: (request) => fallback.synthesize(request),
          synthesizeStream: (request, signal) => bidirectional.synthesizeStream(request, signal)
        };
        return { tts: realtime, name: 'volc' };
      }
      if (config.volc.apiKey) {
        // 新版 API Key 账号无 v1 批量端点权限：异步链路聚合双向流式实现 synthesize
        const bidi = makeBidirectional();
        disposeHooks.push(() => bidi.dispose());
        return { tts: aggregateBidiAsBatch(bidi), name: 'volc(seed-2.0-bidi)' };
      }
      // 旧版双件套：纯批量（异步语音只用 synthesize）
      return { tts: makeBatch(), name: 'volc' };
    }
    throw new Error(`不支持的 TTS provider: ${configured}`);
  };

  const asyncTtsBundle = buildTts(config.providers.asyncTts, false);
  const realtimeTtsBundle = buildTts(config.providers.realtimeTts, true);
  const realtimeTts: TtsProvider = realtimeTtsBundle.tts as TtsProvider;

  // --- Core Bridge ---
  let core: CoreBridge;
  let coreName: string = config.coreBridge;
  if (config.coreBridge === 'mock') {
    assertMockAllowed(isProd, 'SIREN_CORE_BRIDGE');
    core = new MockCoreBridge({ reply: config.mockCoreReply });
  } else {
    if (!config.coreBaseUrl) {
      if (isProd) throw new Error('CORE_BASE_URL 未配置，生产环境禁止回退 MockCoreBridge');
      warnings.push('CORE_BASE_URL 未配置，开发环境回退 MockCoreBridge');
      coreName = 'mock(dev-fallback)';
      core = new MockCoreBridge({ reply: config.mockCoreReply });
    } else {
      core = new HttpCoreBridge({
        baseUrl: config.coreBaseUrl,
        apiToken: config.coreApiToken || undefined,
        timeoutMs: config.coreTimeoutMs,
        logger
      });
    }
  }

  // --- Object Store ---
  const r2Ready = Boolean(
    config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey
  );
  let store: ObjectStore;
  let storageName: string;
  if (r2Ready) {
    store = new R2ObjectStore({
      accountId: config.r2.accountId,
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
      bucket: config.r2.bucket
    });
    storageName = `r2:${config.r2.bucket}`;
  } else {
    if (config.env === 'production') {
      warnings.push('R2 未配置，生产环境回退本地对象存储（请尽快配置 R2_*）');
    } else {
      warnings.push('R2 未配置，使用本地对象存储');
    }
    store = new LocalObjectStore({
      rootDir: config.localObjectDir,
      publicBaseUrl: config.publicUrl,
      signingSecret: config.signingSecret
    });
    storageName = 'local';
  }

  return {
    asr,
    realtimeAsr: asr,
    asyncTts: asyncTtsBundle.tts,
    realtimeTts,
    core,
    store,
    warnings,
    active: {
      asr: asrName,
      asyncTts: asyncTtsBundle.name,
      realtimeTts: realtimeTtsBundle.name,
      coreBridge: coreName,
      storage: storageName
    },
    // 长生命周期资源：火山双向流式共享连接在关停时释放
    dispose: () => disposeHooks.forEach((hook) => hook())
  };
}

/**
 * 把双向流式 TTS 聚合成批量接口。
 * 新版 API Key 账号没有 v1 批量端点权限，异步链路（语音消息合成）以
 * 一次完整的双向流式会话等价实现 synthesize。
 */
function aggregateBidiAsBatch(bidi: VolcBidirectionalTtsProvider): BatchTtsProvider {
  return {
    synthesize: async (request) => {
      const parts: Buffer[] = [];
      let sampleRate = request.sampleRate ?? 24000;
      for await (const chunk of bidi.synthesizeStream(request)) {
        parts.push(chunk.audio);
        sampleRate = chunk.sampleRate;
      }
      return packageBidirectionalPcmForBatch(Buffer.concat(parts), sampleRate, request.format);
    }
  };
}

/**
 * 火山双向 TTS 的 session 输出固定是 PCM16 mono。
 * 异步语音链路不能把这些字节“按请求格式”伪装成 mp3；否则文件扩展名、MIME、
 * duration 都会一起错误，Safari/iOS 会直接判定媒体不可播放。
 *
 * - 请求 pcm：如实返回裸 PCM
 * - 请求 wav / mp3 / 其他容器：封装成标准 WAV 并如实标记 format=wav
 *
 * 这里宁可发生“mp3 请求降级为 wav”，也绝不能返回伪 mp3。
 */
export function packageBidirectionalPcmForBatch(
  pcm: Buffer,
  sampleRate: number,
  requestedFormat: string
): { audio: Buffer; format: 'pcm' | 'wav'; sampleRate: number; durationMs: number } {
  const durationMs = pcmDurationMs(pcm.length, sampleRate);
  if (requestedFormat === 'pcm') {
    return { audio: pcm, format: 'pcm', sampleRate, durationMs };
  }
  return {
    audio: buildWav(pcm, sampleRate),
    format: 'wav',
    sampleRate,
    durationMs
  };
}

function compositeVolcAsr(config: SirenConfig): AsrProvider {
  const batch = new VolcBatchAsrProvider({
    appId: config.volc.appId,
    accessToken: config.volc.accessToken,
    apiKey: config.volc.apiKey || undefined,
    resourceId: config.volc.asrBatchResourceId,
    endpointUrl: config.volc.asrBatchUrl,
    timeoutMs: config.volc.httpTimeoutMs
  });
  const stream = new VolcStreamAsrProvider({
    appId: config.volc.appId,
    accessToken: config.volc.accessToken,
    apiKey: config.volc.apiKey || undefined,
    resourceId: config.volc.asrCluster,
    wsUrl: config.volc.asrWsUrl,
    sampleRate: 16000,
    connectTimeoutMs: 5000
  });
  return { transcribe: (input) => batch.transcribe(input), createStream: (options, handlers) => stream.createStream(options, handlers) };
}

function assertMockAllowed(isProd: boolean, what: string): void {
  if (isProd) {
    throw new Error(`${what}=mock 在生产环境被拒绝（如确需调试请设置 SIREN_ALLOW_MOCK_IN_PRODUCTION=true）`);
  }
}

/** 测试辅助：全套内存化 Provider */
export function buildMemoryProviders(): ProviderBundle {
  return {
    asr: new MockAsrProvider(),
    realtimeAsr: new MockAsrProvider(),
    asyncTts: new MockTtsProvider(),
    realtimeTts: new MockTtsProvider(),
    core: new MockCoreBridge({ reply: '嗯，我在听。你说，我慢慢回。', intervalMs: 1, charsPerDelta: 2 }),
    store: new MemoryObjectStore(),
    warnings: [],
    active: {
      asr: 'mock',
      asyncTts: 'mock',
      realtimeTts: 'mock',
      coreBridge: 'mock',
      storage: 'memory'
    }
  };
}
