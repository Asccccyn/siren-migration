/**
 * Realtime Call Test（规范第 16/17/21/43/44 节）。
 * - 采集：getUserMedia + AudioWorklet → Float32 → 重采样 16k → PCM16 → WS binary
 * - 播放：WS binary PCM16/24k → Web Audio 连续时间轴（nextAt + 抖动缓冲）
 * - VAD：RMS + 自适应噪声基线；参数可配置
 * - 状态由 Siren WebSocket 下发，前端不自猜
 */
export {};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('siren_token') ?? '';
  return token ? { authorization: `Bearer ${token}` } : {};
}

const stateBadge = el<HTMLSpanElement>('stateBadge');
const partialView = el<HTMLDivElement>('partial');
const asrLog = el<HTMLPreElement>('asrLog');
const replyView = el<HTMLDivElement>('reply');
const metricsBody = el<HTMLTableSectionElement>('metricsBody');
const eventLog = el<HTMLPreElement>('eventLog');
const noiseFloorView = el<HTMLSpanElement>('noiseFloor');

const callBtn = el<HTMLButtonElement>('callBtn');
const muteBtn = el<HTMLButtonElement>('muteBtn');
const hangupBtn = el<HTMLButtonElement>('hangupBtn');
const pttBtn = el<HTMLButtonElement>('pttBtn');
const modeSelect = el<HTMLSelectElement>('mode');

function setBadge(state: string): void {
  stateBadge.textContent = state;
  stateBadge.className = `badge ${state}`;
}

function logEvent(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  eventLog.textContent = `${line}\n${eventLog.textContent ?? ''}`.split('\n').slice(0, 200).join('\n');
}

// --- AudioWorklet：以 Blob URL 内联，避免独立文件 ---
const WORKLET_CODE = `
class SirenCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('siren-capture', SirenCaptureProcessor);
`;

// --- 状态 ---
let ws: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let muted = false;
let nextAt = 0;
let pcmRate = 24000;
const scheduledSources: AudioBufferSourceNode[] = [];

// --- 重采样缓冲（48k → 16k 线性插值） ---
let resampleCarry = 0;
let pendingSamples: Float32Array | null = null;
let inputRate = 48000;

