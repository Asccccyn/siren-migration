import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createSirenMcpServer } from '../apps/server/src/mcp/server.ts';
import { buildTestVoice, connectMcpClient, silentLogger } from './helpers.ts';

describe('MCP player consumes voice_speak', () => {
  it('真实工具结果驱动真实资源JS，展开正文能看见内容', async () => {
    const bundle = buildTestVoice();
    const server = createSirenMcpServer({ voice: bundle.voice, store: bundle.store, logger: silentLogger, version: 'test' });
    const { client, close } = await connectMcpClient(server);
    try {
      const result = await client.callTool({ name: 'voice_speak', arguments: { text: '独立播放器正文', message_id: 'player-copy' } });
      const resource = await client.readResource({ uri: 'ui://siren/voice-player-v1.html' });
      const html = (resource.contents[0] as { text: string }).text;
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(script).toBeTruthy();
      const nodes: Record<string, { textContent: string; src: string; style: { display: string }; onclick?: () => void }> = {};
      for (const id of ['audio', 'play', 'bar', 'time', 'toggle', 'copy', 'status']) {
        nodes[id] = { textContent: '', src: '', style: { display: 'none' } };
      }
      const listeners = new Map<string, (event: unknown) => void>();
      const parent = { postMessage: () => undefined };
      runInNewContext(script!, {
        document: {
          getElementById: (id: string) => nodes[id],
          documentElement: { getBoundingClientRect: () => ({ width: 300, height: 100 }) }
        },
        window: { parent, addEventListener: (event: string, callback: (event: unknown) => void) => listeners.set(event, callback) },
        queueMicrotask: (callback: () => void) => callback(),
        setTimeout: () => 0
      });
      listeners.get('message')!({ source: parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } });
      nodes.toggle!.onclick!();
      expect(nodes.audio!.src).toContain('/v1/assets/');
      expect(nodes.copy!.style.display).toBe('block');
      expect(nodes.copy!.textContent).toBe('独立播放器正文');
    } finally {
      await close();
      bundle.db.close();
    }
  });
});
