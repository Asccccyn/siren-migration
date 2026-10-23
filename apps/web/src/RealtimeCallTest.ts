/**
 * Realtime Call Test（规范第 16/17/21/43/44 节 / v1.1 协议 v2）。
 * 本文件只做接线与协议处理；DSP 与调度逻辑在独立模块：
 * - vad.ts               RMS + 自适应噪声基线
 * - pcm-player.ts        下行连续时间轴播放（jitter buffer + stream 感知 drain）
 * - stream-router.ts     下行流路由（stream_id / sequence / 旧流丢弃）
 * - utterance-uplink.ts  上行编排（pre-roll + 关联语音打断）
 * - uplink-encoder.ts    上行重采样 16k + PCM16 分帧
 */
export {};

import { VadMachine, type VadParams } from './vad.ts';
import { JitteredPcmPlayer } from './pcm-player.ts';
import { StreamRouter } from './stream-router.ts';
import { UtteranceUplink } from './utterance-uplink.ts';
import { AudioPreRollBuffer } from './pre-roll-buffer.ts';
import { Float32Resampler, Pcm16Framer } from './uplink-encoder.ts';
import { getStoredToken, requireToken } from './login-gate.ts';
import { ui, setBadge, logEvent, renderMetrics } from './ui.ts';
import { setupCapture as setupCaptureModule, type CapturePipeline } from './capture-worklet.ts';
import { VoiceTurnCoordinator } from './voice-turn-coordinator.ts';
import { PlaybackEchoGuard } from './playback-echo-guard.ts';

requireToken();

const PRE_ROLL_MS = 400; // P0-1：16kHz 下 6400 samples
const PROTOCOL_VERSION = 2;
/** C09：采集设备丢失关闭码——镜像 @siren/contracts WS_CLOSE_CODES.DEVICE_LOST(4007)。
 * 客户端 bundle 不依赖 contracts 包，本地常量与协议文档同步维护。 */
const CLOSE_DEVICE_LOST = 4007;

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

// --- 运行态 ---
let ws: WebSocket | null = null;
let capture: CapturePipeline | null = null;
let pendingAudioContext: AudioContext | null = null;
let captureRequested = false;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let callRequest: AbortController | null = null;
let player: JitteredPcmPlayer | null = null;
let router: StreamRouter | null = null;
let uplink: UtteranceUplink | null = null;
let resampler: Float32Resampler | null = null;
let referenceResampler: Float32Resampler | null = null;
let turns: VoiceTurnCoordinator | null = null;
const echoGuard = new PlaybackEchoGuard();
/** F18：通话代数——挂断后迟到的 getUserMedia 结果直接释放，不复活已 teardown 的采集 */
let captureGeneration = 0;
let serverState = 'idle';
let serverProtocol = 0;
let muted = false;
/** C09：本轮通话是否因采集设备丢失结束（badge 区分 device_lost 与 ended；新呼叫复位） */
let deviceLost = false;
// S1011-015：服务端 ready 帧下发的 VAD/jitter 建议作为基线；UI 输入仍可覆盖
let serverVadDefaults: VadParams | null = null;
let serverJitterMs: number | null = null;

function setting(value: unknown, fallback: number): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function applyServerTuning(message: Record<string, unknown>): void {
  const vad = message.vad as Record<string, number> | undefined;
  if (vad) {
    serverVadDefaults = {
      confirmMs: setting(vad.confirm_ms, 200),
      minSpeechMs: setting(vad.min_speech_ms, 400),
      endSilenceMs: setting(vad.end_silence_ms, 700),
      rmsRatio: setting(vad.rms_ratio, 4)
    };
    // UI 输入框显示基线值（用户改过则以输入为准）
    if (!ui.vConfirm.dataset.touched) ui.vConfirm.value = String(serverVadDefaults.confirmMs);
    if (!ui.vMin.dataset.touched) ui.vMin.value = String(serverVadDefaults.minSpeechMs);
    if (!ui.vEnd.dataset.touched) ui.vEnd.value = String(serverVadDefaults.endSilenceMs);
    if (!ui.vRatio.dataset.touched) ui.vRatio.value = String(serverVadDefaults.rmsRatio);
  }
  if (typeof message.jitter_ms === 'number') {
    serverJitterMs = message.jitter_ms;
    if (!ui.vJitter.dataset.touched) ui.vJitter.value = String(serverJitterMs);
  }
}

function vadParams(): VadParams {
  const base = serverVadDefaults ?? { confirmMs: 200, minSpeechMs: 400, endSilenceMs: 700, rmsRatio: 4 };
  return {
    confirmMs: setting(ui.vConfirm.value, base.confirmMs),
    minSpeechMs: setting(ui.vMin.value, base.minSpeechMs),
    endSilenceMs: setting(ui.vEnd.value, base.endSilenceMs),
    rmsRatio: setting(ui.vRatio.value, base.rmsRatio)
  };
}

