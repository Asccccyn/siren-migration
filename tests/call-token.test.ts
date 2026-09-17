import { describe, expect, it } from 'vitest';
import { CallTokenStore } from '@siren/voice-core';

describe('Call Token（规范第 36 节 / P0-5 上下文冻结）', () => {
  it('签发 / 校验 / 绑定 call_id，并携带冻结的 conversation / profile', () => {
    const store = new CallTokenStore(60);
    const { token } = store.issue('call-1', 'conv-1', 'main');
    const ok = store.verify('call-1', token);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.conversationId).toBe('conv-1');
      expect(ok.payload.voiceProfileId).toBe('main');
    }
    // 绑定校验：不同 call_id 不能用
    const mismatch = store.verify('call-2', token);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe('call_mismatch');
    // 未知 token
    expect(store.verify('call-1', 'garbage').ok).toBe(false);
  });

  it('conversation / voice profile 冻结在签发时刻，verify 无法改写', () => {
    const store = new CallTokenStore(60);
    const { token } = store.issue('call-f', 'conv-frozen', 'profile-a');
    const result = store.verify('call-f', token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // reservation 是唯一真相源：不存在通过 verify 参数改写上下文的路径
      expect(result.payload.conversationId).toBe('conv-frozen');
      expect(result.payload.voiceProfileId).toBe('profile-a');
    }
  });

  it('过期后拒绝（expired token）', async () => {
    const store = new CallTokenStore(0);
    const { token } = store.issue('call-exp', null, 'main');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = store.verify('call-exp', token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('通话结束吊销（revokeByCall），重放被拒', () => {
    const store = new CallTokenStore(60);
    const { token } = store.issue('call-rev', 'conv-rev', 'main');
    store.revokeByCall('call-rev');
    expect(store.verify('call-rev', token).ok).toBe(false);
  });
});
