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
  /** R2-02（GLM_VOICE_UNIFICATION 复审二）：按 call 交付已留档音频资产清单
   *  （服务间只读，est 据此把 assistant 回复音频绑定到对应消息）。最小合同：
   *  v1 按真实 turn_id 分组；audio_finalized 表示通话及媒体收尾均已结束，
   *  此前空音频只是尚未留档。发送/播放事实独立于资产完整性。
   *  失败语义=404（call 不存在）；重放幂等只读。 */
  app.get('/v1/calls/:callId/turn-audio', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const call = deps.callCenter.describeCall(callId);
    if (!call || call.db_status === 'unknown') { await reply.code(404).send({ error: 'call_not_found' }); return; }
    const rows = deps.callCenter.listTurnAudio(callId);
    await reply.code(200).send({ schema_version: 1, call_id: callId, audio_finalized: call.audio_finalized, turns: rows });
  });

  /** JV-04（联合审计 2026-10-26）：会话事实查询（服务间只读）——est 启动/通知
   *  失败后据正本对账 voice_calls 投影。幂等、无副作用。 */
  app.get('/v1/calls/:callId', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const out = deps.callCenter.describeCall(callId);
    if (!out || out.db_status === 'unknown') { await reply.code(404).send({ error: 'call_not_found' }); return; }
    await reply.code(200).send(out);
  });

  /** A11（2026-10-24）：模型提出挂断——est call_control(end) 服务间调用；立即回执
   *  accepted（不等整通结束，防 Siren↔est 互等死锁）；真正结束由 drain→linger 决定。 */
  app.post('/v1/calls/:callId/hangup-request', async (request, reply) => {
    const { callId } = request.params as { callId: string };
    const session = deps.callCenter.getSession(callId);
    if (!session) { await reply.code(404).send({ error: 'call_not_found' }); return; }
    const out = session.requestHangup();
    await reply.code(200).send({ call_id: callId, ...out, note: '已接受结束意图；等待最后正文播放完成后按 linger 收口，她开口则取消' });
  });

  app.post('/v1/calls', async (request, reply) => {
    const parsed = createCallBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({
        error: 'invalid_body',
        message: 'conversation_id is required: a call must bind the same conversation as the web chat'
      });
      return;
    }
    let result;
    try {
      result = await deps.callCenter.createCall({
        conversationId: parsed.data.conversation_id,
        voiceProfileId: parsed.data.voice_profile
      });
    } catch (error) {
      if ((error as Error).message === 'call_capacity_reached') {
        await reply.code(503).send({ error: 'call_capacity_reached', message: '并发通话已达上限' });
        return;
      }
      throw error;
    }
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
