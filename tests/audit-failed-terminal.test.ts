import { describe, expect, it } from 'vitest';
import { createLogger } from '@siren/telemetry';
import { MockTtsProvider } from '@siren/provider-mock';
import type { CoreBridge } from '@siren/core-bridge';
import { buildSessionHarness, waitFor } from './helpers.ts';

describe('independent audit: a reply failure cannot also complete the turn', () => {
  it.each(['core', 'tts'] as const)('%s failure keeps one failed terminal and one metrics frame', async (kind) => {
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (line) => logs.push(JSON.parse(line)) });
    const tts = new MockTtsProvider();
    if (kind === 'tts') tts.faults = { failStream: true, failBatch: true };
    const core: CoreBridge = {
      async *streamReply() {
        yield { text: kind === 'core' ? '已经生成的半句' : '已经生成的正文。' };
        if (kind === 'core') throw new Error('controlled Core failure');
      }, async cancel() {}
    };
    const h = buildSessionHarness({ logger, core, tts });
    try {
      h.session.handleMessage({ t: 'start' });
      h.session.handleBinary(Buffer.alloc(3200, 1));
      h.session.handleMessage({ t: 'end' });
      await waitFor(() => h.texts().some((message) => message.t === 'metrics'));
      expect(h.texts().filter((message) => message.t === 'error')).toEqual([
        expect.objectContaining({ code: `${kind}_failed` })
      ]);
      expect(h.texts().filter((message) => message.t === 'metrics')).toHaveLength(1);
      expect(h.texts().filter((message) => message.t === 'reply')).toHaveLength(1);
      expect(logs.filter((event) => event.event === 'turn_completed')).toEqual([]);
      expect(logs.filter((event) => event.event === 'turn_failed')).toEqual([
        expect.objectContaining({ outcome: `${kind}_failed` })
      ]);
      expect(h.session.state).toBe('listening');
    } finally { h.session.destroy('audit'); }
  });
});
