import { describe, expect, it } from 'vitest';
import { CallTokenStore } from '@siren/voice-core';

describe('Call Token（规范第 36 节）', () => {
  it('签发 / 校验 / 绑定 call_id', () => {
    const store = new CallTokenStore(60);
    const { token } = store.issue('call-1', 'conv-1');
    expect(store.verify('call-1', token).ok).toBe(true);
    // 绑定校验：不同 call_id 不能用
    expect(store.verify('call-2', token).ok).toBe(false);
    expect(store.verify('call-2', token).reason).toBe('call_mismatch');
    // 未知 token
    expect(store.verify('call-1', 'garbage').ok).toBe(false);
  });

  it('过期后拒绝（expired token）', async () => {
    const store = new CallTokenStore(0);
    const { token } = store.issue('call-exp', null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = store.verify('call-exp', token);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('通话结束吊销（revokeByCall）', () => {
    const store = new CallTokenStore(60);
    const { token } = store.issue('call-rev', null);
    store.revokeByCall('call-rev');
    expect(store.verify('call-rev', token).ok).toBe(false);
  });
});
