/**
 * Async Voice Test（规范第 44 节）。
 * 录音（MediaRecorder WebM/Opus）→ POST /v1/voice/transcribe → transcript；
 * 文字 → POST /v1/voice/synthesize → 播放。
 */
import { getStoredToken, requireToken } from './login-gate.ts';

requireToken();

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ---------------------------------------------------------------------------
// 录音 + ASR
// ---------------------------------------------------------------------------

const startRecBtn = el<HTMLButtonElement>('startRec');
const stopRecBtn = el<HTMLButtonElement>('stopRec');
const recTime = el<HTMLSpanElement>('recTime');
const asrOut = el<HTMLPreElement>('asrOut');

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let timer: number | null = null;
let startedAt = 0;

startRecBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined;
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      void uploadRecording(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }));
    };
    recorder.start(250);
    startedAt = Date.now();
    startRecBtn.disabled = true;
    stopRecBtn.disabled = false;
    timer = window.setInterval(() => {
      recTime.textContent = `● ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    }, 200);
  } catch (error) {
    asrOut.textContent = `无法访问麦克风：${(error as Error).message}`;
  }
});

stopRecBtn.addEventListener('click', () => {
  recorder?.stop();
  if (timer !== null) window.clearInterval(timer);
  startRecBtn.disabled = false;
  stopRecBtn.disabled = true;
});

async function uploadRecording(blob: Blob): Promise<void> {
  asrOut.textContent = '转写中…';
  const form = new FormData();
  form.append('audio', blob, 'recording.webm');
  form.append('format', 'webm');
  const conversation = (el<HTMLInputElement>('asrConv').value || '').trim();
  if (conversation) form.append('conversation_id', conversation);
  if (el<HTMLInputElement>('asrStore').checked) form.append('store', 'true');
  try {
    const response = await fetch('/v1/voice/transcribe', {
      method: 'POST',
      headers: authHeaders(),
      body: form
    });
    const payload = await response.json();
    asrOut.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    asrOut.textContent = `转写失败：${(error as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

const speakBtn = el<HTMLButtonElement>('speakBtn');
const ttsText = el<HTMLTextAreaElement>('ttsText');
const emotionSelect = el<HTMLSelectElement>('emotion');
const speedInput = el<HTMLInputElement>('speed');
const speedVal = el<HTMLSpanElement>('speedVal');
const player = el<HTMLAudioElement>('player');
const ttsMeta = el<HTMLDivElement>('ttsMeta');

speedInput.addEventListener('input', () => {
  speedVal.textContent = Number(speedInput.value).toFixed(2);
});

speakBtn.addEventListener('click', async () => {
  const text = ttsText.value.trim();
  if (!text) return;
  speakBtn.disabled = true;
  ttsMeta.textContent = '合成中…';
  try {
    const response = await fetch('/v1/voice/synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        text,
        emotion: emotionSelect.value,
        speed: Number(speedInput.value),
        format: 'mp3'
      })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error((payload as { message?: string }).message ?? `HTTP ${response.status}`);
    }
    const durationMs = response.headers.get('x-siren-duration-ms') ?? '?';
    const format = response.headers.get('x-siren-format') ?? '?';
    const blob = await response.blob();
    player.src = URL.createObjectURL(blob);
    await player.play();
    ttsMeta.textContent = `format=${format} duration=${durationMs}ms bytes=${blob.size}`;
  } catch (error) {
    ttsMeta.textContent = `合成失败：${(error as Error).message}`;
  } finally {
    speakBtn.disabled = false;
  }
});
