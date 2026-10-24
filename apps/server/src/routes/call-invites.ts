/** B5/P1（2026-10-24，A09/A10）：来电邀请 HTTP 面——创建/接听/拒接/取消/查询 + 服务端过期。
 *  expires_at 服务端权威；接听只在期限内成功（与过期竞争只有一方成功）；
 *  重复操作幂等返回既有终态；不依赖页面轮询（sweeper 独立回收，重启后启动扫描恢复）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { CallInvitesRepository } from '@siren/storage';

const createBody = z.object({
  conversation_id: z.string().min(1).max(128),
  voice_profile: z.string().min(1).max(64).optional(),
  ttl_seconds: z.number().int().min(5).max(3600).optional()
});

const DEFAULT_TTL_S = 45;

export interface CallInviteRoutesDeps {
  invites: CallInvitesRepository;
}

export function registerCallInviteRoutes(app: FastifyInstance, deps: CallInviteRoutesDeps): void {
  app.post('/v1/invites', async (request, reply) => {
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_body', message: 'conversation_id required; ttl_seconds 5..3600' });
      return;
    }
    const now = Date.now();
    const row = deps.invites.create({
      id: `inv_${randomUUID()}`,
      conversationId: parsed.data.conversation_id,
      voiceProfile: parsed.data.voice_profile,
      ttlMs: (parsed.data.ttl_seconds ?? DEFAULT_TTL_S) * 1000,
      now
    });
    await reply.code(201).send({
      invite_id: row.id, conversation_id: row.conversation_id, state: row.state,
      expires_at: row.expires_at, created_at: row.created_at,
      note: 'expires_at 服务端权威；过期由服务端回收（不依赖页面轮询）'
    });
  });

  const transition = async (inviteId: string, to: 'accepted' | 'declined' | 'cancelled', reply: { code: (c: number) => { send: (b: unknown) => Promise<void> } }) => {
    const before = deps.invites.get(inviteId);
    if (!before) { await reply.code(404).send({ error: 'invite_not_found' }); return; }
    const { row, changed } = deps.invites.transition(inviteId, to, { now: Date.now(), onlyBeforeExpiry: to === 'accepted' });
    // 竞争语义：接听与过期同时发生只成功一个（changed=false 且 state=expired=过期已先回收）
    if (to === 'accepted' && !changed && row.state === 'pending') {
      await reply.code(409).send({ error: 'transition_conflict', state: row.state });
      return;
    }
    await reply.code(200).send({
      invite_id: row.id, state: row.state, state_version: row.state_version,
      changed, expires_at: row.expires_at,
      ...(row.state === 'expired' && to === 'accepted' ? { note: '过期已先被服务端回收：接听不生效（自然未接是事实）' } : {})
    });
  };

  app.post('/v1/invites/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    await transition(id, 'accepted', reply as never);
  });
  app.post('/v1/invites/:id/decline', async (request, reply) => {
    const { id } = request.params as { id: string };
    await transition(id, 'declined', reply as never);
  });
  app.post('/v1/invites/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    await transition(id, 'cancelled', reply as never);
  });
  app.get('/v1/invites/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = deps.invites.get(id);
    if (!row) { await reply.code(404).send({ error: 'invite_not_found' }); return; }
    await reply.code(200).send({ invite_id: row.id, conversation_id: row.conversation_id, state: row.state, state_version: row.state_version, expires_at: row.expires_at, created_at: row.created_at });
  });
  app.get('/v1/conversations/:conversation_id/active-invite', async (request, reply) => {
    const { conversation_id } = request.params as { conversation_id: string };
    const row = deps.invites.activeFor(conversation_id);
    if (!row) { await reply.code(404).send({ error: 'no_active_invite' }); return; }
    await reply.code(200).send({ invite_id: row.id, state: row.state, expires_at: row.expires_at });
  });
  // 协议①（2026-10-24）：est 卡片投影数据源——当前有效邀请 + 近期终态（未接/拒接/取消）。
  // 期限回收仍由 sweeper 服务端完成，本端点只读。
  app.get('/v1/conversations/:conversation_id/invites', async (request, reply) => {
    const { conversation_id } = request.params as { conversation_id: string };
    const rows = deps.invites.recentFor(conversation_id, 10);
    await reply.code(200).send({
      conversation_id,
      active: rows.find((r) => r.state === 'pending') ?? null,
      recent: rows.filter((r) => r.state !== 'pending').map((r) => ({
        invite_id: r.id, state: r.state, expires_at: r.expires_at, created_at: r.created_at,
        updated_at: r.updated_at, ended_reason: r.ended_reason
      }))
    });
  });
}

/** 服务端过期 sweeper（app 启动恢复=立即一跳；此后周期回收）。不占请求路径。 */
export function startInviteExpirySweeper(invites: CallInvitesRepository, intervalMs = 5000): () => void {
  const tick = (): void => { try { invites.sweepExpired(Date.now()); } catch { /* 下一跳再试 */ } };
  tick(); // 重启恢复：启动即回收已过期邀请
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