function feedPlaybackChunk(buffer: ArrayBuffer): void {
  if (!audioContext) return;
  const view = new DataView(buffer);
  const sampleCount = Math.floor(view.byteLength / 2);
  if (sampleCount === 0) return;
  const audioBuffer = audioContext.createBuffer(1, sampleCount, pcmRate);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    channel[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  const now = audioContext.currentTime;
  if (nextAt < now) {
    nextAt = now + jitterBufferMs() / 1000; // 首块抖动缓冲
  }
  source.start(nextAt);
  nextAt += audioBuffer.duration;
  scheduledSources.push(source);
  source.onended = () => {
    const index = scheduledSources.indexOf(source);
    if (index >= 0) scheduledSources.splice(index, 1);
  };
}

function stopPlayback(): void {
  for (const source of scheduledSources.splice(0)) {
    try {
      source.stop();
    } catch {
      // 已结束
    }
  }
  nextAt = 0;
}

// --- VAD ---
interface VadParams {
  confirmMs: number;
  minSpeechMs: number;
  endSilenceMs: number;
  rmsRatio: number;
}

function vadParams(): VadParams {
  return {
    confirmMs: Number(el<HTMLInputElement>('vConfirm').value) || 200,
    minSpeechMs: Number(el<HTMLInputElement>('vMin').value) || 400,
    endSilenceMs: Number(el<HTMLInputElement>('vEnd').value) || 700,
    rmsRatio: Number(el<HTMLInputElement>('vRatio').value) || 4
  };
}

function jitterBufferMs(): number {
  return Number(el<HTMLInputElement>('vJitter').value) || 350;
}

let noiseFloor = 0.005;
let speechStartAt = 0;
let utteranceStartAt = 0;
let lastVoiceAt = 0;
let inSpeech = false;
let sendingActive = false;

function processBlock(samples: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rmsValue = Math.sqrt(sum / samples.length);
  const params = vadParams();
  const threshold = noiseFloor * params.rmsRatio;
  const now = performance.now();

  if (!inSpeech) {
    // 静音期自适应噪声基线（规范第 21 节）
    noiseFloor = noiseFloor * 0.98 + rmsValue * 0.02;
    noiseFloorView.textContent = `noise floor: ${noiseFloor.toFixed(5)} / thr: ${threshold.toFixed(5)} / rms: ${rmsValue.toFixed(5)}`;
    if (rmsValue > threshold) {
      if (speechStartAt === 0) speechStartAt = now;
      if (now - speechStartAt >= params.confirmMs) {
        inSpeech = true;
        utteranceStartAt = speechStartAt;
        lastVoiceAt = now;
        if (!sendingActive) startUtterance();
      }
    } else {
      speechStartAt = 0;
    }
  } else {
    if (rmsValue > threshold) {
      lastVoiceAt = now;
    }
    const silenceMs = now - lastVoiceAt;
    const spokenMs = lastVoiceAt - utteranceStartAt;
    if (silenceMs >= params.endSilenceMs) {
      inSpeech = false;
      speechStartAt = 0;
      if (spokenMs < params.minSpeechMs) {
        logEvent(`VAD: 语音过短(${Math.round(spokenMs)}ms)，仍发送 end 由服务端裁决`);
      }
      if (sendingActive) endUtterance();
    }
  }
}

function startUtterance(): void {
  sendingActive = true;
  sendJson({ t: 'start' });
  logEvent('VAD: 说话开始 → start');
}

function endUtterance(): void {
  sendingActive = false;
  sendJson({ t: 'end' });
  logEvent('VAD: 静音断句 → end');
}

// --- PCM 上行 ---
const blockAccumulator: number[] = [];

function handleCapturedSamples(samples: Float32Array): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // 拼接剩余样本
  const merged = pendingSamples
    ? concatFloat32(pendingSamples, samples)
    : samples;
  const ratio = inputRate / 16000;
  const wholeCount = Math.floor(merged.length / ratio);
  pendingSamples = wholeCount > 0 ? merged.subarray(Math.floor(wholeCount * ratio)) : merged;

  const outSamples = new Float32Array(wholeCount);
  for (let i = 0; i < wholeCount; i++) {
    const srcPos = (i + resampleCarry) * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const v0 = merged[i0] ?? 0;
    const v1 = merged[i0 + 1] ?? v0;
    outSamples[i] = v0 * (1 - frac) + v1 * frac;
  }
  resampleCarry = 0;

  // VAD 基于重采样后样本
  if (modeSelect.value === 'vad' && !muted) {
    processBlock(outSamples);
  }
  if (muted || (modeSelect.value === 'vad' && !sendingActive)) return;

  for (let i = 0; i < outSamples.length; i++) {
    blockAccumulator.push(outSamples[i]);
  }
  // 320 samples = 20ms@16k
  while (blockAccumulator.length >= 320) {
    const block = blockAccumulator.splice(0, 320);
    const pcm = new DataView(new ArrayBuffer(640));
    for (let i = 0; i < 320; i++) {
      let s = block[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    }
    ws.send(pcm.buffer);
  }
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function sendJson(message: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ---------------------------------------------------------------------------
// 通话控制
// ---------------------------------------------------------------------------

callBtn.addEventListener('click', async () => {
  callBtn.disabled = true;
  setBadge('connecting');
  try {
    const response = await fetch('/v1/calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        conversation_id: (el<HTMLInputElement>('conversationId').value || '').trim() || undefined
      })
    });
    if (!response.ok) throw new Error(`创建通话失败 HTTP ${response.status}`);
    const payload = (await response.json()) as { call_id: string; ws_url: string; token: string };
    await connectSocket(payload.ws_url, payload.token);
    muteBtn.disabled = false;
    hangupBtn.disabled = false;
  } catch (error) {
    setBadge('error');
    logEvent(`呼叫失败：${(error as Error).message}`);
    callBtn.disabled = false;
  }
});

async function connectSocket(wsUrl: string, token: string): Promise<void> {
  const url = new URL(wsUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  url.searchParams.set('token', token);

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setBadge('idle');
    logEvent('WebSocket 已连接');
    sendJson({ t: 'ready' });
    void setupCapture();
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleServerMessage(JSON.parse(event.data) as Record<string, unknown>);
    } else {
      feedPlaybackChunk(event.data as ArrayBuffer);
    }
  };
  ws.onclose = (event) => {
    logEvent(`WebSocket 关闭 code=${event.code}`);
    teardown();
    setBadge('ended');
    callBtn.disabled = false;
  };
  ws.onerror = () => {
    logEvent('WebSocket 错误');
  };
}