function jitterBufferMs(): number {
  return Math.min(2000, Math.max(0, setting(ui.vJitter.value, serverJitterMs ?? 350)));
}

for (const input of [ui.vConfirm, ui.vMin, ui.vEnd, ui.vRatio, ui.vJitter]) {
  input.addEventListener('input', () => {
    input.dataset.touched = '1';
  });
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
  const generation = ++captureGeneration;
  deviceLost = false; // C09：新呼叫从明确的非设备丢失状态开始
  ui.callBtn.disabled = true;
  ui.hangupBtn.disabled = false;
  const request = new AbortController();
  callRequest = request;
  setBadge('connecting');
  try {
    // Resume during the user gesture, before fetch/WS/permission awaits. Safari
    // may otherwise leave a context created in onopen suspended indefinitely.
    pendingAudioContext = new AudioContext();
    const context = pendingAudioContext;
    await context.resume();
    if (generation !== captureGeneration) { void context.close().catch(() => undefined); return; }
    const response = await fetch('/v1/calls', {
      method: 'POST',
      signal: request.signal,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        // 电话必须绑定网页当前 conversation（P0-4.5）；未填则本地生成并回填输入框
        conversation_id: ensureConversationId()
      })
    });
    if (!response.ok) throw new Error(`创建通话失败 HTTP ${response.status}`);
    const payload = (await response.json()) as { call_id: string; ws_url: string; token: string };
    if (generation !== captureGeneration) { void context.close().catch(() => undefined); return; }
    if (callRequest === request) callRequest = null;
    await connectSocket(payload.ws_url, payload.token);
    ui.muteBtn.disabled = false;
    ui.hangupBtn.disabled = false;
  } catch (error) {
    if (generation !== captureGeneration) return;
    teardown();
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

  const socket = new WebSocket(url);
  ws = socket;
  socket.binaryType = 'arraybuffer';
  turns = new VoiceTurnCoordinator({
    sendJson,
    sendFrame,
    invalidateOutput: () => {
      const streamId = router?.activeStream;
      const playback = streamId ? { stream_id: streamId, played_ms: player?.playedMs(streamId) ?? 0 } : undefined;
      router?.invalidateActive();
      player?.stopAll();
      return playback;
    },
    onFailure: (reason) => {
      logEvent(`输入交接失败：${reason}，请重新呼叫`);
      uplink?.reset();
      ws?.close(4004, 'input handoff failed');
    }
  });

  socket.onopen = () => {
    if (ws !== socket) return;
    setBadge('idle');
    logEvent('WebSocket 已连接');
    sendJson({
      t: 'ready',
      protocol: PROTOCOL_VERSION,
      capabilities: { playback_drain: true, stream_identity: true, voice_interrupt: true }
    });
    readyTimer = setTimeout(() => {
      if (ws === socket) socket.close(4004, 'capability negotiation timeout');
    }, 5000);
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    if (typeof event.data === 'string') {
      handleServerMessage(JSON.parse(event.data) as Record<string, unknown>);
    } else {
      router?.handleBinary(event.data as ArrayBuffer);
    }
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    logEvent(`WebSocket 关闭 code=${event.code}`);
    teardown();
    // C09：设备丢失的通话结束展示显式 device_lost，与正常/用户挂断的 ended 区分
    setBadge(deviceLost ? 'device_lost' : 'ended');
    ui.callBtn.disabled = false;
  };
  socket.onerror = () => {
    if (ws !== socket) return;
    logEvent('WebSocket 错误');
  };
}

