// JV-11（联合审计 2026-10-26）整改验证：UUID 会话 + 时间过滤器的合法游标必须被
// 自身 schema（≤200）接受——修复前指纹为 filter base64，游标 207 字符，第二页 -32602。
// 固定长度 hash 后游标有确定上界；旧编码游标被指纹校验诚实拒绝（重启分页）。
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, VoiceAssetsRepository, encodeListCursor, decodeListCursor, listQueryFingerprint, deriveFieldCipher } from '@siren/storage';
import { voiceListInputSchema } from '@siren/contracts';

describe('JV-11 voice_list 游标长度', () => {
  it('UUID+时间过滤游标过自身 schema 且往返可解；旧式游标被拒绝', () => {
    const conversationId = randomUUID();
    const filter = { conversationId, fromMs: Date.now() - 1000, toMs: Date.now() + 1000 };
    const cursor = encodeListCursor({ c: Date.now(), i: randomUUID(), r: 1, q: listQueryFingerprint(filter) });
    expect(cursor.length).toBeLessThanOrEqual(200);
    expect(cursor.length).toBeGreaterThan(8);
    // 自身输入 schema 接受（修复前 207>200 被 -32602 拒绝）
    expect(voiceListInputSchema.safeParse({ cursor }).success).toBe(true);
    // 往返：同一 filter 可解
    const decoded = decodeListCursor(cursor, filter);
    expect(decoded.c).toBeGreaterThan(0);
    // 旧编码（filter base64 指纹）→ 指纹不等 → INVALID_CURSOR（诚实拒绝，不误读）
    const legacyFingerprint = Buffer.from(JSON.stringify([conversationId, null, null, filter.fromMs, filter.toMs])).toString('base64url');
    const legacyCursor = encodeListCursor({ c: Date.now(), i: randomUUID(), r: 1, q: legacyFingerprint });
    expect(() => decodeListCursor(legacyCursor, filter)).toThrow(/different query/);
    void openDatabase; void VoiceAssetsRepository; void deriveFieldCipher;
  });
});
