import { describe, expect, it } from 'vitest';
import { parseClientWsMessage, type StreamAsrProvider, type TtsProvider } from '@siren/contracts';
import type { CoreBridge } from '@siren/core-bridge';
import { CallSession, CascadeRealtimeProvider, FillerManager } from '@siren/voice-core';
import { VoiceTurnCoordinator } from '../apps/web/src/voice-turn-coordinator.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';
import { StreamRouter } from '../apps/web/src/stream-router.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';
import { VadMachine } from '../apps/web/src/vad.ts';
import { TEST_PROFILE, silentLogger, testConfig } from './helpers.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('voice interruption through the real client and server logic', () => {
  it('hands off human speech during thinking/speaking, then manual→voice, with asynchronous ACK and late old frames', async () => {
    // No socket, microphone, database or real provider. Only transport/playback
    // scheduling and provider outputs are controlled; the protocol owners are real.
    const uplinkWire: (Record<string, unknown> | ArrayBuffer)[] = [];
    const downlinkWire: (Record<string, unknown> | Buffer)[] = [];
    const commands: Record<string, unknown>[] = [];
    const accepted: Record<string, unknown>[] = [];
    const playedStreams: string[] = [];
    const failures: string[] = [];
    const playbackOrder: string[] = [];
    const receivedAudio: Buffer[][] = [];
    const firstAudio = gate();
    const secondTail = gate();
    const thirdTail = gate();
    let syntheses = 0;
    let clockMs = 1;
    let state = 'idle';
    const asr: StreamAsrProvider = {
      async createStream(_options, handlers) {
        const index = receivedAudio.length;
        receivedAudio.push([]);
        return {
          feed(frame) {
            receivedAudio[index].push(Buffer.from(frame));
            handlers.onPartial?.(`partial ${index + 1}`);
          },
          async end() {
            return { text: receivedAudio[index].length ? `recognized ${index + 1}` : '', language: 'en', durationMs: 160 };
          },
          abort() {}
        };
      }
    };
    const core: CoreBridge = {
      async *streamReply() { yield { text: '受控回复。' }; },
      async cancel() {}
    };
    const tts: TtsProvider = {
      synthesize: () => Promise.reject(new Error('unexpected batch fallback')),
      async *synthesizeStream() {
        const index = ++syntheses;
        // Ignore cancellation deliberately: the session must fence late upstream
        // data even while the previous producer has not finished cleaning up.
        if (index === 1) await firstAudio.promise;
        yield { audio: Buffer.alloc(960, index), sampleRate: 24000 };
        if (index === 2) await secondTail.promise;
        if (index === 3) await thirdTail.promise;
      }
    };
    const server = new CallSession({
      config: testConfig({ PLAYBACK_DRAIN_TIMEOUT_MS: '500' }), logger: silentLogger,
      callId: 'full-client-flow', conversationId: 'same-core-conversation', profile: TEST_PROFILE,
      voice: new CascadeRealtimeProvider({ name: 'controlled', asr, tts }), core,
      fillers: new FillerManager('/unused', false, silentLogger),
      send(data, binary) { downlinkWire.push(binary ? Buffer.from(binary) : JSON.parse(data)); },
      bufferedAmount: () => 0, close() {}
    });
    const sendJson = (message: Record<string, unknown>) => {
      commands.push(message);
      uplinkWire.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
    };
    const turns = new VoiceTurnCoordinator({
      idPrefix: 'flow', sendJson,
      sendFrame(frame) { uplinkWire.push(frame.slice(0)); },
      invalidateOutput() {
        playbackOrder.push(`invalidate:${turns.inputId}`);
        const stream = router.activeStream;
        router.invalidateActive();
        playbackOrder.push(`stop:${turns.inputId}`);
        return stream ? { stream_id: stream, played_ms: 20 } : undefined;
      },
      onFailure(reason) { failures.push(reason); }
    });
    const router: StreamRouter = new StreamRouter({
      onChunk(_buffer, header) { playedStreams.push(header.stream_id); },
      onStreamStart() {},
      onStreamEnd(stream) { router.notifyStreamIdle(stream); },
      onDrained(stream) { sendJson({ t: 'playback_drained', stream_id: stream }); },
      onDropped() {}
    });
    const uplink = new UtteranceUplink({
      vad: new VadMachine(() => ({ confirmMs: 20, minSpeechMs: 40, endSilenceMs: 40, rmsRatio: 4 }), () => clockMs),
      preRoll: new AudioPreRollBuffer(6400), framer: new Pcm16Framer(320), sendJson,
      sendFrame: (frame) => turns.sendFrame(frame),
      isAiActive: () => state === 'thinking' || state === 'speaking',
      canInterrupt: () => turns.supported,
      startInput: () => turns.begin(),
      finishInput: (valid) => turns.finish(valid)
    });
    async function pump() {
      // Do not deliver ACK recursively inside begin(). PCM stays queued until
      // this independent downlink pass accepts input_started.
      for (const packet of uplinkWire.splice(0)) {
        if (packet instanceof ArrayBuffer) server.handleBinary(Buffer.from(packet));
        else {
          const parsed = parseClientWsMessage(packet);
          expect(parsed).not.toBeNull();
          server.handleMessage(parsed!);
        }
      }
      await Promise.resolve();
      for (const packet of downlinkWire.splice(0)) {
        if (Buffer.isBuffer(packet)) { router.handleBinary(Uint8Array.from(packet).buffer); continue; }
        if (!turns.accept(packet)) {
          if (packet.t === 'pcm') router.discardPendingBinary();
          continue;
        }
        accepted.push(packet);
        if (packet.t === 'ready') turns.negotiate((packet.capabilities as { voice_interrupt?: boolean } | undefined)?.voice_interrupt === true);
        else if (packet.t === 'state') { state = String(packet.state); uplink.onServerState(state); }
        router.handleJson(packet);
      }
      await Promise.resolve();
    }
    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 1500;
      do {
        await pump();
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      } while (Date.now() < deadline);
      throw new Error('in-process client/server handoff timed out');
    }
    function speak() {
      for (let block = 0; block < 6; block++) {
        clockMs += 20;
        uplink.handleSamples(new Float32Array(320).fill(0.15));
      }
      for (let block = 0; block < 3; block++) {
        clockMs += 20;
        uplink.handleSamples(new Float32Array(320));
      }
    }
    try {
      sendJson({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true, playback_drain: true, stream_identity: true } });
      await until(() => turns.supported);
      speak();
      expect(receivedAudio).toHaveLength(0); // No PCM bypassed the pending ACK.
      await until(() => state === 'thinking' && syntheses === 1);
      expect(receivedAudio[0].length).toBeGreaterThan(0);

      // Human samples, not a direct coordinator.begin/interrupt call.
      speak();
      expect(commands.at(-1)).toMatchObject({ t: 'interrupt', target_input_id: 'flow_1', new_input_id: 'flow_2' });
      expect(receivedAudio).toHaveLength(1);
      const boundary = accepted.length;
      downlinkWire.push({ t: 'state', state: 'speaking', input_id: 'flow_1' });
      downlinkWire.push({ t: 'pcm', input_id: 'flow_1', stream_id: 'late-unseen-first-stream', sequence: 0, rate: 24000, bytes: 960 });
      downlinkWire.push(Buffer.alloc(960));
      await until(() => state === 'speaking' && syntheses === 2);
      firstAudio.release();
      await pump();
      expect(accepted.slice(boundary).some((frame) => frame.input_id === 'flow_1')).toBe(false);
      expect(playedStreams).not.toContain('late-unseen-first-stream');
      expect(accepted.some((frame) => frame.t === 'asr' && frame.text === 'recognized 2' && frame.input_id === 'flow_2')).toBe(true);

      speak();
      expect(commands.at(-1)).toMatchObject({ t: 'interrupt', target_input_id: 'flow_2', new_input_id: 'flow_3' });
      await until(() => state === 'speaking' && syntheses === 3);
      secondTail.release();
      expect(accepted.some((frame) => frame.t === 'asr' && frame.text === 'recognized 3')).toBe(true);

      turns.abort(); // Same public operation used by the manual badge.
      await until(() => state === 'listening');
      thirdTail.release();
      speak();
      expect(commands.at(-1)).toMatchObject({ t: 'interrupt', target_input_id: 'flow_3', new_input_id: 'flow_4' });
      await until(() => accepted.some((frame) => frame.t === 'metrics' && frame.input_id === 'flow_4'));
      expect(accepted.filter((frame) => frame.t === 'asr').map((frame) => frame.text)).toEqual(['recognized 1', 'recognized 2', 'recognized 3', 'recognized 4']);
      expect(receivedAudio).toHaveLength(4);
      expect(receivedAudio.every((chunks) => chunks.reduce((total, frame) => total + frame.length, 0) > 0)).toBe(true);
      expect(commands.filter((message) => message.t === 'interrupt')).toHaveLength(3);
      expect(failures).toEqual([]);
      for (let i = 0; i < playbackOrder.length; i += 2) {
        expect(playbackOrder[i].startsWith('invalidate:')).toBe(true);
        expect(playbackOrder[i + 1]).toBe(playbackOrder[i].replace('invalidate:', 'stop:'));
      }
    } finally {
      firstAudio.release(); secondTail.release(); thirdTail.release();
      turns.reset(); uplink.reset(); router.reset(); server.destroy('test-cleanup');
    }
  });
});
