/**
 * HttpCoreBridge：HTTP streaming（NDJSON）对接Peer Core（规范第 27 节）。
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
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60000
    );
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
          text: input.text
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new CoreBridgeError('core_http_error', `core responded ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
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
          } else if (message.type === 'error') {
            throw new CoreBridgeError('core_stream_error', message.message ?? 'core stream error');
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // 主动取消（cancel() 或超时）不视为错误抛给上层日志
        return;
      }
      this.options.logger?.warn('core_bridge_error', { ...errorFields(error), call_id: input.callId });
      if (error instanceof CoreBridgeError) throw error;
      throw new CoreBridgeError('core_unreachable', 'failed to reach core', { cause: error });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(input.turnId);
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.controllers.get(turnId)?.abort();
    this.controllers.delete(turnId);
  }
}
