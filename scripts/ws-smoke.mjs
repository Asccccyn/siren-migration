/**
 * 实时链路冒烟：对一个运行中的 Siren 实例发起真实 WebSocket 通话（Mock Provider 下可用）。
 * 用法：node scripts/ws-smoke.mjs [baseUrl]
 */
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://127.0.0.1:8790';

const createRes = await fetch(`${base}/v1/calls`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ conversation_id: 'ws-smoke' })
});
if (!createRes.ok) throw new Error(`create call failed: ${createRes.status}`);
const { call_id: callId, token } = await createRes.json();

const wsBase = base.replace(/^http/, 'ws');
const socket = new WebSocket(`${wsBase}/ws/call/${callId}?token=${token}&conversation_id=ws-smoke`);
socket.binaryType = 'nodebuffer';

let binaryBytes = 0;
const seen = [];

socket.on('message', (data, isBinary) => {
  if (isBinary) {
    binaryBytes += data.length;
    return;
  }
  const message = JSON.parse(String(data));
  seen.push(message);
  if (message.t === 'state' || message.t === 'asr' || message.t === 'pcm_end' || message.t === 'interrupted') {
    console.log(`[${message.t}]`, JSON.stringify(message).slice(0, 160));
  }
});

socket.on('open', () => {
  socket.send(JSON.stringify({ t: 'ready' }));
  socket.send(JSON.stringify({ t: 'start' }));
  // 模拟 ~1s 的 16kHz PCM 语音
  const chunk = Buffer.alloc(3200);
  const timer = setInterval(() => socket.send(chunk), 60);
  setTimeout(() => {
    clearInterval(timer);
    socket.send(JSON.stringify({ t: 'end' }));
  }, 1000);
});

const done = new Promise((resolve) => {
  const check = setInterval(() => {
    const finished = seen.some((m) => m.t === 'pcm_end');
    const backToListening = seen.some((m) => m.t === 'state' && m.state === 'listening' && finished);
    if (backToListening) {
      clearInterval(check);
      resolve();
    }
  }, 100);
});

try {
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('smoke timeout')), 20000))
  ]);
} finally {
  socket.close(1000, 'smoke-done');
}

const reply = seen.find((m) => m.t === 'reply');
const metrics = seen.find((m) => m.t === 'metrics');
console.log('--- smoke result ---');
console.log(JSON.stringify({ reply_text: reply?.text ?? null, metrics: metrics?.metrics ?? null, pcm_bytes_down: binaryBytes }, null, 2));
process.exit(0);
