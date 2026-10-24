// 协议②（2026-10-24）：通话用户原声资产化 + audioRef 上桥——离线合同。
// ① 喂 PCM→end→reply：voice_assets 落 user 方向资产（WAV、transcript=采纳转写）；
// ② CoreTurnInput.audioRef='siren:<asset_id>' 随桥上送 est；
// ③ 未装配 userAudio / 无 PCM：audioRef 缺省（纯文本轮），通话不受影响。
import { describe, expect, it } from 'vitest';
import { openDatabase, VoiceAssetsRepository } from '@siren/storage';
import { buildSessionHarness, waitFor } from './helpers.ts';
import type { CoreTurnInput } from '@siren/core-bridge';
import type { CallSession } from '@siren/voice-core';

function pcmChunk(samples = 3200): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  return buf;
}

function makeUserAudio() {
  const db = openDatabase(':memory:');
  const assetsRepo = new VoiceAssetsRepository(db);
  const putKeys: Array<{ key: string; bytes: number; contentType: string }> = [];
  const store = {
    put: async (key: string, bytes: Buffer, contentType: string) => {
      putKeys.push({ key, bytes: bytes.length, contentType });
    }
  };
  return { db, assetsRepo, store, putKeys };
}

describe('通话用户原声资产化（协议②离线合同）', () => {
  it('喂 PCM→采纳→落 WAV 资产，CoreTurnInput 带 siren: audioRef', async () => {
    const ua = makeUserAudio();
    const inputs: CoreTurnInput[] = [];
    const h = buildSessionHarness({
      userAudio: { assetsRepo: ua.assetsRepo, store: ua.store },
      core: {
        streamReply: async function* (input: CoreTurnInput) {
          inputs.push(input);
          yield { text: '合成回复。' };
        },
        cancel: async () => undefined
      } as never
    });
    try {
      h.session.handleMessage({ t: 'start' });
      h.session.handleBinary(pcmChunk());
      h.session.handleBinary(pcmChunk());
      h.session.handleMessage({ t: 'end' });
      await waitFor(() => inputs.length >= 1);
      await waitFor(() => h.texts().some((x) => x.t === 'reply'));
      // ① 资产落库：user 方向、wav、transcript=采纳文本
      const asset = ua.assetsRepo.findByMessageId('call-call-test-1-t1');
      expect(asset).toBeTruthy();
      expect(asset!.direction).toBe('user');
      expect(asset!.audioFormat).toBe('wav');
      expect(asset!.transcript).toBe('你好。');
      expect(asset!.durationMs).toBeGreaterThan(0);
      // ② 对象存储：WAV 头+两片 PCM
      expect(ua.putKeys.length).toBe(1);
      expect(ua.putKeys[0]!.contentType).toBe('audio/wav');
      expect(ua.putKeys[0]!.bytes).toBe(44 + pcmChunk().length * 2);
      // ③ 上桥引用
      expect(inputs[0]!.audioRef).toBe(`siren:${asset!.id}`);
      expect(inputs[0]!.text).toBe('你好。');
    } finally {
      h.session.destroy('test');
      ua.db.close();
    }
  });

  it('未装配 userAudio：无资产无 audioRef，通话正常（缺省=纯文本轮）', async () => {
    const inputs: CoreTurnInput[] = [];
    const h = buildSessionHarness({
      core: {
        streamReply: async function* (input: CoreTurnInput) {
          inputs.push(input);
          yield { text: '好。' };
        },
        cancel: async () => undefined
      } as never
    });
    try {
      h.session.handleMessage({ t: 'start' });
      h.session.handleBinary(pcmChunk());
      h.session.handleMessage({ t: 'end' });
      await waitFor(() => inputs.length >= 1);
      expect(inputs[0]!.audioRef).toBeUndefined();
      await waitFor(() => h.texts().some((x) => x.t === 'reply'));
    } finally {
      h.session.destroy('test');
    }
  });
});
