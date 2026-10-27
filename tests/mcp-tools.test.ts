import { describe, expect, it, vi } from 'vitest';
import { FieldDecryptionError } from '@siren/storage';
import { createSirenMcpServer } from '../apps/server/src/mcp/server.ts';
import { buildTestVoice, connectMcpClient, silentLogger } from './helpers.ts';

function toolPayload(result: { content: { type: string; text: string }[] }): Record<string, unknown> {
  expect(result.content.length).toBeGreaterThan(0);
  return JSON.parse(result.content[0].text);
}

describe('Voice MCP（走完整 MCP 协议）', () => {
  it('speak/get/list 的解密失败返回明确 data_unreadable，不伪装为语音合成失败', async () => {
    const bundle = buildTestVoice();
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'test' });
    const { client, close } = await connectMcpClient(server);
    const cases = [
      { tool: 'voice_speak', method: 'speak', args: { text: 'test' } },
      { tool: 'voice_get', method: 'getVoiceMessage', args: { message_id: 'test' } },
      { tool: 'voice_list', method: 'listVoiceMessages', args: {} }
    ] as const;
    try {
      for (const entry of cases) {
        const mocked = vi.spyOn(bundle.voice, entry.method).mockRejectedValue(new FieldDecryptionError());
        const result = await client.callTool({ name: entry.tool, arguments: entry.args });
        expect(result.isError).toBe(true);
        expect(toolPayload(result as never)).toEqual({ error: 'data_unreadable' });
        mocked.mockRestore();
      }
    } finally {
      await close();
      bundle.db.close();
      vi.restoreAllMocks();
    }
  });

  it('voice_speak：正常合成并返回 audio_url', async () => {
    const bundle = buildTestVoice();
    const server = createSirenMcpServer({
      voice: bundle.voice,
      store: bundle.store,
      logger: silentLogger,
      version: 'test'
    });
    const { client, close } = await connectMcpClient(server);
    try {
      const result = await client.callTool({
        name: 'voice_speak',
        arguments: {
          text: '你，我在。',
          tts_script: '[softly] 你，我在。',
          conversation_id: 'conv-mcp',
          message_id: 'mcp-msg-1',
          emotion: 'warm'
        }
      });
      const payload = toolPayload(result as never);
      expect(payload.voice_message_id).toBeTruthy();
      expect(String(payload.audio_url)).toContain('/v1/assets/');
      expect(Number(payload.duration_ms)).toBeGreaterThan(0);
      // R3″（RE-16）+ JV-16a（GLM_VOICE_UNIFICATION）：content 精简回执；整个结果面
      // 无全文（structuredContent 已随播放器退役）、无 player meta
      expect(payload.spoken).toBe(true);
      expect(payload).not.toHaveProperty('text_excerpt'); // 正文在调用参数里，回执无需摘录
      expect(payload).not.toHaveProperty('text');
      expect(payload).not.toHaveProperty('tts_script');
      expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(2048); // 本包回执预算
      expect((result as { _meta?: Record<string, unknown> })._meta?.['openai/outputTemplate']).toBeUndefined();
      // 幂等：重复调用同一 message_id
      const again = await client.callTool({
        name: 'voice_speak',
        arguments: { text: '你，我在。', conversation_id: 'conv-mcp', message_id: 'mcp-msg-1' }
      });
      expect(toolPayload(again as never).voice_message_id).toBe(payload.voice_message_id);
    } finally {
      await close();
    }
  });


  it('voice_speak：非法输入返回 isError（MCP 输入校验）', async () => {
    const bundle = buildTestVoice();
    const server = createSirenMcpServer({
      voice: bundle.voice,
      store: bundle.store,
      logger: silentLogger,
      version: 'test'
    });
    const { client, close } = await connectMcpClient(server);
    try {
      const empty = await client.callTool({ name: 'voice_speak', arguments: { text: '' } });
      expect((empty as { isError?: boolean }).isError).toBe(true);

      const badEmotion = await client.callTool({
        name: 'voice_speak',
        arguments: { text: 'x', emotion: 'not-an-emotion' }
      });
      expect((badEmotion as { isError?: boolean }).isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('voice_transcribe：object_key 转写；非法输入报错', async () => {
    const bundle = buildTestVoice();
    await bundle.store.put('voice/in/x.wav', Buffer.alloc(32000), 'audio/wav');
    const server = createSirenMcpServer({
      voice: bundle.voice,
      store: bundle.store,
      logger: silentLogger,
      version: 'test'
    });
    const { client, close } = await connectMcpClient(server);
    try {
      const result = await client.callTool({
        name: 'voice_transcribe',
        arguments: { object_key: 'voice/in/x.wav' }
      });
      const payload = toolPayload(result as never);
      expect(String(payload.text).length).toBeGreaterThan(0);

      const missing = await client.callTool({ name: 'voice_transcribe', arguments: {} });
      expect((missing as { isError?: boolean }).isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('voice_get / voice_list 查询', async () => {
    const bundle = buildTestVoice();
    await bundle.voice.speak({ text: '一', messageId: 'g-1', conversationId: 'gc' });
    await bundle.voice.speak({ text: '二', messageId: 'g-2', conversationId: 'gc' });
    const server = createSirenMcpServer({
      voice: bundle.voice,
      store: bundle.store,
      logger: silentLogger,
      version: 'test'
    });
    const { client, close } = await connectMcpClient(server);
    try {
      const got = await client.callTool({ name: 'voice_get', arguments: { message_id: 'g-1' } });
      expect(toolPayload(got as never).text).toBe('一');

      const missing = await client.callTool({ name: 'voice_get', arguments: { message_id: 'ghost' } });
      expect((missing as { isError?: boolean }).isError).toBe(true);

      const list = await client.callTool({
        name: 'voice_list',
        arguments: { conversation_id: 'gc', limit: 10 }
      });
      const payload = toolPayload(list as never) as { items: unknown[] };
      expect(payload.items.length).toBe(2);
    } finally {
      await close();
    }
  });
});

// G01（GLM_VOICE_UNIFICATION 04§5.2）：回执预算——不随正文线性增长，≤2KiB 同形
it('voice_speak 回执预算：3000/3900 字同形且 ≤2KiB', async () => {
  const bundle = buildTestVoice();
  const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'test' });
  const { client, close } = await connectMcpClient(server);
  try {
    const sizes: number[] = [];
    for (const len of [3000, 3900]) { // 30000 超现行输入合同 text≤4000（contracts/mcp.ts）——同形验证用近上限值
      const res = await client.callTool({ name: 'voice_speak', arguments: { text: '语'.repeat(len), conversation_id: 'conv-budget', message_id: `budget-${len}` } });
      expect(res.isError).toBeFalsy();
      const payload = toolPayload(res as never);
      expect(payload.voice_message_id).toBeTruthy();
      expect(payload).not.toHaveProperty('text');
      sizes.push(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    }
    expect(sizes[0]!).toBeLessThanOrEqual(2048);
    expect(sizes[1]!).toBeLessThanOrEqual(2048);
    expect(Math.abs(sizes[1]! - sizes[0]!)).toBeLessThan(64); // 同形：不随正文线性增长
  } finally {
    await close();
    bundle.db.close();
  }
});
