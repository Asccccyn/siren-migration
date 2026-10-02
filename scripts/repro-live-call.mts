/**
 * 公网实弹复现：完整客户端逻辑（VAD/uplink）经真实 WS 连公网 siren（真实 codex 大脑）。
 * 场景：turn1 正常对话 → turn2 进 thinking（真实 9~11s）→ 思考中开口（barge-in）→ turn3 是否变聋。
 * 消耗 1~2 轮 codex 额度。用法：pnpm exec tsx scripts/repro-live-call.mts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { VadMachine, type VadParams } from '../apps/web/src/vad.ts';
import { AudioPreRollBuffer } from '../apps/web/src/pre-roll-buffer.ts';
import { Pcm16Framer } from '../apps/web/src/uplink-encoder.ts';
import { UtteranceUplink } from '../apps/web/src/utterance-uplink.ts';

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}
const TOKEN = process.env.SIREN_INTERNAL_TOKEN ?? '';
const BASE = process.env.SIREN_PUBLIC_URL ?? 'https://siren.example.invalid';
const pcm = readFileSync('/tmp/speech16k.pcm');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BLOCK = 160;

function pcmBlock(index: number): Float32Array {
  const out = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const off = index * BLOCK * 2 + i * 2;
    if (off + 1 >= pcm.length) break;
    out[i] = pcm.readInt16LE(off) / 32768;
  }
  return out;
}

async function main() {
  const createRes = await fetch(`${BASE}/v1/calls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: `repro-${Date.now()}` })
  });
  const created = (await createRes.json()) as { call_id: string; ws_url: string; token: string };
  let wsUrl = created.ws_url;
  if (wsUrl.startsWith('/')) wsUrl = `${BASE}${wsUrl}`;
  wsUrl = wsUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  if (!wsUrl.includes('token=')) wsUrl = `${wsUrl}?token=${encodeURIComponent(created.token)}`;
  process.stdout.write(`call created: ${created.call_id} ws=${created.ws_url.split('?')[0]}\n`);

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  process.stdout.write('ws connected\n');

  let serverState = 'listening';
  const asrTexts: string[] = [];
  const notices: unknown[] = [];
  let pcmBytes = 0;
  ws.on('close', (code, reason) => process.stdout.write(`  [ws close] ${code} ${reason}\n`));
  ws.on('error', (err) => process.stdout.write(`  [ws error] ${err.message}\n`));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { pcmBytes += (data as Buffer).length; return; }
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg.t === 'state') {
      const prev = serverState;
      serverState = String(msg.state);
      if (prev !== serverState) process.stdout.write(`  [state] ${prev} -> ${serverState}\n`);
    } else if (msg.t === 'asr') {
      asrTexts.push(String(msg.text));
      process.stdout.write(`  [asr] ${msg.text}\n`);
    } else if (msg.t === 'notice') {
      notices.push(msg);
      process.stdout.write(`  [notice] ${JSON.stringify(msg)}\n`);
    } else if (msg.t === 'reply') {
      process.stdout.write(`  [reply] ${msg.text}\n`);
    }
  });

  const uplink = new UtteranceUplink({
    vad: new VadMachine((): VadParams => ({ confirmMs: 240, minSpeechMs: 100, endSilenceMs: 480, rmsRatio: 3 })),
    preRoll: new AudioPreRollBuffer(16000 * 0.5),
    framer: new Pcm16Framer(320),
    sendJson: (message) => ws.send(JSON.stringify(message)),
    sendFrame: (frame) => ws.send(Buffer.from(frame), { binary: true }),
    isAiActive: () => serverState === 'thinking' || serverState === 'speaking',
    isAiSpeaking: () => serverState === 'speaking',
    log: (message) => process.stdout.write(`  [client] ${message}\n`)
  });
  ws.send(JSON.stringify({ t: 'ready', protocol: 1, capabilities: { playback_drain: false, stream_identity: true, local_barge_in: true } }));

  const speak = async (seconds: number) => {
    for (let b = 0; b < seconds * 100; b++) {
      uplink.handleSamples(pcmBlock(b));
      await sleep(10);
    }
  };
  const quiet = async (seconds: number) => {
    const s = new Float32Array(BLOCK);
    for (let b = 0; b < seconds * 100; b++) {
      uplink.handleSamples(s);
      await sleep(10);
    }
  };

  await quiet(1.5);
  process.stdout.write('turn1: 说 2.4s（真实 codex，等完整回合）\n');
  await speak(2.4);
  await quiet(1.5);
  // 等 thinking + speaking + 回 listening（真实链路最长 ~20s）
  for (let i = 0; i < 400 && serverState !== 'listening'; i++) await sleep(100);
  await sleep(500);

  process.stdout.write('turn2: 说 2.4s，进 thinking 后立刻再开口（barge-in）\n');
  await speak(2.4);
  await quiet(1.5);
  for (let i = 0; i < 300 && serverState !== 'thinking'; i++) await sleep(100);
  if (serverState !== 'thinking') {
    process.stdout.write(`!! 未进入 thinking（${serverState}），场景无效\n`);
  } else {
    process.stdout.write('thinking 保持中，立即开口 turn3\n');
    await speak(2.4); // 期间触发本地 barge-in：abort + start
    await quiet(1.5);
    // 等 turn3 收尾（含 end() 限时兜底）
    for (let i = 0; i < 350 && serverState !== 'listening'; i++) await sleep(100);
    await sleep(1500);
  }

  process.stdout.write(`\n结果: asr=${JSON.stringify(asrTexts)} notices=${notices.length} 下行pcm=${Math.round(pcmBytes / 32000)}s\n`);
  const lastAsr = asrTexts.at(-1) ?? '';
  process.stdout.write(lastAsr.length > 0 && asrTexts.length >= 3 ? '>>> turn3 有转写（未复现）\n' : '>>> turn3 无转写（复现！）\n');
  ws.close();
  process.exit(0);
}

void main();
