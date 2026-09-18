/**
 * 实时链路冒烟：对一个运行中的 Siren 实例发起真实 WebSocket 通话（Mock Provider 下可用）。
 * 模拟协议 v2 客户端：ready 带能力位，收到 pcm_end 后回 playback_drained。
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
const socket = new WebSocket(`${wsBase}/ws/call/${callId}?token=${token}`);
socket.binaryType = 'nodebuffer';

let binaryBytes = 0;
let pcmEndAt = 0;
let drainAckSentAt = 0;
const seen = [];
const drainedStreams = new Set();

socket.on('message', (data, isBinary) => {
  if (isBinary) {
    binaryBytes += data.length;
    return;
  }
  const message = JSON.parse(String(data));
  seen.push(message);
  if (message.t === 'pcm_end' && !drainedStreams.has(message.stream_id)) {
    // 协议 v2：模拟客户端还在播 300ms 尾音，真正播完才回 ACK
    // （服务端在此期间必须保持 speaking，ACK 后才回 listening）
    pcmEndAt = Date.now();
    drainedStreams.add(message.stream_id);
    setTimeout(() => {
      drainAckSentAt = Date.now();
      socket.send(JSON.stringify({ t: 'playback_drained', stream_id: message.stream_id }));
    }, 300);
  }
  if (message.t === 'ready' || message.t === 'state' || message.t === 'asr' || message.t === 'pcm_end' || message.t === 'interrupted') {
    console.log(`[${message.t}]`, JSON.stringify(message).slice(0, 160));
  }
});

socket.on('open', () => {
  socket.send(
    JSON.stringify({
      t: 'ready',
      protocol: 2,
      capabilities: { playback_drain: true, stream_identity: true, local_barge_in: true }
    })
  );
  socket.send(JSON.stringify({ t: 'start' }));
  // 模拟 ~1s 的 16kHz PCM 语音
  const chunk = Buffer.alloc(3200);
  const timer = setInterval(() => socket.send(chunk), 60);
  setTimeout(() => {
    clearInterval(timer);
    socket.send(JSON.stringify({ t: 'end' }));
  }, 1000);
});

let listeningAt = 0;
const done = new Promise((resolve) => {
  const check = setInterval(() => {
    // 协议 v2：drained ACK 后服务端才回 listening。
    // listening 帧必须出现在 pcm_end 帧【之后】（历史 listening 帧不算）
    const pcmEndIdx = seen.findIndex((m) => m.t === 'pcm_end');
    if (pcmEndIdx < 0) return;
    const listeningAfterEnd = seen.some(
      (m, i) => i > pcmEndIdx && m.t === 'state' && m.state === 'listening'
    );
    if (listeningAfterEnd) {
      clearInterval(check);
      listeningAt = Date.now();
      resolve();
    }
  }, 20);
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
// drain 语义验证：listening 必须晚于 drain ACK（>= 300ms 尾音被等待）
const drainWorked = drainAckSentAt > 0 && listeningAt >= drainAckSentAt && listeningAt - pcmEndAt >= 280;
console.log('--- smoke result ---');
console.log(
  JSON.stringify(
    {
      reply_text: reply?.text ?? null,
      metrics: metrics?.metrics ?? null,
      pcm_bytes_down: binaryBytes,
      drained_acks: [...drainedStreams],
      drain_waited_ms: listeningAt - pcmEndAt,
      drain_controlled_listening: drainWorked
    },
    null,
    2
  )
);
if (!drainWorked) {
  console.error('SMOKE FAIL: server did not wait for playback_drained before listening');
  process.exit(1);
}
process.exit(0);
