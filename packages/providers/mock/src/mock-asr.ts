/**
 * Mock ASR：开发与测试使用，可脚本化 partial/final 行为。
 * 生产环境禁止启用（config 层有守卫）。
 */
import {
  ProviderError,
  type AsrProvider,
  type AsrStream,
  type AsrStreamHandlers,
  type BatchAudioInput,
  type StreamAsrOptions,
  type TranscriptResult
} from '@siren/contracts';
import { pcmDurationMs, wavDurationMs } from '@siren/audio';

export interface MockAsrScript {
  partials?: string[];
  final?: string;
  /** end() 后延迟多久给出 final（ms） */
  finalDelayMs?: number;
  /** 让 transcribe / end() 抛错（测试 ASR 失败降级用） */
  failEnd?: boolean;
}

export class MockAsrProvider implements AsrProvider {
  readonly calls: { transcribeCount: number; streamsCreated: number } = {
    transcribeCount: 0,
    streamsCreated: 0
  };

  /** 可变脚本（测试可注入故障） */
  readonly script: MockAsrScript;

  constructor(script: MockAsrScript = {}) {
    this.script = {
      partials: ['嗯，', '嗯，我在'],
      final: '嗯，我在听，请讲。',
      finalDelayMs: 10,
      ...script
    };
  }

  transcribe(input: BatchAudioInput): Promise<TranscriptResult> {
    this.calls.transcribeCount++;
    if (this.script.failEnd) {
      return Promise.reject(new ProviderError('asr_failed', 'mock-asr', 'mock asr failure'));
    }
    const duration = wavDurationMs(input.audio) ?? pcmDurationMs(input.audio.length, 16000);
    const text = this.script.final ?? '这是 Mock ASR 的识别结果。';
    return Promise.resolve({ text, language: input.language ?? 'zh-CN', durationMs: duration });
  }

  async createStream(
    _options: StreamAsrOptions,
    handlers: AsrStreamHandlers,
    scriptOverride?: MockAsrScript
  ): Promise<AsrStream> {
    this.calls.streamsCreated++;
    return new MockAsrStream(scriptOverride ?? this.script, handlers);
  }
}

export class MockAsrStream implements AsrStream {
  private partialIndex = 0;
  private ended = false;
  private aborted = false;
  private fedBytes = 0;
  private pending: { timer: NodeJS.Timeout; reject: (error: unknown) => void } | null = null;

  constructor(
    private readonly script: MockAsrScript,
    private readonly handlers: AsrStreamHandlers
  ) {}

  get receivedBytes(): number {
    return this.fedBytes;
  }

  feed(pcm: Buffer): void {
    if (this.ended || this.aborted) return;
    this.fedBytes += pcm.length;
    const partials = this.script.partials ?? [];
    if (this.partialIndex < partials.length && this.fedBytes >= (this.partialIndex + 1) * 640) {
      this.handlers.onPartial?.(partials[this.partialIndex]);
      this.partialIndex++;
    }
  }

  end(): Promise<TranscriptResult> {
    if (this.ended) {
      return Promise.resolve(this.buildResult());
    }
    this.ended = true;
    const partials = this.script.partials ?? [];
    while (this.partialIndex < partials.length) {
      this.handlers.onPartial?.(partials[this.partialIndex]);
      this.partialIndex++;
    }
    return new Promise<TranscriptResult>((resolve, reject) => {
      if (this.script.failEnd) {
        const error = new ProviderError('asr_failed', 'mock-asr', 'mock asr stream failure');
        this.handlers.onError?.(error);
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        resolve(this.buildResult());
      }, this.script.finalDelayMs ?? 20);
      this.pending = { timer, reject };
    });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new ProviderError('asr_failed', 'mock-asr', 'mock asr aborted'));
      this.pending = null;
    }
  }

  private buildResult(): TranscriptResult {
    const partials = this.script.partials ?? [];
    const text = (this.script.final ?? partials[partials.length - 1] ?? '').trim();
    return { text, language: 'zh-CN', durationMs: Math.round((this.fedBytes / 32000) * 1000) };
  }
}
