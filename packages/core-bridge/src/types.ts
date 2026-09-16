/**
 * Core Bridge 合同（规范第 26 节）。
 * Siren 不直接绑定任何 LLM；人格 / 记忆 / 对话历史 / 工具全部由Peer Core 负责。
 */

export interface CoreTurnInput {
  conversationId?: string;
  callId: string;
  turnId: string;
  text: string;
  modality: 'voice_call';
}

export interface CoreDelta {
  text: string;
}

export interface CoreBridge {
  streamReply(input: CoreTurnInput): AsyncIterable<CoreDelta>;
  cancel(turnId: string): Promise<void>;
}

export class CoreBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CoreBridgeError';
    this.code = code;
  }
}
