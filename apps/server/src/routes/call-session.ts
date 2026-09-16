/** POST /v1/calls（规范第 14/36 节）：创建实时通话 + 短生命周期 token */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallCenter } from '@siren/voice-core';

const createCallBodySchema = z.object({
  conversation_id: z.string().min(1).max(128).optional(),
  voice_profile: z.string().min(1).max(64).optional()
});

export interface CallSessionRoutesDeps {
  callCenter: CallCenter;
}

export function registerCallSessionRoutes(app: FastifyInstance, deps: CallSessionRoutesDeps): void {
  app.post('/v1/calls', async (request, reply) => {
    const parsed = createCallBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body' });
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
      expires_at: result.expiresAt
    });
  });
}