async function setupCapture(): Promise<void> {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  audioContext = new AudioContext();
  inputRate = audioContext.sampleRate;
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  await audioContext.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);
  workletNode = new AudioWorkletNode(audioContext, 'siren-capture');
  workletNode.port.onmessage = (event) => {
    handleCapturedSamples(event.data as Float32Array);
  };
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(workletNode);
  logEvent(`采集就绪 rate=${inputRate}`);
}

function handleServerMessage(message: Record<string, unknown>): void {
  const type = message.t as string;
  switch (type) {
    case 'partial':
      partialView.textContent = String(message.text ?? '');
      break;
    case 'asr':
      asrLog.textContent = `${message.text}\n${asrLog.textContent ?? ''}`;
      partialView.textContent = '';
      logEvent('ASR final');
      break;
    case 'state':
      setBadge(String(message.state ?? ''));
      break;
    case 'reply':
      replyView.textContent = String(message.text ?? '');
      break;
    case 'pcm':
      pcmRate = Number(message.rate ?? 24000);
      if (audioContext) nextAt = 0; // 新一轮 PCM 时间轴
      break;
    case 'pcm_end':
      logEvent('PCM 结束');
      break;
    case 'interrupted':
      stopPlayback();
      logEvent('已被打断（interrupted）');
      break;
    case 'metrics':
      renderMetrics(message.metrics as Record<string, unknown>);
      break;
    case 'error':
      logEvent(`错误 ${message.code}: ${message.message}`);
      break;
    case 'pong':
      break;
    default:
      logEvent(`未知消息 ${type}`);
  }
}

function renderMetrics(metrics: Record<string, unknown> | undefined): void {
  if (!metrics) return;
  const rows: [string, string][] = [
    ['ASR latency', `${metrics.asr_latency_ms ?? '-'} ms`],
    ['LLM TTFT', `${metrics.llm_first_token_ms ?? '-'} ms`],
    ['TTS first audio', `${metrics.tts_first_audio_ms ?? '-'} ms`],
    ['Total first audio', `${metrics.total_first_audio_ms ?? '-'} ms`],
    ['Interrupted', String(metrics.interrupted ?? false)],
    ['Filler', String(metrics.filler_played ?? false)]
  ];
  metricsBody.innerHTML = rows
    .map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`)
    .join('');
}

muteBtn.addEventListener('click', () => {
  muted = !muted;
  muteBtn.textContent = muted ? '🎙 Unmute' : '🔇 Mute';
  logEvent(muted ? '已静音（停止上行）' : '取消静音');
});

hangupBtn.addEventListener('click', () => {
  ws?.close(1000, 'hangup');
});

// Push to talk
modeSelect.addEventListener('change', () => {
  const ptt = modeSelect.value === 'ptt';
  pttBtn.style.display = ptt ? '' : 'none';
  if (!ptt && sendingActive) {
    sendingActive = false;
    sendJson({ t: 'end' });
  }
});

const startPtt = (): void => {
  if (!sendingActive) {
    sendingActive = true;
    sendJson({ t: 'start' });
    logEvent('PTT: start');
  }
};
const endPtt = (): void => {
  if (sendingActive) {
    sendingActive = false;
    sendJson({ t: 'end' });
    logEvent('PTT: end');
  }
};
pttBtn.addEventListener('mousedown', startPtt);
pttBtn.addEventListener('mouseup', endPtt);
pttBtn.addEventListener('mouseleave', endPtt);
pttBtn.addEventListener('touchstart', (event) => {
  event.preventDefault();
  startPtt();
});
pttBtn.addEventListener('touchend', (event) => {
  event.preventDefault();
  endPtt();
});

// Barge-in：说话时点击播放区强制打断
stateBadge.addEventListener('click', () => {
  if (stateBadge.textContent === 'speaking' || stateBadge.textContent === 'thinking') {
    sendJson({ t: 'abort' });
    stopPlayback();
    logEvent('手动 barge-in → abort');
  }
});

function teardown(): void {
  sendingActive = false;
  inSpeech = false;
  speechStartAt = 0;
  stopPlayback();
  workletNode?.disconnect();
  workletNode = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  void audioContext?.close().catch(() => undefined);
  audioContext = null;
  muteBtn.disabled = true;
  hangupBtn.disabled = true;
}

// 定时 ping 保活
window.setInterval(() => sendJson({ t: 'ping' }), 25000);
