/**
 * 复现脚本（会话层）：真实火山 ASR + 可控 mock Core/TTS，重放通话故障序列。
 * 核心场景：turn1 正常完成（thinking→speaking→listening）→ turn2 进 thinking
 * → 3ms 内 abort+start turn3 → turn3 是否拿到转写。
 * 用法：pnpm exec tsx scripts/repro-session-abort.mts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreBridge } from '@siren/core-bridge';
import { MockTtsProvider } from '@siren/provider-mock';
import { VolcStreamAsrProvider } from '../packages/providers/volc-asr/src/stream.ts';
import { loadConfig } from '../packages/voice-core/src/config.ts';
import { buildSessionHarness, type SessionHarness } from '../tests/helpers.ts';

// .env 盲载
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}

const pcm = readFileSync('/tmp/speech16k.pcm');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可控 Core：回复时机由测试掌握 */
class ControllableCore implements CoreBridge {
  name = 'controllable';
  private resolveReply: ((text: string) => void) | null = null;
  ask(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveReply = resolve;
    });
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

async function feedAudio(harness: SessionHarness, seconds: number, from = 0): Promise<void> {
  const bytes = Math.floor(seconds * 32000 / 640) * 640;
  for (let off = from; off < from + bytes && off < pcm.length; off += 640) {
    harness.session.handleBinary(pcm.subarray(off, off + 640));
    await sleep(20); // 实时节奏：640B = 20ms @16k
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
  const texts = harness.texts;

  process.stdout.write('turn1: start + 3s 语音 + end\n');
  harness.session.handleMessage({ t: 'start' });
  await feedAudio(harness, 3, 0);
  harness.session.handleMessage({ t: 'end' });
  await sleep(1500); // 等 final + thinking
  core.release('在呢，你说。');
  await sleep(500);
  const states1 = texts().filter((m) => m.t === 'state').map((m) => m.state);
  process.stdout.write(`  turn1 states: ${states1.join(' -> ')}\n`);
  const asr1 = texts().filter((m) => m.t === 'asr').map((m) => m.text);
  process.stdout.write(`  turn1 transcript: ${JSON.stringify(asr1)}\n`);

  process.stdout.write('turn2: start + 2s 语音 + end（thinking 中按住不回复）\n');
  harness.session.handleMessage({ t: 'start' });
  await feedAudio(harness, 2, 100000);
  harness.session.handleMessage({ t: 'end' });
  await sleep(800); // 进 thinking
  const states2 = texts().filter((m) => m.t === 'state').map((m) => m.state);
  process.stdout.write(`  turn2 states(至此刻): ${states2.slice(-3).join(' -> ')}\n`);
  const asr2 = texts().filter((m) => m.t === 'asr').map((m) => m.text);
  process.stdout.write(`  turn2 transcript: ${JSON.stringify(asr2)}\n`);

  process.stdout.write('turn3: 3ms 内 abort + start（复现客户端 barge-in 时序）+ 5s 语音 + end\n');
  harness.session.handleMessage({ t: 'abort' });
  harness.session.handleMessage({ t: 'start' });
  await feedAudio(harness, 5, 200000);
  harness.session.handleMessage({ t: 'end' });
  await sleep(1500);
  const asr3 = texts().filter((m) => m.t === 'asr').map((m) => m.text);
  const notices = texts().filter((m) => m.t === 'notice');
  const partials3 = texts().filter((m) => m.t === 'partial').length;
  process.stdout.write(`  turn3 partials=${partials3} transcript=${JSON.stringify(asr3)} notices=${JSON.stringify(notices)}\n`);

  harness.session.destroy('repro-done');
  process.stdout.write(partials3 === 0 && asr3.length === 0 ? '\n>>> 复现：turn3 变聋\n' : '\n>>> 未复现：turn3 正常\n');
}

void main();
