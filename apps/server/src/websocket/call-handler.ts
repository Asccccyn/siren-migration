/**
 * /ws/call/:callId 实时通话 WebSocket 入口（规范第 18/36 节 / v1.1 P0-5）。
 * - 握手只接受 callId + token；conversation / voice profile 从 token 冻结的 reservation 恢复
 *   （query 中携带 conversation_id / voice_profile 一律忽略并告警，客户端不得重新定义）
 * - 二进制帧 = PCM16/16kHz/mono；文本帧 = JSON 协议消息
 * - close 时销毁 CallSession，释放 ASR / LLM / TTS（幂等 finalize，P0-6）
 * - 服务端心跳检测死连接
 */
import type { FastifyInstance } from 'fastify';
import { WS_CLOSE_CODES, type ClientWsMessage } from '@siren/contracts';
import type { CallCenter, SirenConfig } from '@siren/voice-core';
import type { Logger } from '@siren/telemetry';

export interface CallHandlerDeps {
  config: SirenConfig;
  logger: Logger;
  callCenter: CallCenter;
}

export function registerCallWebSocket(app: FastifyInstance, deps: CallHandlerDeps): void {
  app.get('/ws/call/:callId', { websocket: true }, (socket, request) => {
    const callId = (request.params as { callId: string }).callId;
    const query = request.query as Record<string, string | undefined>;
    const log = deps.logger.child({ call_id: callId });

    // P0-5：上下文参数不允许从握手进入，出现即说明客户端走了旧协议
    if (query.conversation_id || query.voice_profile || request.headers['x-siren-conversation']) {
      log.warn('ws_client_context_override_ignored', {
        hint: 'conversation/voice profile are frozen in the call token; query overrides ignored'
      });
    }

    const reservation = query.token ? deps.callCenter.verifyToken(callId, query.token) : null;
    if (!reservation) {
      socket.close(WS_CLOSE_CODES.INVALID_TOKEN, 'invalid or expired call token');
      return;
    }

    const session = deps.callCenter.createSession({
      callId,
      reservation,
      send: (data, binary) => {
        if (binary) socket.send(binary);
        else socket.send(data);
      },
      bufferedAmount: () => socket.bufferedAmount,
      close: (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          // 已关闭
        }
      }
    });
    if (!session) {
      socket.close(WS_CLOSE_CODES.SESSION_EXISTS, 'call session already active');
      return;
    }

    deps.logger.info('ws_client_connected', {
      call_id: callId,
      conversation_id: reservation.conversationId,
      voice_profile: reservation.voiceProfileId
    });

    // 心跳：服务端 ping，两个周期无 pong 则 terminate
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }, deps.config.ws.heartbeatIntervalMs);
    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        session.handleBinary(Buffer.from(data as ArrayBuffer));
        return;
      }
      let message: ClientWsMessage | null = null;
      try {
        message = JSON.parse(String(data)) as ClientWsMessage;
      } catch {
        log.warn('ws_invalid_json_frame', {});
        return;
      }
      session.handleMessage(message);
    });

    socket.on('close', (code) => {
      clearInterval(heartbeat);
      log.info('ws_client_closed', { code });
      session.destroy('client_closed');
    });

    socket.on('error', (error) => {
      clearInterval(heartbeat);
      log.warn('ws_client_error', { error_message: error.message });
      session.destroy('socket_error');
    });
  });
}
