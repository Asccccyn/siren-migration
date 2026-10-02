/**
 * 全闭环复现：真实客户端上行逻辑（UtteranceUplink/VAD/pre-roll/framer）
 * + 真实 CallSession 状态机 + 真实火山 ASR + 可控 Core。
 * 重放：turn1 正常 → turn2 thinking 中客户开口（本地 barge-in: abort+start）→ turn3 是否变聋。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreBridge } from '@siren/core-bridge';
import { MockTtsProvider } from '@siren/provider-mock';
import { VolcStreamAsrProvider } from '../packages/providers/volc-asr/src/stream.ts';
import { VadMachine, type VadParams } from '../apps/web/src/vad.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';
import { loadConfig } from '../packages/voice-core/src/config.ts';
import { buildSessionHarness } from '../tests/helpers.ts';

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}

const pcm = readFileSync('/tmp/speech16k.pcm');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 160; // 10ms @16k float 块

function pcmBlock(index: number): Float32Array {
  const out = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const off = index * BLOCK * 2 + i * 2;
    if (off + 1 >= pcm.length) break;
    out[i] = pcm.readInt16LE(off) / 32768;
  }
  return out;
}
function silence(): Float32Array {
  return new Float32Array(BLOCK);
}

class ControllableCore implements CoreBridge {
  name = 'controllable';
  private resolveReply: ((text: string) => void) | null = null;
  ask(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveReply = resolve;
    });
  }
  async *streamReply(): AsyncGenerator<{ text: string }> {
    const text = await this.ask();
    for (const seg of text.match(/[^。！？]+[。！？]?/g) ?? [text]) {
      yield { text: seg };
    }
  }
  release(text: string): void {
    this.resolveReply?.(text);
    this.resolveReply = null;
  }
  cancel(): Promise<void> {
    this.resolveReply = null;
    return Promise.resolve();
  }
}

async function main() {
  const config = loadConfig(process.env);
  const asr = new VolcStreamAsrProvider({
    appId: config.volc.appId,
    accessToken: config.volc.accessToken,
    apiKey: config.volc.apiKey || undefined,
    resourceId: config.volc.asrCluster,
    wsUrl: config.volc.asrWsUrl,
    sampleRate: 16000,
    connectTimeoutMs: 5000
  } as never, undefined);
  const core = new ControllableCore();
  const harness = buildSessionHarness({ asr: asr as never, tts: new MockTtsProvider(), core: core as never, config });

  let serverState = 'listening';
  let clientLog: string[] = [];
  const uplink = new UtteranceUplink({
    vad: new VadMachine((): VadParams => ({
      confirmMs: 240, minSpeechMs: 100, endSilenceMs: 480, rmsRatio: 3
    })),
    preRoll: new AudioPreRollBuffer(16000 * 0.5),
    framer: new Pcm16Framer(320),
    sendJson: (message) => {
      harness.session.handleMessage(message as never);
      clientLog.push(`client->${JSON.stringify(message)}`);
    },
    sendFrame: (frame) => harness.session.handleBinary(Buffer.from(frame)),
    isAiActive: () => serverState === 'thinking' || serverState === 'speaking',
    isAiSpeaking: () => serverState === 'speaking',
    onLocalBargeIn: () => clientLog.push('client->(local barge-in stopAll)'),
    log: (msg) => clientLog.push(`client-log: ${msg}`)
  });

  // 服务端下行 -> 客户端状态机
  const pumpServerMessages = () => {
    for (const msg of harness.texts()) {
      if (msg.t === 'state' && typeof msg.state === 'string' && msg.state !== serverState) {
        serverState = msg.state;
        uplink.onServerState(serverState);
      }
    }
  };
  const speak = async (seconds: number, fromSec: number) => {
    const startBlk = Math.floor(fromSec * 100);
    for (let b = 0; b < seconds * 100; b++) {
      pumpServerMessages();
      uplink.handleSamples(pcmBlock(startBlk + b));
      await sleep(10);
    }
  };
  const quiet = async (seconds: number) => {
    for (let b = 0; b < seconds * 100; b++) {
      pumpServerMessages();
      uplink.handleSamples(silence());
      await sleep(10);
    }
  };

  process.stdout.write('阶段0: 1.2s 静音（VAD 噪声基线）\n');
  await quiet(1.2);

  process.stdout.write('turn1: 说 2.4s\n');
  await speak(2.4, 0);
  await quiet(1.2); // VAD end -> end
  await sleep(1200); // 等 final/thinking
  core.release('在呢，你说。'); // thinking 快速放行
  await sleep(800); // speaking + 回 listening
  pumpServerMessages();
  process.stdout.write(`  turn1 后 serverState=${serverState} asr=${JSON.stringify(harness.texts().filter(m => m.t === 'asr').map(m => m.text))}\n`);

  process.stdout.write('turn2: 说 2s，thinking 保持不放行\n');
  await speak(2.4, 0);
  await quiet(1.2);
  for (let i = 0; i < 300 && serverState !== 'thinking'; i++) {
    pumpServerMessages();
    await sleep(20);
  }
  process.stdout.write(`  turn2 thinking? serverState=${serverState}\n`);
  if (serverState !== 'thinking') {
    process.stdout.write('  !! 未进入 thinking。客户端日志:\n' + clientLog.map(l => '    ' + l).join('\n') + '\n  服务端 texts:\n' + JSON.stringify(harness.texts().slice(-8)) + '\n');
    harness.session.destroy('invalid');
    process.exit(2);
  }

  process.stdout.write('turn3: 思考中直接开口 5s（触发客户端 barge-in abort+start）\n');
  await speak(2.4, 0);
  await quiet(1.2);
  await sleep(2500);
  pumpServerMessages();
  const asrTexts = harness.texts().filter((m) => m.t === 'asr').map((m) => m.text);
  const partialCount = harness.texts().filter((m) => m.t === 'partial').length;
  const notices = harness.texts().filter((m) => m.t === 'notice');
  process.stdout.write(`  最终 transcripts=${JSON.stringify(asrTexts)} partials=${partialCount} notices=${notices.length}\n`);
  process.stdout.write(`  客户端关键日志:\n${clientLog.filter(l => l.includes('barge') || l.includes('start') || l.includes('end') || l.includes('speaking')).slice(-10).map(l => '    ' + l).join('\n')}\n`);

  harness.session.destroy('repro-done');
  const lastAsr = asrTexts.at(-1) ?? '';
  process.stdout.write(/乖|Siren|语音|看看/.test(lastAsr) ? '\n>>> 未复现：打断轮正常\n' : '\n>>> 复现：打断轮变聋\n');
}

void main();
