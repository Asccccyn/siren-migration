import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSirenMcpServer } from '../apps/server/src/mcp/server.ts';
import { serializeAsset } from '../apps/server/src/routes/voice-message.ts';
import { buildTestVoice, connectMcpClient, silentLogger } from './helpers.ts';

describe('independent audit: MCP model projection', () => {
  it('removes internal script and delivery metadata while allowing another get and audio access', async () => {
    const bundle = buildTestVoice();
    const asset = await bundle.voice.speak({ text: '这是一段合成审计正文。\n他说：“零和空值都要保留。”', ttsScript: '[softly] 这是一段合成审计正文。', messageId: 'audit-msg', conversationId: 'audit-conversation' });
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'audit' });
    const { client, close } = await connectMcpClient(server);
    try {
      const result = await client.callTool({ name: 'voice_get', arguments: { voice_message_id: asset.id } });
      const list = await client.callTool({ name: 'voice_list', arguments: { conversation_id: 'audit-conversation' } });
      const payload = JSON.parse((result.content as { text: string }[])[0].text);
      if (process.env.SIREN_AUDIT_OUTPUT_DIR) {
        await mkdir(process.env.SIREN_AUDIT_OUTPUT_DIR, { recursive: true });
        await writeFile(join(process.env.SIREN_AUDIT_OUTPUT_DIR, 'mcp-sample.json'), JSON.stringify({
          evidence: 'real SDK InMemoryTransport tools/call; fake providers; synthetic Chinese text',
          rest: serializeAsset(asset), result, list,
          bytes: { rest: Buffer.byteLength(JSON.stringify(serializeAsset(asset))), model: Buffer.byteLength(JSON.stringify(payload)) },
          target_tokens: 'NOT_MEASURED'
        }, null, 2));
      }
      expect(payload).not.toHaveProperty('tts_script');
      expect(payload).not.toHaveProperty('voice_profile');
      expect(payload).not.toHaveProperty('sample_rate');
      expect(payload).not.toHaveProperty('emotion');
      expect(payload).not.toHaveProperty('conversation_id');
      expect(payload).not.toHaveProperty('message_id');
      expect(payload.text).toBe(asset.text);
      // Existing IDs remain valid; no stored script or HTTP UI field is deleted.
      expect(serializeAsset(asset)).toHaveProperty('tts_script', '[softly] 这是一段合成审计正文。');
      const again = await client.callTool({ name: 'voice_get', arguments: { voice_message_id: payload.id } });
      expect(JSON.parse((again.content as { text: string }[])[0].text).audio_url).toContain('/v1/assets/');
      expect(await bundle.store.get(asset.objectKey)).toBeInstanceOf(Buffer);
      const items = JSON.parse((list.content as { text: string }[])[0].text).items;
      expect(items).toHaveLength(1);
      expect(items[0]).not.toHaveProperty('tts_script');
    } finally { await close(); bundle.db.close(); }
  });

  it('provider errors do not send raw details into the model result', async () => {
    const bundle = buildTestVoice();
    await bundle.store.put('audit.wav', Buffer.alloc(320), 'audio/wav');
    const spy = vi.spyOn(bundle.voice, 'transcribe').mockRejectedValue(new Error('private provider detail ' + 'x'.repeat(1000)));
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'audit' });
    const { client, close } = await connectMcpClient(server);
    try {
      const result = await client.callTool({ name: 'voice_transcribe', arguments: { object_key: 'audit.wav' } });
      const text = (result.content as { text: string }[])[0].text;
      expect(text).not.toContain('private provider detail');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
      expect(result.isError).toBe(true);
    } finally { spy.mockRestore(); await close(); bundle.db.close(); }
  });
});

describe('R3 pagination: long text stays in budget with keyset continuation', () => {
  it('voice_get 4000 汉字：首页 ≤8192B、翻页读尽拼回全文、坏游标如实报', async () => {
    const bundle = buildTestVoice();
    const longText = '海'.repeat(4000);
    const asset = await bundle.voice.speak({ text: longText, messageId: 'r3p-msg', conversationId: 'r3p-conv' });
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'r3p' });
    const { client, close } = await connectMcpClient(server);
    try {
      let collected = '';
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const result = await client.callTool({ name: 'voice_get', arguments: { voice_message_id: asset.id, ...(cursor ? { cursor } : {}) } });
        const payload = JSON.parse((result.content as { text: string }[])[0].text);
        pages += 1;
        if (pages === 1) expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(8192); // R3′ 首页 ≤8192B
        collected += payload.text ?? payload.transcript ?? '';
        if (!payload.text_page?.next_cursor) { expect(payload.text_page.total_pages).toBe(Math.ceil(4000 / 1200)); break; }
        cursor = payload.text_page.next_cursor;
        expect(pages).toBeLessThan(10);
      }
      expect(pages).toBe(4);
      expect(collected).toBe(longText); // R3′ 翻页拼回全文
      const stale = await client.callTool({ name: 'voice_get', arguments: { voice_message_id: asset.id, cursor: Buffer.from(JSON.stringify({ a: asset.id, s: 'tampered', o: 1200 }), 'utf8').toString('base64url') } });
      expect(JSON.parse((stale.content as { text: string }[])[0].text).error).toBe('snapshot_stale');
    } finally { await close(); bundle.db.close(); }
  });

  it('voice_list keyset：并发新增不进当前游标页，翻页无重复无遗漏；单条摘录 ≤ 预算', async () => {
    const bundle = buildTestVoice();
    const mk = async (i: number) => bundle.voice.speak({ text: `第${i}条消息`, messageId: `m${i}`, conversationId: 'r3p-list' });
    for (let i = 1; i <= 5; i++) await mk(i);
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'r3p' });
    const { client, close } = await connectMcpClient(server);
    try {
      const page1 = JSON.parse(((await client.callTool({ name: 'voice_list', arguments: { conversation_id: 'r3p-list', limit: 2 } })).content as { text: string }[])[0].text);
      expect(page1.items).toHaveLength(2);
      expect(typeof page1.next_cursor).toBe('string');
      // 并发新增（更新时间更大）——不应出现在下一页（keyset 语义：新消息以后续查询可见，不挤入当前翻页）
      await mk(6);
      const page2 = JSON.parse(((await client.callTool({ name: 'voice_list', arguments: { conversation_id: 'r3p-list', limit: 2, cursor: page1.next_cursor } })).content as { text: string }[])[0].text);
      expect(page2.items).toHaveLength(2);
      const ids = [...page1.items, ...page2.items].map((x: { id: string }) => x.id);
      expect(new Set(ids).size).toBe(4); // 无重复
      expect(page2.items.every((x: { text?: string }) => (x.text ?? '').length <= 121)); // 列表项摘录 ≤120 字+省略号
    } finally { await close(); bundle.db.close(); }
  });
});
