/**
 * Realtime Call Test（规范第 16/17/21/43/44 节）。
 * 本文件只做接线与协议处理；DSP 与调度逻辑在独立模块：
 * - vad.ts            RMS + 自适应噪声基线
 * - pcm-player.ts     下行连续时间轴播放（jitter buffer）
 * - uplink-encoder.ts 上行重采样 16k + PCM16 分帧
 */
export {};

import { VadMachine, type VadParams } from './vad.ts';
import { JitteredPcmPlayer } from './pcm-player.ts';
import { Float32Resampler, Pcm16Framer } from './uplink-encoder.ts';
import { ui, setBadge, logEvent, renderMetrics } from './ui.ts';
import { setupCapture as setupCaptureModule, type CapturePipeline } from './capture-worklet.ts';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('siren_token') ?? '';
  return token ? { authorization: `Bearer ${token}` } : {};
}

// --- 运行态 ---
let ws: WebSocket | null = null;
let capture: CapturePipeline | null = null;
let player: JitteredPcmPlayer | null = null;
let resampler: Float32Resampler | null = null;
let framer: Pcm16Framer | null = null;
let vad: VadMachine | null = null;
let muted = false;
let sendingActive = false;
let pcmRate = 24000;

function vadParams(): VadParams {
  return {
    confirmMs: Number(ui.vConfirm.value) || 200,
    minSpeechMs: Number(ui.vMin.value) || 400,
    endSilenceMs: Number(ui.vEnd.value) || 700,
    rmsRatio: Number(ui.vRatio.value) || 4
  };
}

function jitterBufferMs(): number {
  return Number(ui.vJitter.value) || 350;
}

function sendJson(message: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** conversation_id 唯一来源：输入框；为空时生成一次并回填，同一网页会话内保持同一 conversation */
function ensureConversationId(): string {
  const existing = (ui.conversationId.value || '').trim();
  if (existing) return existing;
  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  ui.conversationId.value = generated;
  return generated;
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

// 采集样本 -> 重采样 -> VAD 判定 -> PCM16 帧上行
function handleCapturedSamples(samples: Float32Array): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !resampler || !framer) return;
  const targetSamples = resampler.push(samples);

  if (ui.modeSelect.value === 'vad' && !muted && vad) {
    const outcome = vad.process(targetSamples);
    ui.noiseFloor.textContent = `noise floor: ${vad.noiseFloorValue.toFixed(5)} / thr: ${vad.threshold.toFixed(5)} / rms: ${vad.lastRmsValue.toFixed(5)}`;
    if (outcome.event === 'start' && !sendingActive) startUtterance();
    if (outcome.event === 'end') {
      if (outcome.spokenMs < vadParams().minSpeechMs) {
        logEvent(`VAD: 语音过短(${Math.round(outcome.spokenMs)}ms)，仍发送 end 由服务端裁决`);
      }
      if (sendingActive) endUtterance();
    }
  }
  if (muted || (ui.modeSelect.value === 'vad' && !sendingActive)) return;
  for (const frame of framer.push(targetSamples)) {
    ws.send(frame);
  }
}

// ---------------------------------------------------------------------------
// 通话控制
// ---------------------------------------------------------------------------

ui.callBtn.addEventListener('click', async () => {
  ui.callBtn.disabled = true;
  setBadge('connecting');
  try {
    const response = await fetch('/v1/calls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        // 电话必须绑定网页当前 conversation（P0-4.5）；未填则本地生成并回填输入框
        conversation_id: ensureConversationId()
      })
    });
    if (!response.ok) throw new Error(`创建通话失败 HTTP ${response.status}`);
    const payload = (await response.json()) as { call_id: string; ws_url: string; token: string };
    await connectSocket(payload.ws_url, payload.token);
    ui.muteBtn.disabled = false;
    ui.hangupBtn.disabled = false;
  } catch (error) {
    setBadge('error');
    logEvent(`呼叫失败：${(error as Error).message}`);
    ui.callBtn.disabled = false;
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
    } else if (player) {
      player.feed(event.data as ArrayBuffer, pcmRate);
    }
  };
  ws.onclose = (event) => {
    logEvent(`WebSocket 关闭 code=${event.code}`);
    teardown();
    setBadge('ended');
    ui.callBtn.disabled = false;
  };
  ws.onerror = () => {
    logEvent('WebSocket 错误');
  };
}

async function setupCapture(): Promise<void> {
  capture = await setupCaptureModule((samples) => handleCapturedSamples(samples));
  player = new JitteredPcmPlayer(capture.context, jitterBufferMs);
  resampler = new Float32Resampler(capture.sampleRate, 16000);
  framer = new Pcm16Framer(320); // 20ms @16k
  vad = new VadMachine(vadParams);
  logEvent(`采集就绪 rate=${capture.sampleRate}`);
}

function handleServerMessage(message: Record<string, unknown>): void {
  const type = message.t as string;
  switch (type) {
    case 'partial':
      ui.partial.textContent = String(message.text ?? '');
      break;
    case 'asr':
      ui.asrLog.textContent = `${message.text}\n${ui.asrLog.textContent ?? ''}`;
      ui.partial.textContent = '';
      logEvent('ASR final');
      break;
    case 'state':
      setBadge(String(message.state ?? ''));
      break;
    case 'reply':
      ui.reply.textContent = String(message.text ?? '');
      break;
    case 'pcm':
      pcmRate = Number(message.rate ?? 24000);
      player?.resetTimeline(); // 新一轮 PCM 时间轴
      break;
    case 'pcm_end':
      logEvent('PCM 结束');
      break;
    case 'interrupted':
      player?.stopAll();
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


ui.muteBtn.addEventListener('click', () => {
  muted = !muted;
  ui.muteBtn.textContent = muted ? '🎙 Unmute' : '🔇 Mute';
  logEvent(muted ? '已静音（停止上行）' : '取消静音');
});

ui.hangupBtn.addEventListener('click', () => {
  ws?.close(1000, 'hangup');
});

// Push to talk
ui.modeSelect.addEventListener('change', () => {
  const ptt = ui.modeSelect.value === 'ptt';
  ui.pttBtn.style.display = ptt ? '' : 'none';
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
ui.pttBtn.addEventListener('mousedown', startPtt);
ui.pttBtn.addEventListener('mouseup', endPtt);
ui.pttBtn.addEventListener('mouseleave', endPtt);
ui.pttBtn.addEventListener('touchstart', (event) => {
  event.preventDefault();
  startPtt();
});
ui.pttBtn.addEventListener('touchend', (event) => {
  event.preventDefault();
  endPtt();
});

// Barge-in：说话时点击状态徽章强制打断
ui.stateBadge.addEventListener('click', () => {
  if (ui.stateBadge.textContent === 'speaking' || ui.stateBadge.textContent === 'thinking') {
    sendJson({ t: 'abort' });
    player?.stopAll();
    logEvent('手动 barge-in → abort');
  }
});

function teardown(): void {
  sendingActive = false;
  vad?.reset();
  player?.stopAll();
  player = null;
  resampler = null;
  framer = null;
  capture?.worklet.disconnect();
  void capture?.context.close().catch(() => undefined);
  capture = null;
  ui.muteBtn.disabled = true;
  ui.hangupBtn.disabled = true;
}

// 定时 ping 保活
window.setInterval(() => sendJson({ t: 'ping' }), 25000);
