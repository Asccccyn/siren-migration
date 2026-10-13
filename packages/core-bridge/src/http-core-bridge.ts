/**
 * HttpCoreBridge：HTTP streaming（NDJSON）对接 Peer Core（规范第 27 节）。
 * POST {CORE_BASE_URL}/v1/chat/stream，逐行读取 {"type":"delta","text":"..."}。
 */
import type { Logger } from '@siren/telemetry';
import { errorFields } from '@siren/telemetry';
import { CoreBridgeError, type CoreBridge, type CoreDelta, type CoreTurnInput } from './types.ts';

export interface HttpCoreBridgeOptions {
  baseUrl: string;
  apiToken?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export class HttpCoreBridge implements CoreBridge {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: HttpCoreBridgeOptions) {}

  async *streamReply(input: CoreTurnInput): AsyncGenerator<CoreDelta> {
    const controller = new AbortController();
    this.controllers.set(input.turnId, controller);
    // F11：超时与主动取消共用 abort 信号，必须单独标记——
    // 超时静默 return 会把截断的回复当正常完成（success + 空/半截文本）
    let timedOut = false;
    const timeoutMs = this.options.timeoutMs ?? 60000;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/v1/chat/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-ndjson',
          ...(this.options.apiToken ? { authorization: `Bearer ${this.options.apiToken}` } : {})
        },
        body: JSON.stringify({
          conversation_id: input.conversationId,
          call_id: input.callId,
          turn_id: input.turnId,
          modality: input.modality,
          text: input.text,
          ...(input.interruptedTurn ? {
            interrupted_turn: {
              turn_id: input.interruptedTurn.turnId,
              input_id: input.interruptedTurn.inputId,
              output_stream_id: input.interruptedTurn.outputStreamId,
              playback: input.interruptedTurn.playback.basis === 'client_reported'
                ? { basis: 'client_reported', played_ms: input.interruptedTurn.playback.playedMs }
                : { basis: 'unknown' }
            }
          } : {})
        }),
        signal: controller.signal
      });
      responseBody = response.body;
      if (!response.ok || !responseBody) {
        throw new CoreBridgeError('core_http_error', `core responded ${response.status}`);
      }
      reader = responseBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // S1011-024：应用层 done 终态——done 即完成，EOF 与 done 后帧各有明确语义
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          let message: { type?: string; text?: string; message?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue; // 忽略残行
          }
          if (message.type === 'delta' && typeof message.text === 'string' && message.text.length > 0) {
            yield { text: message.text };
          } else if (message.type === 'done') {
            break outer;
          } else if (message.type === 'error') {
            throw new CoreBridgeError('core_stream_error', message.message ?? 'core stream error');
          }
        }
      }
    } catch (error) {
      if (timedOut) {
        throw new CoreBridgeError('core_timeout', `core reply timed out after ${timeoutMs}ms`);
      }
      if (controller.signal.aborted) {
        // 主动取消（cancel()）不视为错误抛给上层日志
        return;
      }
      this.options.logger?.warn('core_bridge_error', { ...errorFields(error), call_id: input.callId });
      if (error instanceof CoreBridgeError) throw error;
      throw new CoreBridgeError('core_unreachable', 'failed to reach core', { cause: error });
    } finally {
      clearTimeout(timeout);
      // Logical done is not HTTP EOF. Keep ownership until the body and reader
      // have been canceled/released, including early consumer return/errors.
      controller.abort();
      try {
        if (reader) await reader.cancel().catch(() => undefined);
        else await responseBody?.cancel().catch(() => undefined);
      } finally {
        reader?.releaseLock();
        if (this.controllers.get(input.turnId) === controller) this.controllers.delete(input.turnId);
      }
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.controllers.get(turnId)?.abort();
    this.controllers.delete(turnId);
  }
}
