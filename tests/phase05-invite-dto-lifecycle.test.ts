// Phase 0.5 整改验证（跨仓预审 F-02/F-04，2026-10-25）：
// - F-02：/v1/conversations/:id/invites 的 active 与 recent 同一 DTO（invite_id 键）——
//   消费者（est 横幅/接听/拒接/模型取消）读 invite_id 不再得到 undefined。
// - F-04：CallCenter 会话注册/销毁驱动 est 生命周期回调（register/end）——
//   Siren 拥有通话生死，终态同步不依赖浏览器页面收口。
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openDatabase, CallInvitesRepository, CallSessionsRepository } from '@siren/storage';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { MockCoreBridge } from '@siren/core-bridge';
import { CallCenter, FillerManager } from '@siren/voice-core';
import { registerCallInviteRoutes } from '../apps/server/src/routes/call-invites.ts';
import { silentLogger, testConfig, testProfiles } from './helpers.ts';

describe('F-02 邀请 DTO：active 投影带 invite_id', () => {
  it('创建→列表 active.invite_id→按该 id 接听成功→列表 active=null + recent 记录', async () => {
    const db = openDatabase(':memory:');
    const repo = new CallInvitesRepository(db);
    const app = Fastify();
    registerCallInviteRoutes(app, { invites: repo });
    await app.ready();

    const created = await app.inject({ method: 'POST', url: '/v1/invites', payload: { conversation_id: 'c1' } });
    expect(created.statusCode).toBe(201);
    const inviteId = created.json()['invite_id'] as string;

    const list = await app.inject({ method: 'GET', url: '/v1/conversations/c1/invites' });
    const active = list.json()['active'] as Record<string, unknown>;
    // 消费者合同：active 用 invite_id（与 recent 一致），不直出 DB 行的 id 键
    expect(active).not.toBeNull();
    expect(typeof active['invite_id']).toBe('string');
    expect(active['invite_id']).toBe(inviteId);
    expect(active['state']).toBe('pending');
    expect(active['id']).toBeUndefined();

    const accepted = await app.inject({ method: 'POST', url: `/v1/invites/${encodeURIComponent(active['invite_id'] as string)}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()['state']).toBe('accepted');
    expect(accepted.json()['invite_id']).toBe(inviteId);

    const after = await app.inject({ method: 'GET', url: '/v1/conversations/c1/invites' });
    expect(after.json()['active']).toBeNull();
    const recent = after.json()['recent'] as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0]!['invite_id']).toBe(inviteId);
    expect(recent[0]!['state']).toBe('accepted');

    await app.close();
    db.close();
  });
});

describe('F-04 CallCenter 生命周期回调（S→est 终态同步接线）', () => {
  it('WS 会话注册触发 register；destroy（linger/断线同路径）触发 end', async () => {
    const events: Array<{ what: string; callId: string; conversationId: string | null }> = [];
    const center = new CallCenter({
      config: testConfig({}),
      logger: silentLogger,
      realtimeAsr: new MockAsrProvider(),
      realtimeTts: new MockTtsProvider(),
      core: new MockCoreBridge(),
      fillers: new FillerManager('/unused', false, silentLogger),
      profiles: testProfiles(),
      callLifecycle: {
        register: (callId, conversationId) => events.push({ what: 'register', callId, conversationId }),
        end: (callId, conversationId) => events.push({ what: 'end', callId, conversationId })
      }
    });
    const call = await center.createCall({ conversationId: 'primary' });
    expect(events).toEqual([]); // 签发 token ≠ 通话开始：未连 WS 不通知
    const session = center.createSession({
      callId: call.callId,
      reservation: center.verifyToken(call.callId, call.token)!,
      send: () => undefined,
      bufferedAmount: () => 0,
      close: () => undefined
    });
    expect(session).not.toBeNull();
    expect(events).toEqual([{ what: 'register', callId: call.callId, conversationId: 'primary' }]);

    session!.destroy('model_hangup');
    expect(events).toEqual([
      { what: 'register', callId: call.callId, conversationId: 'primary' },
      { what: 'end', callId: call.callId, conversationId: 'primary' }
    ]);
    expect(center.getSession(call.callId)).toBeUndefined();
  });
});

describe('JV-04 会话事实查询（GET /v1/calls/:id，est 对账源）', () => {
  it('签发未连=active无会话；WS 注册=有会话；destroy=ended（正本收敛）', async () => {
    const center = new CallCenter({
      config: testConfig({}),
      logger: silentLogger,
      realtimeAsr: new MockAsrProvider(),
      realtimeTts: new MockTtsProvider(),
      core: new MockCoreBridge(),
      fillers: new FillerManager('/unused', false, silentLogger),
      profiles: testProfiles(),
      sessionsRepo: new CallSessionsRepository(openDatabase(':memory:'))
    });
    const call = await center.createCall({ conversationId: 'primary' });
    // 签发未连：DB active、无 WS 会话
    let f = center.describeCall(call.callId)!;
    expect(f.db_status).toBe('active');
    expect(f.session_active).toBe(false);
    // WS 注册：会话出现
    const session = center.createSession({
      callId: call.callId,
      reservation: center.verifyToken(call.callId, call.token)!,
      send: () => undefined, bufferedAmount: () => 0, close: () => undefined
    });
    f = center.describeCall(call.callId)!;
    expect(f.session_active).toBe(true);
    expect(f.db_status).toBe('active');
    // destroy（linger/断线同路径）：正本 ended
    session!.destroy('model_hangup');
    f = center.describeCall(call.callId)!;
    expect(f.db_status).toBe('ended');
    expect(f.session_active).toBe(false);
  });
});
