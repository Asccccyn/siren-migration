/**
 * MockCoreBridge：仅供开发与测试。
 * 生产环境默认禁止启用（config 层有守卫，规范第 47 节第 21 条）。
 */
import type { CoreBridge, CoreDelta, CoreTurnInput } from './types.ts';

export interface MockCoreBridgeOptions {
  reply?: string;
  /** 每个 delta 的发射间隔（ms） */
  intervalMs?: number;
  /** 每次 delta 的字符数 */
  charsPerDelta?: number;
}

const DEFAULT_REPLIES = [
  '嗯，我在听。你说，我慢慢回。',
  '好，我知道了。今天先这样，早点休息。',
  '这听起来不错。我们明天再细说吧。'
];

export class MockCoreBridge implements CoreBridge {
  private readonly reply: string;
  private readonly intervalMs: number;
  private readonly charsPerDelta: number;
  private replyIndex = 0;

  constructor(options: MockCoreBridgeOptions = {}) {
    this.reply = options.reply ?? DEFAULT_REPLIES[0];
    this.intervalMs = options.intervalMs ?? 8;
    this.charsPerDelta = options.charsPerDelta ?? 2;
  }

  async *streamReply(_input: CoreTurnInput): AsyncGenerator<CoreDelta> {
    const text = this.pickReply();
    for (let i = 0; i < text.length; i += this.charsPerDelta) {
      yield { text: text.slice(i, i + this.charsPerDelta) };
      await sleep(this.intervalMs);
    }
  }

  async cancel(_turnId: string): Promise<void> {
    // Mock 没有需要取消的外部资源
  }

  private pickReply(): string {
    const replies = [this.reply, ...DEFAULT_REPLIES.filter((r) => r !== this.reply)];
    const chosen = replies[this.replyIndex % replies.length];
    this.replyIndex++;
    return chosen;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
