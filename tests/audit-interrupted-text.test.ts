import { describe, expect, it } from 'vitest';
import type { CoreBridge } from '@siren/core-bridge';
import type { TtsProvider } from '@siren/contracts';
import { CallSessionsRepository, CallTurnsRepository, openDatabase } from '@siren/storage';
import { buildSessionHarness, waitFor } from './helpers.ts';

describe('independent audit: generated text survives interruption', () => {
  it('preserves raw generated text before the first full sentence audio has finished', async () => {
    const generated = '这是已经生成的完整正文。还有没形成句子的后缀';
    let delivered = false;
    let cancelled = false;
    const core: CoreBridge = {
      async *streamReply() { delivered = true; yield { text: generated }; },
      async cancel() { cancelled = true; }
    };
    const tts: TtsProvider = {
      async *synthesizeStream(_request, signal) {
        yield { audio: Buffer.alloc(480, 1), sampleRate: 24000 };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async synthesize() { throw new Error('batch must not run'); }
    };
    const db = openDatabase(':memory:');
    const turnsRepo = new CallTurnsRepository(db);
    const sessionsRepo = new CallSessionsRepository(db);
    sessionsRepo.insert({ id: 'call-test-1', conversation_id: 'audit-conversation', voice_profile: 'main',
      started_at: null, ended_at: null, status: 'active', asr_provider: 'mock', tts_provider: 'mock', created_at: 0 });
    const h = buildSessionHarness({ core, tts, turnsRepo, sessionsRepo });
    try {
      h.session.handleMessage({ t: 'start' });
      h.session.handleBinary(Buffer.alloc(3200, 1));
      h.session.handleMessage({ t: 'end' });
      await waitFor(() => delivered && h.binaries().length > 0);
      h.session.handleMessage({ t: 'abort' });
      expect(cancelled).toBe(true);
      expect(turnsRepo.listByCall('call-test-1')).toHaveLength(1);
      expect(turnsRepo.listByCall('call-test-1')[0]).toMatchObject({ assistant_text: generated, interrupted: 1 });
      expect(h.texts().find((message) => message.t === 'reply')).toMatchObject({ text: generated });
    } finally {
      h.session.destroy('audit');
      db.close();
    }
  });
});
