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
  /** 2026-10-24 协议②：本轮用户原声资产引用（siren:<voice_asset_id>）——est 取回字节绑
   *  消息附件，供 oído 快证据/按需深听；缺省=该轮无原声（纯文本轮）。 */
  audioRef?: string;
  /** Prior interrupted reply, with explicitly limited playback evidence. */
  interruptedTurn?: CoreInterruption;
}

export interface CoreInterruption {
  turnId: string;
  inputId: string;
  outputStreamId: string;
  playback: { basis: 'unknown' } | { basis: 'client_reported'; playedMs: number };
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
