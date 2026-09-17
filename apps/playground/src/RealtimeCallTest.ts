/**
 * Realtime Call Test（规范第 16/17/21/43/44 节 / v1.1 协议 v2）。
 * 本文件只做接线与协议处理；DSP 与调度逻辑在独立模块：
 * - vad.ts               RMS + 自适应噪声基线
 * - pcm-player.ts        下行连续时间轴播放（jitter buffer + stream 感知 drain）
 * - stream-router.ts     下行流路由（stream_id / sequence / 旧流丢弃）
 * - utterance-uplink.ts  上行编排（pre-roll flush + 本地 barge-in）
 * - uplink-encoder.ts    上行重采样 16k + PCM16 分帧
 */
export {};

import { VadMachine, type VadParams } from './vad.ts';
import { JitteredPcmPlayer } from './pcm-player.ts';
import { StreamRouter } from './stream-router.ts';
import { UtteranceUplink } from './utterance-uplink.ts';
import { AudioPreRollBuffer } from './pre-roll-buffer.ts';
import { Float32Resampler, Pcm16Framer } from './uplink-encoder.ts';
import { ui, setBadge, logEvent, renderMetrics } from './ui.ts';
import { setupCapture as setupCaptureModule, type CapturePipeline } from './capture-worklet.ts';

const PRE_ROLL_MS = 400; // P0-1：16kHz 下 6400 samples
const PROTOCOL_VERSION = 2;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('siren_token') ?? '';
  return token ? { authorization: `Bearer ${token}` } : {};
}

// --- 运行态 ---
let ws: WebSocket | null = null;
let capture: CapturePipeline | null = null;
let player: JitteredPcmPlayer | null = null;
let router: StreamRouter | null = null;
let uplink: UtteranceUplink | null = null;
let resampler: Float32Resampler | null = null;
let serverState = 'idle';
let serverProtocol = 0;
let muted = false;

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

function sendFrame(frame: ArrayBuffer): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
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
    sendJson({
      t: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: { playback_drain: true, stream_identity: true, local_barge_in: true }
    });
    void setupCapture();
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleServerMessage(JSON.parse(event.data) as Record<string, unknown>);
    } else {
      router?.handleBinary(event.data as ArrayBuffer);
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
  player = new JitteredPcmPlayer(
    capture.context,
    jitterBufferMs,
    (streamId) => router?.notifyStreamIdle(streamId)
  );
  router = new StreamRouter({
    onChunk: (buffer, header) => player?.feed(buffer, header.rate, header.stream_id),
    onStreamStart: (streamId) => {
      player?.stopAll(); // 新流开始：清旧流播放队列
      player?.resetTimeline();
      logEvent(`输出流开始 ${streamId}`);
    },
    onStreamEnd: (streamId) => {
      player?.markStreamEnd(streamId);
      logEvent(`PCM 结束 ${streamId}`);
    },
    onDrained: (streamId) => {
      // P0-4：该流所有 AudioBufferSourceNode 真正播完后才 ACK
      sendJson({ t: 'playback_drained', stream_id: streamId });
      logEvent(`播放完毕 drained ${streamId}`);
    },
    onDropped: (reason, details) => logEvent(`丢弃 chunk：${reason} ${JSON.stringify(details)}`)
  });
  uplink = new UtteranceUplink({
    vad: new VadMachine(vadParams),
    preRoll: new AudioPreRollBuffer((16000 * PRE_ROLL_MS) / 1000),
    framer: new Pcm16Framer(320), // 20ms @16k
    sendJson: (message) => sendJson(message),
    sendFrame: (frame) => sendFrame(frame),
    isAiActive: () => serverState === 'thinking' || serverState === 'speaking',
    onLocalBargeIn: () => player?.stopAll(),
    log: (message) => logEvent(message)
  });
  uplink.setMode(ui.modeSelect.value === 'ptt' ? 'ptt' : 'vad');
  if (muted) uplink.setMuted(true);
  resampler = new Float32Resampler(capture.sampleRate, 16000);
  logEvent(`采集就绪 rate=${capture.sampleRate} pre-roll=${PRE_ROLL_MS}ms`);
}

// 采集样本 -> 重采样 16k -> uplink（pre-roll / VAD / barge-in / 分帧上行）
function handleCapturedSamples(samples: Float32Array): void {
  if (!resampler || !uplink) return;
  const targetSamples = resampler.push(samples);
  if (targetSamples.length === 0) return;
  if (ui.modeSelect.value === 'vad') {
    ui.noiseFloor.textContent = uplink.vadStatus;
  }
  uplink.handleSamples(targetSamples);
}

function handleServerMessage(message: Record<string, unknown>): void {
  // 下行流相关帧先交给 router（pcm / pcm_end / interrupted）
  if (router?.handleJson(message)) {
    if (message.t === 'interrupted') {
      const streamId = typeof message.stream_id === 'string' ? message.stream_id : null;
      player?.cancelStream(streamId);
      logEvent(`已被打断（interrupted ${streamId ?? ''}）`);
    }
    return;
  }
  const type = message.t as string;
  switch (type) {
    case 'ready':
      serverProtocol = Number(message.protocol ?? 0);
      logEvent(`协议协商 v${serverProtocol}`);
      break;
    case 'partial':
      ui.partial.textContent = String(message.text ?? '');
      break;
    case 'asr':
      ui.asrLog.textContent = `${message.text}\n${ui.asrLog.textContent ?? ''}`;
      ui.partial.textContent = '';
      logEvent('ASR final');
      break;
    case 'state':
      serverState = String(message.state ?? '');
      setBadge(serverState);
      uplink?.onServerState(serverState);
      break;
    case 'reply':
      ui.reply.textContent = String(message.text ?? '');
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
  uplink?.setMuted(muted);
  logEvent(muted ? '已静音（停止上行）' : '取消静音');
});

ui.hangupBtn.addEventListener('click', () => {
  ws?.close(1000, 'hangup');
});

// Push to talk
ui.modeSelect.addEventListener('change', () => {
  const ptt = ui.modeSelect.value === 'ptt';
  ui.pttBtn.style.display = ptt ? '' : 'none';
  uplink?.setMode(ptt ? 'ptt' : 'vad');
});

ui.pttBtn.addEventListener('mousedown', () => uplink?.startPtt());
ui.pttBtn.addEventListener('mouseup', () => uplink?.endPtt());
ui.pttBtn.addEventListener('mouseleave', () => uplink?.endPtt());
ui.pttBtn.addEventListener('touchstart', (event) => {
  event.preventDefault();
  uplink?.startPtt();
});
ui.pttBtn.addEventListener('touchend', (event) => {
  event.preventDefault();
  uplink?.endPtt();
});

// Barge-in：说话时点击状态徽章强制打断（手动兜底；VAD 本地打断见 utterance-uplink）
ui.stateBadge.addEventListener('click', () => {
  if (serverState === 'speaking' || serverState === 'thinking') {
    player?.stopAll();
    sendJson({ t: 'abort' });
    logEvent('手动 barge-in → abort');
  }
});

function teardown(): void {
  uplink?.reset();
  router?.reset();
  player?.stopAll();
  player = null;
  router = null;
  uplink = null;
  resampler = null;
  capture?.worklet.disconnect();
  void capture?.context.close().catch(() => undefined);
  capture = null;
  serverState = 'idle';
  ui.muteBtn.disabled = true;
  ui.hangupBtn.disabled = true;
}

// 定时 ping 保活
window.setInterval(() => sendJson({ t: 'ping' }), 25000);
