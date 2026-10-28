import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalObjectStore } from '@siren/storage';
import type { CallTurnAudio } from '@siren/contracts';
import type { CallSession } from '@siren/voice-core';
import { buildTestApp, waitFor } from './helpers.ts';

for (const outcome of ['complete', 'partial', 'empty'] as const) it(`通话媒体收尾：${outcome}，结束会话后仍等待实际保存`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-audio-finalized-'));
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  let archiveStarted = false;
  let binaryCount = 0;
  const frames: Array<Record<string, unknown>> = [];
  let session: CallSession | null = null;
  const siren = await buildTestApp({}, providers => {
    const store = new LocalObjectStore({ rootDir: root, publicBaseUrl: 'http://127.0.0.1:9', signingSecret: 'synthetic-only' });
    const put = store.put.bind(store);
    store.put = async (key, bytes, contentType) => {
      if (key.endsWith('/reply.wav')) {
        archiveStarted = true;
        await saving;
      }
      return put(key, bytes, contentType);
    };
    providers.store = store;
    providers.core = { async *streamReply() { yield { text: '合成测试回复。' }; }, async cancel() {} };
    providers.realtimeTts = {
      async synthesize() { throw new Error('unexpected batch synthesis'); },
      async *synthesizeStream(_request, signal) {
        if (outcome === 'empty') return;
        yield { audio: Buffer.alloc(960, 3), sampleRate: 24000 };
        if (outcome === 'partial') {
          await new Promise<void>(resolve => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          signal?.throwIfAborted();
        }
      },
    };
  });
  try {
    const created = await siren.app.inject({ method: 'POST', url: '/v1/calls', payload: { conversation_id: 'primary' } });
    expect(created.statusCode).toBe(201);
    const { call_id: callId, token } = created.json<{ call_id: string; token: string }>();
    const reservation = siren.callCenter.verifyToken(callId, token);
    expect(reservation).not.toBeNull();
    session = siren.callCenter.createSession({
      callId, reservation: reservation!,
      send(data, binary) { if (binary) binaryCount++; else frames.push(JSON.parse(data)); },
      bufferedAmount: () => 0, close: () => undefined,
    });
    expect(session).not.toBeNull();
    session!.handleMessage({ t: 'ready', protocol: 2 });
    session!.handleMessage({ t: 'start' });
    session!.handleBinary(Buffer.alloc(640, 1));
    session!.handleMessage({ t: 'end' });

    if (outcome === 'partial') await waitFor(() => binaryCount > 0);
    else if (outcome === 'complete') await waitFor(() => archiveStarted);
    else await waitFor(() => frames.some(frame => frame.t === 'metrics'));
    session!.destroy('client_closed');
    expect(siren.callCenter.describeCall(callId)?.session_active).toBe(false);
    expect(siren.callCenter.describeCall(callId)?.db_status).toBe('ended');

    if (outcome !== 'empty') {
      await waitFor(() => archiveStarted);
      const pending = await siren.app.inject({ method: 'GET', url: '/v1/calls/' + callId + '/turn-audio' });
      expect(pending.json<{ audio_finalized: boolean }>().audio_finalized).toBe(false);
      expect(pending.json<{ turns: CallTurnAudio[] }>().turns[0]!.reply_audio).toBeNull();
    }
    release();
    await session!.settled();
    const finished = await siren.app.inject({ method: 'GET', url: '/v1/calls/' + callId + '/turn-audio' });
    const snapshot = finished.json<{ audio_finalized: boolean; turns: CallTurnAudio[] }>();
    expect(snapshot.audio_finalized).toBe(true);
    expect(snapshot.turns).toHaveLength(1);
    if (outcome === 'empty') {
      expect(snapshot.turns[0]!.reply_audio).toBeNull();
    } else {
      expect(snapshot.turns[0]!.reply_audio!.completeness).toBe(outcome);
      const audio = await siren.app.inject({ method: 'GET', url: '/v1/voice-assets/' + snapshot.turns[0]!.reply_audio!.asset_id + '/audio' });
      expect(audio.statusCode).toBe(200);
      expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    }
  } finally {
    release();
    session?.destroy('test_cleanup');
    await siren.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
