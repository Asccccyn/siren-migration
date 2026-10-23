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
