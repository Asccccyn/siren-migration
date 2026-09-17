/** POST /v1/calls（规范第 14/36 节）：创建实时通话 + 短生命周期 token（上下文在此冻结） */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallCenter } from '@siren/voice-core';

const createCallBodySchema = z.object({
  /** 必填：CallSession 必须绑定网页当前使用的同一个 conversation（P0-4.5） */
  conversation_id: z.string().min(1).max(128),
  voice_profile: z.string().min(1).max(64).optional()
});

export interface CallSessionRoutesDeps {
  callCenter: CallCenter;
}

export function registerCallSessionRoutes(app: FastifyInstance, deps: CallSessionRoutesDeps): void {
  app.post('/v1/calls', async (request, reply) => {
    const parsed = createCallBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({
        error: 'invalid_body',
        message: 'conversation_id is required: a call must bind the same conversation as the web chat'
      });
      return;
    }
    const result = await deps.callCenter.createCall({
      conversationId: parsed.data.conversation_id,
      voiceProfileId: parsed.data.voice_profile
    });
    await reply.code(201).send({
      call_id: result.callId,
      ws_url: result.wsUrl,
      token: result.token,
      expires_at: result.expiresAt,
      conversation_id: result.conversationId,
      voice_profile: result.voiceProfileId
    });
  });
}