async function setupCapture(): Promise<void> {
  const generation = captureGeneration;
  const prepared = pendingAudioContext ?? undefined;
  const pipeline = await setupCaptureModule((samples, reference) => {
    if (generation === captureGeneration) handleCapturedSamples(samples, reference);
  }, prepared, () => {
    // C09：采集设备丢失（蓝牙耳机拔出等 track ended / devicechange）——
    // 旧行为：流静默死亡，通话卡死无任何状态。新行为：置显式 device_lost 状态，
    // 复用统一 teardown 清理（不新建第二套），WS 关闭码与用户主动挂断（1000/hangup）区分。
    if (generation !== captureGeneration) return; // 旧通话的迟到回调不误伤新通话
    deviceLost = true;
    logEvent('麦克风设备丢失（track ended/devicechange），通话结束');
    const socket = ws;
    teardown();
    socket?.close(CLOSE_DEVICE_LOST, 'capture device lost');
    setBadge('device_lost');
    ui.callBtn.disabled = false;
  });
  if (generation !== captureGeneration) {
    // F18：挂断/换通话发生在授权等待期间——迟到的采集立即释放
    await pipeline.dispose().catch(() => undefined);
    return;
  }
  if (pendingAudioContext === prepared) pendingAudioContext = null;
  capture = pipeline;
  player = new JitteredPcmPlayer(
    capture.context,
    jitterBufferMs,
    (streamId) => router?.notifyStreamIdle(streamId),
    capture.playbackInput
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
    sendFrame: (frame) => turns?.sendFrame(frame),
    startInput: () => turns?.begin(),
    finishInput: (valid) => turns?.finish(valid),
    canInterrupt: () => turns?.supported ?? false,
    isAiActive: hasResponse,
    log: (message) => logEvent(message)
  });
  uplink.setMode(ui.modeSelect.value === 'ptt' ? 'ptt' : 'vad');
  if (muted) uplink.setMuted(true);
  resampler = new Float32Resampler(capture.sampleRate, 16000);
  referenceResampler = new Float32Resampler(capture.sampleRate, 16000);
  echoGuard.reset();
  logEvent(`采集就绪 rate=${capture.sampleRate} pre-roll=${PRE_ROLL_MS}ms`);
  if (capture.echoCancellation === false) {
    logEvent('设备未启用系统回声消除，建议使用耳机或按住说话');
  }
}

// 采集样本 -> 重采样 16k -> uplink（pre-roll / VAD / 回声参考 / 分帧上行）
function handleCapturedSamples(samples: Float32Array, reference: Float32Array): void {
  if (!resampler || !referenceResampler || !uplink) return;
  const targetSamples = resampler.push(samples);
  const rendered = referenceResampler.push(reference);
  if (targetSamples.length === 0) return;
  const nearEnd = echoGuard.process(targetSamples, rendered);
  if (ui.modeSelect.value === 'vad') {
    ui.noiseFloor.textContent = uplink.vadStatus;
  }
  uplink.handleSamples(targetSamples, nearEnd);
}

function handleServerMessage(message: Record<string, unknown>): void {
  // Apply input identity before touching the stream router or any UI state.
  if (turns && !turns.accept(message)) {
    if (message.t === 'pcm') router?.discardPendingBinary();
    return;
  }
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
      clearTimeout(readyTimer);
      readyTimer = undefined;
      serverProtocol = Number(message.protocol ?? 0);
      turns?.negotiate((message.capabilities as { voice_interrupt?: boolean } | undefined)?.voice_interrupt === true);
      applyServerTuning(message);
      ui.voiceModeStatus.textContent = turns?.supported ? '开口可打断' : '服务端仅支持手动打断';
      logEvent(`协议协商 v${serverProtocol}，client=1012-interrupt`);
      // Do not capture/send before negotiation; a fast permission grant could
      // otherwise send legacy start into a server already requiring input_id.
      if (!captureRequested && ws) {
        captureRequested = true;
        const socket = ws;
        void setupCapture().catch((error: Error) => {
          if (ws !== socket) return;
          logEvent(`无法启动麦克风：${error.message}`);
          socket.close(4004, 'capture unavailable');
        });
      }
      break;
    case 'input_started':
      serverState = 'listening';
      setBadge(serverState);
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
    case 'notice':
      logEvent(String(message.message ?? ''));
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
  const socket = ws;
  teardown();
  socket?.close(1000, 'hangup');
  setBadge('ended');
  ui.callBtn.disabled = false;
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

function hasResponse(): boolean {
  return ['ending', 'thinking', 'speaking'].includes(serverState) || (player?.scheduledCount ?? 0) > 0;
}

// Manual and voice interruption share identity invalidation and cancellation.
ui.stateBadge.addEventListener('click', () => {
  if (hasResponse()) {
    turns?.abort();
    uplink?.reset();
    logEvent('手动 barge-in → abort');
  }
});

function teardown(): void {
  captureGeneration++;
  callRequest?.abort();
  callRequest = null;
  clearTimeout(readyTimer);
  readyTimer = undefined;
  captureRequested = false;
  ws = null;
  uplink?.reset();
  turns?.reset();
  router?.reset();
  player?.stopAll();
  player = null;
  router = null;
  uplink = null;
  turns = null;
  resampler = null;
  referenceResampler = null;
  echoGuard.reset();
  // F18：统一 dispose——停止全部麦克风轨道（track.stop），不只断 worklet
  void capture?.dispose().catch(() => undefined);
  capture = null;
  void pendingAudioContext?.close().catch(() => undefined);
  pendingAudioContext = null;
  serverState = 'idle';
  ui.voiceModeStatus.textContent = '未连接';
  ui.muteBtn.disabled = true;
  ui.hangupBtn.disabled = true;
}

// 定时 ping 保活
window.setInterval(() => sendJson({ t: 'ping' }), 25000);
