/**
 * B5/P1（2026-10-24）：来电邀请仓储——唯一权威状态 + CAS 终态转换 + 服务端过期回收。
 * 接听与过期同时发生只能成功一个；重复接听/重复收作废幂等返回既有终态；
 * 拒接与自然过期是不同事实（declined/expired 分立，互不自动转化）。
 */
export interface CallInviteRow {
  id: string;
  conversation_id: string;
  voice_profile: string;
  state: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  state_version: number;
  expires_at: number;
  accepted_at: number | null;
  ended_reason: string | null;
  created_at: number;
  updated_at: number;
}

export type InviteTransition = 'accept' | 'decline' | 'cancel' | 'expire';

export class CallInvitesRepository {
  constructor(private readonly db: import('../sqlite.ts').SqliteDatabase) {}

  create(opts: { id: string; conversationId: string; voiceProfile?: string; ttlMs: number; now: number }): CallInviteRow {
    this.db.prepare(`INSERT INTO call_invites (id, conversation_id, voice_profile, state, state_version, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)`).run(opts.id, opts.conversationId, opts.voiceProfile ?? 'main', opts.now + opts.ttlMs, opts.now, opts.now);
    return this.get(opts.id)!;
  }

  get(id: string): CallInviteRow | undefined {
    return this.db.prepare('SELECT * FROM call_invites WHERE id = ?').get(id) as CallInviteRow | undefined;
  }

  /** CAS 终态转换：pending → 目标态；已终态幂等返回既有行（重复接听/迟到过期均不二次翻转）。
   *  accept 与 expire 竞争：同一 UPDATE ... WHERE state='pending' 只有一方命中。 */
  transition(id: string, to: Exclude<CallInviteRow['state'], 'pending'>, opts: { now: number; onlyBeforeExpiry?: boolean }): { row: CallInviteRow; changed: boolean } {
    const before = this.get(id);
    if (!before) throw new Error('invite_not_found');
    if (before.state !== 'pending') return { row: before, changed: false };
    if (opts.onlyBeforeExpiry && before.expires_at < opts.now) {
      // 只允许在期限内接听；过期由 expire 回收——竞争只有一方成功
      return { row: before, changed: false };
    }
    const info = this.db.prepare(`UPDATE call_invites
      SET state = ?, state_version = state_version + 1, accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
          ended_reason = CASE WHEN ? = 'accepted' THEN NULL ELSE ? END, updated_at = ?
      WHERE id = ? AND state = 'pending'`).run(to, to, opts.now, to, `invite_${to}`, opts.now, id);
    return { row: this.get(id)!, changed: info.changes > 0 };
  }

  /** 服务端过期回收（sweeper 每跳 + 重启后首跳）：不依赖任何页面轮询。 */
  sweepExpired(now: number): number {
    const info = this.db.prepare(`UPDATE call_invites SET state = 'expired', state_version = state_version + 1,
      ended_reason = 'invite_expired', updated_at = ?
      WHERE state = 'pending' AND expires_at < ?`).run(now, now);
    return info.changes;
  }

  /** 当前有效邀请（给前端来电页/重启恢复用） */
  activeFor(conversationId: string): CallInviteRow | undefined {
    return this.db.prepare(`SELECT * FROM call_invites WHERE conversation_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1`).get(conversationId) as CallInviteRow | undefined;
  }

  /** 协议①（2026-10-24）：近 N 条邀请（pending 优先置前）——est 卡片投影数据源 */
  recentFor(conversationId: string, limit: number): CallInviteRow[] {
    return this.db.prepare(`SELECT * FROM call_invites WHERE conversation_id = ? ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`).all(conversationId, limit) as CallInviteRow[];
  }
}
