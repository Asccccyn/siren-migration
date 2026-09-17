/** P1-1：RealtimeVoiceProvider 边界（cascade 组合）+ P1-7 ready 音频契约 */
import { describe, expect, it } from 'vitest';
import { CascadeRealtimeProvider } from '@siren/voice-core';
import { MockAsrProvider, MockTtsProvider } from '@siren/provider-mock';
import { buildSessionHarness } from './helpers.ts';

describe('CascadeRealtimeProvider（P1-1 Provider 边界）', () => {
  it('组合 StreamAsr + Tts，显式声明采样率契约', async () => {
    const asr = new MockAsrProvider({ partials: ['你'], final: '你好。', finalDelayMs: 5 });
    const tts = new MockTtsProvider();
    const cascade = new CascadeRealtimeProvider({ name: 'cascade(mock)', asr, tts });

    expect(cascade.name).toBe('cascade(mock)');
    expect(cascade.inputSampleRate).toBe(16000);
    expect(cascade.outputSampleRate).toBe(24000);
    expect(cascade.tts).toBe(tts);

    // ASR 会话经边界创建（partial/final 可用）
    const partials: string[] = [];
    const stream = await cascade.createStream({}, { onPartial: (t) => partials.push(t) });
    stream.feed(Buffer.alloc(640, 1));
    const result = await stream.end();
    expect(result.text).toBe('你好。');
    expect(partials.length).toBeGreaterThan(0);

    // 自定义采样率契约生效
    const custom = new CascadeRealtimeProvider({
      name: 'cascade(48k)',
      asr,
      tts,
      inputSampleRate: 48000,
      outputSampleRate: 48000
    });
    expect(custom.inputSampleRate).toBe(48000);
    expect(custom.outputSampleRate).toBe(48000);
  });

  it('ready 帧音频契约取自 provider 边界的采样率（P1-7/P0-7）', async () => {
    const harness = buildSessionHarness({});
    harness.session.handleMessage({
      t: 'ready',
      protocol: 2,
      capabilities: { playback_drain: true, stream_identity: true, local_barge_in: true }
    });
    const ready = harness.texts().find((m) => m.t === 'ready');
    expect(ready).toMatchObject({
      protocol: 2,
      audio: { input_rate: 16000, output_rate: 24000, format: 'pcm16' }
    });
    // ready 后仍然回当前 state
    expect(harness.texts().some((m) => m.t === 'state' && m.state === 'idle')).toBe(true);
  });
});
