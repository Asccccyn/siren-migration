// B5/P1（2026-10-24，A09/A10/A12 离线核心）：来电邀请持久状态——
// 服务端过期不依赖轮询、重启恢复（sweeper 启动即扫）、接听/过期竞态单终态、
// 重复操作幂等、declined≠expired（不同事实）、版本 CAS。
import { describe, expect, it } from 'vitest';
import { openDatabase, CallInvitesRepository } from '@siren/storage';

describe('call invites（A09/A10/A12 核心离线合同）', () => {
  it('服务端过期：无任何页面轮询，sweeper 到期回收为唯一 expired 终态', () => {
    const db = openDatabase(':memory:');
    const repo = new CallInvitesRepository(db);
    const now = Date.now();
    repo.create({ id: 'inv-1', conversationId: 'c1', ttlMs: 1000, now });
    expect(repo.get('inv-1')!.state).toBe('pending');
    // 未到期：回收零行
    expect(repo.sweepExpired(now + 500)).toBe(0);
    expect(repo.get('inv-1')!.state).toBe('pending');
    // 到期：一跳回收，唯一终态 + 版本推进
    expect(repo.sweepExpired(now + 1500)).toBe(1);
    const row = repo.get('inv-1')!;
    expect(row.state).toBe('expired');
    expect(row.state_version).toBe(2);
    expect(row.ended_reason).toBe('invite_expired');
    // 再扫幂等
    expect(repo.sweepExpired(now + 2000)).toBe(0);
    db.close();
  });

  it('接听与过期同时发生：只有一方成功（过期先回收→接听 changed=false 不生效）', () => {
    const db = openDatabase(':memory:');
    const repo = new CallInvitesRepository(db);
    const now = Date.now();
    repo.create({ id: 'inv-2', conversationId: 'c1', ttlMs: 1000, now });
    repo.sweepExpired(now + 1500); // 过期已先发生（权威）
    const r = repo.transition('inv-2', 'accepted', { now: now + 1600, onlyBeforeExpiry: true });
    expect(r.changed).toBe(false);
    expect(r.row.state).toBe('expired'); // 自然未接是事实——不因迟到接听翻转
    // 反向：期限内接听成功后，过期回收不再翻转
    repo.create({ id: 'inv-3', conversationId: 'c1', ttlMs: 1000, now });
    const ok = repo.transition('inv-3', 'accepted', { now: now + 100, onlyBeforeExpiry: true });
    expect(ok.changed).toBe(true);
    expect(ok.row.state).toBe('accepted');
    expect(repo.sweepExpired(now + 5000)).toBe(0); // accepted 不被过期回收
    db.close();
  });

  it('重复接听/拒接幂等返回既有终态；declined 不自动转 expired（不同事实）', () => {
    const db = openDatabase(':memory:');
    const repo = new CallInvitesRepository(db);
    const now = Date.now();
    repo.create({ id: 'inv-4', conversationId: 'c1', ttlMs: 60_000, now });
    const first = repo.transition('inv-4', 'declined', { now });
    expect(first.row.state).toBe('declined');
    const again = repo.transition('inv-4', 'accepted', { now: now + 1000, onlyBeforeExpiry: true });
    expect(again.changed).toBe(false);
    expect(again.row.state).toBe('declined'); // 拒接是用户选择：不因后续接听/过期改写
    expect(repo.sweepExpired(now + 120_000)).toBe(0); // declined 不是自然未接
    // 重复取消同键幂等
    repo.create({ id: 'inv-5', conversationId: 'c1', ttlMs: 60_000, now });
    expect(repo.transition('inv-5', 'cancelled', { now }).row.state).toBe('cancelled');
    expect(repo.transition('inv-5', 'cancelled', { now: now + 1 }).changed).toBe(false);
    db.close();
  });

  it('每会话取当前有效邀请（pending 唯一视角）；无邀请 404 语义', () => {
    const db = openDatabase(':memory:');
    const repo = new CallInvitesRepository(db);
    const now = Date.now();
    repo.create({ id: 'inv-6', conversationId: 'c2', ttlMs: 60_000, now });
    expect(repo.activeFor('c2')!.id).toBe('inv-6');
    expect(repo.activeFor('nope')).toBeUndefined();
    db.close();
  });
});

// B5 补充（2026-10-24）：R7-01 探针的 v==3 快照断言被 004-call-invites（A09 产品要求）
// 取代；其语义（v2→v3 升级历史行 outcome NULL 不回填）在 v4 下仍成立，此处版本化断言。
describe('R7-01 语义在迁移 004 后保持', () => {
  it('历史行 outcome NULL=unknown 不回填；新迁移链完整可重入', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const { migrate, MIGRATION_001, addCallTurnLatencyColumns } = await import('@siren/storage');
    const db = new Database(':memory:');
    db.exec(MIGRATION_001); addCallTurnLatencyColumns(db);
    db.exec('CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);INSERT INTO _migrations VALUES (1,0),(2,0)');
    db.prepare("INSERT INTO call_sessions (id,voice_profile,status,created_at) VALUES ('s1','main','active',0)").run();
    db.prepare("INSERT INTO call_turns(id,call_id,turn_index,created_at) VALUES ('old','s1',1,0)").run();
    migrate(db); migrate(db);
    const row = db.prepare('SELECT outcome FROM call_turns WHERE id=?').get('old') as { outcome: string | null };
    expect(row.outcome).toBeNull();
    expect((db.prepare('SELECT max(version) AS v FROM _migrations').get() as { v: number }).v).toBe(6);
    db.close();
  });
});
