import { describe, expect, it } from 'vitest';
import { VoiceTurnCoordinator } from '../apps/web/src/voice-turn-coordinator.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';
import { VadMachine } from '../apps/web/src/vad.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';

describe('independent audit: short-input ACK ownership', () => {
  it('uses the existing finishInput owner, even without a second endInput callback', () => {
    const events: (Record<string, unknown> | string)[] = [];
    const turns = new VoiceTurnCoordinator({ idPrefix: 'audit', sendJson: (m) => events.push(m),
      sendFrame: () => events.push('pcm'), invalidateOutput: () => undefined, onFailure: () => {} });
    turns.negotiate(true);
    let now = 0;
    const uplink = new UtteranceUplink({
      vad: new VadMachine(() => ({ confirmMs: 40, minSpeechMs: 400, endSilenceMs: 60, rmsRatio: 2 }), () => now),
      preRoll: new AudioPreRollBuffer(6400), framer: new Pcm16Framer(320),
      sendJson: (m) => events.push(m), sendFrame: (f) => turns.sendFrame(f), isAiActive: () => false,
      startInput: () => turns.begin(), finishInput: (valid) => turns.finish(valid)
    });
    const tick = (amplitude: number) => { now += 10; uplink.handleSamples(new Float32Array(160).fill(amplitude)); };
    try {
      for (let i = 0; i < 6; i++) tick(0);
      for (let i = 0; i < 26; i++) tick(0.9);
      for (let i = 0; i < 8; i++) tick(0);
      expect(events).toEqual([{ t: 'start', input_id: 'audit_1' }]);
      turns.accept({ t: 'input_started', input_id: 'audit_1' });
      expect(events.at(-1)).toEqual({ t: 'end', input_id: 'audit_1' });
      expect(events.filter((event) => event === 'pcm').length).toBeGreaterThan(0);
    } finally { turns.reset(); uplink.reset(); }
  });
});
