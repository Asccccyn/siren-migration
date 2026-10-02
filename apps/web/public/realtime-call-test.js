"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/vad.ts
  var INITIAL_NOISE_FLOOR = 5e-3;
  var NOISE_TAU_MS = 2e3;
  var VadMachine = class {
    constructor(getParams, now = () => performance.now()) {
      this.getParams = getParams;
      this.now = now;
      __publicField(this, "noiseFloor", INITIAL_NOISE_FLOOR);
      __publicField(this, "speechStartAt", 0);
      __publicField(this, "utteranceStartAt", 0);
      __publicField(this, "lastVoiceAt", 0);
      __publicField(this, "inSpeech", false);
      __publicField(this, "lastRms", 0);
      __publicField(this, "lastNoiseUpdateAt", 0);
    }
    get threshold() {
      return this.noiseFloor * this.getParams().rmsRatio;
    }
    get noiseFloorValue() {
      return this.noiseFloor;
    }
    get lastRmsValue() {
      return this.lastRms;
    }
    get isSpeaking() {
      return this.inSpeech;
    }
    process(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rmsValue = Math.sqrt(sum / samples.length);
      this.lastRms = rmsValue;
      const params = this.getParams();
      const threshold = this.noiseFloor * params.rmsRatio;
      const now = this.now();
      if (!this.inSpeech) {
        if (rmsValue > threshold) {
          if (this.speechStartAt === 0) this.speechStartAt = now;
          if (now - this.speechStartAt >= params.confirmMs) {
            this.inSpeech = true;
            this.utteranceStartAt = this.speechStartAt;
            this.lastVoiceAt = now;
            return { event: "start" };
          }
        } else {
          this.speechStartAt = 0;
          const dt = this.lastNoiseUpdateAt === 0 ? 0 : Math.max(0, now - this.lastNoiseUpdateAt);
          this.lastNoiseUpdateAt = now;
          const alpha = dt > 0 ? 1 - Math.exp(-dt / NOISE_TAU_MS) : 0;
          this.noiseFloor = this.noiseFloor * (1 - alpha) + rmsValue * alpha;
        }
        return { event: "none" };
      }
      if (rmsValue > threshold) {
        this.lastVoiceAt = now;
      }
      const silenceMs = now - this.lastVoiceAt;
      const spokenMs = this.lastVoiceAt - this.utteranceStartAt;
      if (silenceMs >= params.endSilenceMs) {
        this.inSpeech = false;
        this.speechStartAt = 0;
        return { event: "end", spokenMs };
      }
      return { event: "none" };
    }
    reset() {
      this.noiseFloor = INITIAL_NOISE_FLOOR;
      this.speechStartAt = 0;
      this.utteranceStartAt = 0;
      this.lastVoiceAt = 0;
      this.inSpeech = false;
      this.lastNoiseUpdateAt = 0;
    }
  };

  // src/pcm-player.ts
  var JitteredPcmPlayer = class {
    constructor(ctx, getJitterMs, onStreamIdle) {
      this.ctx = ctx;
      this.getJitterMs = getJitterMs;
      this.onStreamIdle = onStreamIdle;
      __publicField(this, "nextAt", 0);
      __publicField(this, "streams", /* @__PURE__ */ new Map());
      __publicField(this, "order", []);
    }
    /** 喂入一帧 PCM16 little-endian 二进制（属于 streamId 流，rate 为该 chunk 真实采样率） */
    feed(buffer, rate, streamId) {
      const view = new DataView(buffer);
      const sampleCount = Math.floor(view.byteLength / 2);
      if (sampleCount === 0) return;
      const state = this.stateOf(streamId);
      if (state.cancelled) return;
      const audioBuffer = this.ctx.createBuffer(1, sampleCount, rate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        channel[i] = view.getInt16(i * 2, true) / 32768;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      if (this.nextAt < now) {
        this.nextAt = now + this.getJitterMs() / 1e3;
      }
      source.start(this.nextAt);
      this.nextAt += audioBuffer.duration;
      state.sources.add(source);
      source.onended = () => {
        state.sources.delete(source);
        this.maybeIdle(streamId, state);
      };
    }
    /** 新一轮 PCM 流：重置时间轴（StreamRouter 判定新流时调用） */
    resetTimeline() {
      this.nextAt = 0;
    }
    /** 服务端宣告流结束（pcm_end）：sources 已排空则立即 idle */
    markStreamEnd(streamId) {
      const state = this.streams.get(streamId);
      if (!state || state.cancelled) return;
      state.ended = true;
      this.maybeIdle(streamId, state);
    }
    /** 该流被打断：立即停播且不再期待 drained */
    cancelStream(streamId) {
      const targets = streamId ? [streamId] : [...this.streams.keys()];
      for (const id of targets) {
        const state = this.streams.get(id);
        if (!state) continue;
        state.cancelled = true;
        state.ended = false;
        this.stopSources(state);
      }
      this.nextAt = 0;
    }
    /** 立即停止全部已调度音频（interrupted / hangup 时调用） */
    stopAll() {
      this.cancelStream(null);
    }
    get scheduledCount() {
      let total = 0;
      for (const state of this.streams.values()) total += state.sources.size;
      return total;
    }
    stateOf(streamId) {
      let state = this.streams.get(streamId);
      if (!state) {
        state = { sources: /* @__PURE__ */ new Set(), ended: false, cancelled: false, drainedNotified: false };
        this.streams.set(streamId, state);
        this.order.push(streamId);
        if (this.order.length > 8) {
          const evict = this.order.shift();
          if (evict) this.streams.delete(evict);
        }
      }
      return state;
    }
    /** end 已收到且该流全部节点播完 -> 通知 router（drained 判定在 router） */
    maybeIdle(streamId, state) {
      if (state.cancelled || state.drainedNotified) return;
      if (!state.ended || state.sources.size > 0) return;
      state.drainedNotified = true;
      this.onStreamIdle?.(streamId);
    }
    stopSources(state) {
      for (const source of [...state.sources]) {
        try {
          source.stop();
        } catch {
        }
      }
      state.sources.clear();
    }
  };

  // src/stream-router.ts
  var StreamRouter = class {
    constructor(deps) {
      this.deps = deps;
      __publicField(this, "activeStreamId", null);
      __publicField(this, "pendingHeader", null);
      __publicField(this, "lastSequence", /* @__PURE__ */ new Map());
      /** 曾出现过的流 id：用于区分「新流」与「旧流迟到」 */
      __publicField(this, "seenStreams", /* @__PURE__ */ new Set());
      __publicField(this, "endedStreams", /* @__PURE__ */ new Set());
      /** 播放器已确认播空（尚未收到 end）的流 */
      __publicField(this, "idleStreams", /* @__PURE__ */ new Set());
      __publicField(this, "cancelledStreams", /* @__PURE__ */ new Set());
      __publicField(this, "drainedStreams", /* @__PURE__ */ new Set());
    }
    get activeStream() {
      return this.activeStreamId;
    }
    /** 服务端文本帧中与下行流相关的部分；返回是否被本路由消费 */
    handleJson(message) {
      switch (message.t) {
        case "pcm":
          this.acceptHeader({
            stream_id: String(message.stream_id ?? ""),
            sequence: Number(message.sequence ?? 0),
            rate: Number(message.rate ?? 24e3),
            bytes: Number(message.bytes ?? 0)
          });
          return true;
        case "pcm_end":
          this.endStream(String(message.stream_id ?? ""));
          return true;
        case "interrupted":
          this.cancelStream(typeof message.stream_id === "string" ? message.stream_id : void 0);
          return true;
        default:
          return false;
      }
    }
    /** 二进制帧：必须紧随其 header，且属于当前活跃流 */
    handleBinary(buffer) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      if (!header) {
        this.deps.onDropped("binary_without_header", { bytes: buffer.byteLength });
        return;
      }
      if (this.cancelledStreams.has(header.stream_id)) {
        this.deps.onDropped("cancelled_stream_chunk", { stream_id: header.stream_id, sequence: header.sequence });
        return;
      }
      if (header.stream_id !== this.activeStreamId) {
        this.deps.onDropped("stale_stream_chunk", { stream_id: header.stream_id, sequence: header.sequence });
        return;
      }
      if (buffer.byteLength !== header.bytes) {
        this.deps.onDropped("bytes_mismatch", {
          stream_id: header.stream_id,
          expected: header.bytes,
          actual: buffer.byteLength
        });
        return;
      }
      const last = this.lastSequence.get(header.stream_id);
      if (last !== void 0) {
        if (header.sequence <= last) {
          this.deps.onDropped("duplicate_or_stale_sequence", {
            stream_id: header.stream_id,
            sequence: header.sequence,
            last
          });
          return;
        }
        if (header.sequence > last + 1) {
          this.deps.onDropped("sequence_gap_continue", {
            stream_id: header.stream_id,
            expected: last + 1,
            got: header.sequence
          });
        }
      }
      this.lastSequence.set(header.stream_id, header.sequence);
      this.idleStreams.delete(header.stream_id);
      this.deps.onChunk(buffer, header);
    }
    /** 播放器通知：某流已无待播节点；若 end 已收到则判 drained */
    notifyStreamIdle(streamId) {
      if (this.canDrain(streamId)) {
        this.markDrained(streamId);
        return;
      }
      this.idleStreams.add(streamId);
    }
    /** 连接关闭等场景：取消所有 drain 期待 */
    reset() {
      this.pendingHeader = null;
      this.seenStreams.clear();
      this.endedStreams.clear();
      this.idleStreams.clear();
      this.cancelledStreams.clear();
      this.drainedStreams.clear();
      this.lastSequence.clear();
      this.activeStreamId = null;
    }
    acceptHeader(header) {
      if (!header.stream_id) {
        this.deps.onDropped("header_missing_stream_id", { header });
        return;
      }
      if (this.pendingHeader) {
        this.deps.onDropped("header_overwritten", { previous: this.pendingHeader });
      }
      if (this.cancelledStreams.has(header.stream_id)) {
        this.pendingHeader = header;
        return;
      }
      if (header.stream_id !== this.activeStreamId) {
        if (this.seenStreams.has(header.stream_id)) {
          this.deps.onDropped("stale_stream_header", { stream_id: header.stream_id });
          this.pendingHeader = header;
          return;
        }
        this.seenStreams.add(header.stream_id);
        this.deps.onStreamStart(header.stream_id, header.rate);
        this.activeStreamId = header.stream_id;
      }
      this.pendingHeader = header;
    }
    endStream(streamId) {
      if (streamId !== this.activeStreamId) return;
      this.endedStreams.add(streamId);
      this.deps.onStreamEnd(streamId);
      if (this.idleStreams.has(streamId) && this.canDrain(streamId)) {
        this.markDrained(streamId);
      }
    }
    cancelStream(streamId) {
      const target = streamId ?? this.activeStreamId;
      if (target) {
        this.cancelledStreams.add(target);
        this.endedStreams.delete(target);
        this.idleStreams.delete(target);
      }
    }
    canDrain(streamId) {
      return this.endedStreams.has(streamId) && !this.cancelledStreams.has(streamId) && !this.drainedStreams.has(streamId);
    }
    markDrained(streamId) {
      this.endedStreams.delete(streamId);
      this.idleStreams.delete(streamId);
      this.drainedStreams.add(streamId);
      this.deps.onDrained(streamId);
    }
  };

  // src/utterance-uplink.ts
  var UtteranceUplink = class {
    constructor(deps) {
      this.deps = deps;
      __publicField(this, "mode", "vad");
      __publicField(this, "muted", false);
      __publicField(this, "sending", false);
      /** 一次 AI 轮次只发一次本地 abort；回 listening 后重新武装 */
      __publicField(this, "bargeInArmed", true);
      /** 回声防护：speaking 期间吞掉的 VAD start，等回 listening 再决定是否接上 */
      __publicField(this, "suppressedBySpeaking", false);
      /** 最近一次 VAD 判定是否处于说话中（suppression 恢复用，与 sending 解耦） */
      __publicField(this, "vadSpeech", false);
    }
    get sendingActive() {
      return this.sending;
    }
    /** UI 调试信息（噪声基线 / 阈值 / 最新 RMS） */
    get vadStatus() {
      return `noise floor: ${this.deps.vad.noiseFloorValue.toFixed(5)} / thr: ${this.deps.vad.threshold.toFixed(5)} / rms: ${this.deps.vad.lastRmsValue.toFixed(5)}`;
    }
    setMode(mode) {
      if (this.mode === mode) return;
      if (this.sending) {
        this.sending = false;
        this.flushFramerTail();
        this.deps.sendJson({ t: "end" });
        this.deps.log?.("\u5207\u6362\u6A21\u5F0F\uFF0C\u7ED3\u675F\u5F53\u524D utterance -> end");
      }
      this.mode = mode;
      this.deps.preRoll.clear();
    }
    setMuted(muted2) {
      this.muted = muted2;
      if (muted2) {
        this.deps.preRoll.clear();
        if (this.sending) {
          this.sending = false;
          this.flushFramerTail();
          this.deps.sendJson({ t: "end" });
        }
      }
    }
    /** 服务端 state 帧驱动；回 listening/idle 时重新武装本地 barge-in */
    onServerState(state) {
      if (state === "listening" || state === "idle" || state === "interrupted") {
        this.bargeInArmed = true;
        if (this.suppressedBySpeaking) {
          this.suppressedBySpeaking = false;
          if (this.vadSpeech) {
            this.beginSending();
            this.deps.log?.("\u56DE\u58F0\u9632\u62A4\u89E3\u9664\uFF1A\u6062\u590D\u4E0A\u884C\uFF08\u53E5\u9996\u6765\u81EA pre-roll\uFF09");
          }
        }
      }
    }
    /** 16kHz Float32 采样块入口（已重采样） */
    handleSamples(samples) {
      if (this.muted || samples.length === 0) return;
      if (this.mode === "ptt") {
        if (this.sending) this.sendFrames(samples);
        return;
      }
      if (!this.sending) {
        this.deps.preRoll.push(samples);
      }
      const outcome = this.deps.vad.process(samples);
      if (outcome.event === "start") {
        this.vadSpeech = true;
      } else if (outcome.event === "end") {
        this.vadSpeech = false;
      }
      let consumedByFlush = false;
      if (outcome.event === "start") {
        consumedByFlush = this.handleVadStart();
      } else if (outcome.event === "end") {
        this.handleVadEnd(outcome);
      }
      if (this.sending && !consumedByFlush) {
        this.sendFrames(samples);
      }
    }
    // --- PTT 入口 ---
    startPtt() {
      if (this.sending) return;
      this.sending = true;
      this.deps.preRoll.clear();
      this.deps.sendJson({ t: "start" });
      this.deps.log?.("PTT: start");
    }
    endPtt() {
      if (!this.sending) return;
      this.sending = false;
      this.flushFramerTail();
      this.deps.sendJson({ t: "end" });
      this.deps.log?.("PTT: end");
    }
    /** teardown 时复位 */
    reset() {
      this.sending = false;
      this.bargeInArmed = true;
      this.deps.preRoll.clear();
      this.deps.framer.reset();
    }
    handleVadStart() {
      if (this.deps.isAiSpeaking?.()) {
        this.suppressedBySpeaking = true;
        this.deps.log?.("AI speaking\uFF1A\u5FFD\u7565\u672C\u6B21 VAD start\uFF08\u56DE\u58F0\u9632\u62A4\uFF09\uFF0C\u53E5\u9996\u7559\u5728 pre-roll");
        return false;
      }
      if (this.deps.isAiActive() && this.bargeInArmed) {
        this.bargeInArmed = false;
        this.deps.onLocalBargeIn?.();
        this.deps.sendJson({ t: "abort" });
        this.deps.log?.("\u672C\u5730 barge-in\uFF1A\u7ACB\u5373\u505C\u64AD + abort\uFF08\u4E0D\u7B49\u670D\u52A1\u7AEF\u5F80\u8FD4\uFF09");
      }
      if (this.sending) return false;
      this.beginSending();
      return true;
    }
    /** 开始一次上行 utterance：start + flush pre-roll（句首保护） */
    beginSending() {
      this.sending = true;
      this.deps.sendJson({ t: "start" });
      this.deps.log?.(`VAD: \u8BF4\u8BDD\u5F00\u59CB -> start\uFF08pre-roll ${Math.round(this.deps.preRoll.bufferedMs)}ms\uFF09`);
      this.sendFrames(this.deps.preRoll.drain());
    }
    handleVadEnd(outcome) {
      if (outcome.event !== "end") return;
      if (!this.sending) return;
      this.sending = false;
      this.flushFramerTail();
      this.deps.sendJson({ t: "end" });
      this.deps.log?.(`VAD: \u9759\u97F3\u65AD\u53E5 -> end\uFF08spoken ${Math.round(outcome.spokenMs)}ms\uFF09`);
    }
    sendFrames(samples) {
      if (samples.length === 0) return;
      for (const frame of this.deps.framer.push(samples)) {
        this.deps.sendFrame(frame);
      }
    }
    /** utterance 收尾：framer 残余作为末帧直发（已是 PCM16 ArrayBuffer） */
    flushFramerTail() {
      for (const frame of this.deps.framer.flush()) {
        this.deps.sendFrame(frame);
      }
    }
  };

  // src/pre-roll-buffer.ts
  var AudioPreRollBuffer = class {
    constructor(capacitySamples) {
      __publicField(this, "ring");
      __publicField(this, "writePos", 0);
      __publicField(this, "filled", 0);
      if (!Number.isFinite(capacitySamples) || capacitySamples <= 0) {
        throw new Error(`pre-roll capacity must be positive, got ${capacitySamples}`);
      }
      this.ring = new Float32Array(Math.ceil(capacitySamples));
    }
    get capacity() {
      return this.ring.length;
    }
    /** 已缓冲样本数 */
    get length() {
      return this.filled;
    }
    /** 毫秒换算（按 16kHz） */
    get bufferedMs() {
      return this.filled / 16e3 * 1e3;
    }
    /** 写入一段样本；超出容量时只保留最新数据（覆盖最旧） */
    push(samples) {
      if (samples.length === 0) return;
      if (samples.length >= this.ring.length) {
        const tail = samples.subarray(samples.length - this.ring.length);
        this.ring.set(tail, 0);
        this.writePos = 0;
        this.filled = this.ring.length;
        return;
      }
      const headLen = Math.min(samples.length, this.ring.length - this.writePos);
      this.ring.set(samples.subarray(0, headLen), this.writePos);
      const remainder = samples.length - headLen;
      if (remainder > 0) {
        this.ring.set(samples.subarray(headLen), 0);
      }
      this.writePos = (this.writePos + samples.length) % this.ring.length;
      this.filled = Math.min(this.filled + samples.length, this.ring.length);
    }
    /** 按写入顺序取出全部缓冲样本，并清空缓冲 */
    drain() {
      const out = new Float32Array(this.filled);
      if (this.filled === this.ring.length) {
        const tail = this.ring.subarray(this.writePos);
        out.set(tail, 0);
        out.set(this.ring.subarray(0, this.writePos), tail.length);
      } else if (this.filled > 0) {
        out.set(this.ring.subarray(0, this.filled));
      }
      this.clear();
      return out;
    }
    clear() {
      this.writePos = 0;
      this.filled = 0;
    }
  };

  // src/uplink-encoder.ts
  var Float32Resampler = class {
    constructor(fromRate, toRate) {
      this.fromRate = fromRate;
      this.toRate = toRate;
      __publicField(this, "buffer", null);
      /** 下一个输出样本在 buffer 中的小数位置（始终 < 1，随消费一起左移） */
      __publicField(this, "pos", 0);
    }
    push(input) {
      if (this.fromRate === this.toRate || input.length === 0) return input;
      const ratio = this.fromRate / this.toRate;
      const buffer = this.buffer ? concat(this.buffer, input) : input;
      const maxOut = Math.max(0, Math.floor((buffer.length - 1 - this.pos) / ratio) + 1);
      const out = new Float32Array(maxOut);
      for (let k = 0; k < maxOut; k++) {
        const srcPos = this.pos + k * ratio;
        const i0 = Math.floor(srcPos);
        const frac = srcPos - i0;
        const v0 = buffer[i0] ?? 0;
        const v1 = buffer[i0 + 1] ?? v0;
        out[k] = v0 + (v1 - v0) * frac;
      }
      const advanced = this.pos + maxOut * ratio;
      const drop = Math.min(Math.floor(advanced), buffer.length);
      this.buffer = drop > 0 ? buffer.subarray(drop) : buffer;
      this.pos = advanced - drop;
      return out;
    }
    reset() {
      this.buffer = null;
      this.pos = 0;
    }
  };
  var Pcm16Framer = class {
    constructor(frameSamples) {
      this.frameSamples = frameSamples;
      __publicField(this, "queue", []);
      __publicField(this, "queued", 0);
    }
    push(input) {
      if (input.length > 0) {
        this.queue.push(input);
        this.queued += input.length;
      }
      const frames = [];
      while (this.queued >= this.frameSamples) {
        frames.push(this.takeFrame());
      }
      return frames;
    }
    /**
     * F19：utterance 边界收尾——残余样本作为（可能短于 frameSamples 的）末帧发出并清空。
     * 不 flush 的话残余会串进下一句话的首帧（两次各 160 样本的 PTT，
     * 第二句开头会混入第一句的样本）。
     */
    flush() {
      if (this.queued === 0) return [];
      const rest = new Float32Array(this.queued);
      let copied = 0;
      while (this.queue.length > 0) {
        const head = this.queue.shift();
        rest.set(head, copied);
        copied += head.length;
      }
      this.queue = [];
      this.queued = 0;
      return [encodePcm16Frame(rest)];
    }
    reset() {
      this.queue = [];
      this.queued = 0;
    }
    takeFrame() {
      const frame = new Float32Array(this.frameSamples);
      let copied = 0;
      while (copied < this.frameSamples) {
        const head = this.queue[0];
        if (!head) break;
        const need = this.frameSamples - copied;
        const take = Math.min(need, head.length);
        frame.set(head.subarray(0, take), copied);
        copied += take;
        if (take < head.length) {
          this.queue[0] = head.subarray(take);
        } else {
          this.queue.shift();
        }
      }
      this.queued -= copied;
      return encodePcm16Frame(frame);
    }
  };
  function encodePcm16Frame(frame) {
    const pcm = new DataView(new ArrayBuffer(frame.length * 2));
    for (let i = 0; i < frame.length; i++) {
      let s = frame[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
    return pcm.buffer;
  }
  function concat(a, b) {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // src/login-gate.ts
  var STORAGE_KEY = "siren_token";
  function getStoredToken() {
    const raw = (localStorage.getItem(STORAGE_KEY) ?? "").trim();
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
    if (token !== raw) localStorage.setItem(STORAGE_KEY, token);
    return token;
  }
  async function loginWithPassword(password) {
    try {
      const res = await fetch("/v1/web/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (res.status === 401) return { error: "\u5BC6\u7801\u4E0D\u5BF9\uFF0C\u518D\u60F3\u60F3" };
      if (res.status === 429) return { error: "\u8BD5\u5F97\u592A\u9891\u7E41\u4E86\uFF0C\u4E00\u5206\u949F\u540E\u518D\u6765" };
      if (res.status === 503) return { error: "\u670D\u52A1\u7AEF\u8FD8\u6CA1\u8BBE\u7F6E\u5BC6\u7801\uFF08SIREN_WEB_PASSWORD\uFF09" };
      if (!res.ok) return { error: `\u767B\u5F55\u5931\u8D25\uFF08HTTP ${res.status}\uFF09` };
      return { token: (await res.json()).token };
    } catch (e) {
      return { error: `\u8FDE\u4E0D\u4E0A\u670D\u52A1\uFF1A${e.message}` };
    }
  }
  function mountGate() {
    const overlay = document.createElement("div");
    overlay.id = "siren-login-gate";
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:#070b15;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif";
    overlay.innerHTML = `
    <div style="background:#111b2bcc;backdrop-filter:blur(14px);border:1px solid #223049;
                border-radius:18px;padding:32px 34px;width:min(380px,86vw);color:#f1eddf;box-shadow:0 18px 50px rgba(0,0,0,.45)">
      <div style="font-family:'Songti SC',Georgia,serif;font-size:38px;font-weight:500;letter-spacing:.22em;margin-bottom:4px">\u542C\u89C1</div>
      <div style="font-size:13px;color:#aebbce;margin-bottom:18px">\u542C\u89C1 \xB7 \u8F93\u5165\u4F60\u7684\u5BC6\u7801</div>
      <input id="siren-gate-pwd" type="password" placeholder="\u5BC6\u7801" autocomplete="off"
             style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:8px;border:1px solid #65748d;
                    border-bottom-width:1px;background:#0d1522;color:#f1eddf;font-size:14px;outline:none;caret-color:#dbc78e" />
      <div id="siren-gate-err" style="color:#e99b9b;font-size:12px;min-height:18px;margin-top:8px"></div>
      <button id="siren-gate-go" style="width:100%;padding:11px;border:1px solid #bcb397;border-radius:8px;cursor:pointer;
              background:#d9d1b9;color:#152030;font-size:14px;font-weight:600;letter-spacing:.06em">\u8FDB\u6765</button>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#siren-gate-pwd");
    const err = overlay.querySelector("#siren-gate-err");
    const go = overlay.querySelector("#siren-gate-go");
    const submit = async () => {
      const password = input.value.trim();
      if (!password) return;
      go.disabled = true;
      go.textContent = "\u6B63\u5728\u5F00\u95E8\u2026";
      const result = await loginWithPassword(password);
      if ("token" in result) {
        localStorage.setItem(STORAGE_KEY, result.token);
        window.location.reload();
        return;
      }
      go.disabled = false;
      go.textContent = "\u8FDB\u6765";
      err.textContent = result.error;
      input.select();
    };
    go.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
    input.focus();
  }
  function mountKeyButton() {
    const btn = document.createElement("button");
    btn.textContent = "\u{1F511}";
    btn.title = "\u4FEE\u6539\u8BBF\u95EE\u5BC6\u7801";
    btn.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9998;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(30,22,56,.8);color:#c4b1ff;cursor:pointer;font-size:15px";
    btn.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      mountGate();
    });
    document.body.appendChild(btn);
  }
  function requireToken() {
    if (getStoredToken()) {
      mountKeyButton();
      return;
    }
    mountGate();
  }

  // src/ui.ts
  var ui = {
    stateBadge: document.getElementById("stateBadge"),
    partial: document.getElementById("partial"),
    asrLog: document.getElementById("asrLog"),
    reply: document.getElementById("reply"),
    metricsBody: document.getElementById("metricsBody"),
    eventLog: document.getElementById("eventLog"),
    noiseFloor: document.getElementById("noiseFloor"),
    callBtn: document.getElementById("callBtn"),
    muteBtn: document.getElementById("muteBtn"),
    hangupBtn: document.getElementById("hangupBtn"),
    pttBtn: document.getElementById("pttBtn"),
    modeSelect: document.getElementById("mode"),
    conversationId: document.getElementById("conversationId"),
    vConfirm: document.getElementById("vConfirm"),
    vMin: document.getElementById("vMin"),
    vEnd: document.getElementById("vEnd"),
    vRatio: document.getElementById("vRatio"),
    vJitter: document.getElementById("vJitter")
  };
  function setBadge(state) {
    ui.stateBadge.textContent = state;
    ui.stateBadge.className = `badge ${state}`;
  }
  function logEvent(message) {
    const line = `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${message}`;
    ui.eventLog.textContent = `${line}
${ui.eventLog.textContent ?? ""}`.split("\n").slice(0, 200).join("\n");
  }
  function renderMetrics(metrics) {
    if (!metrics) return;
    const rows = [
      ["ASR latency", `${metrics.asr_latency_ms ?? "-"} ms`],
      ["LLM TTFT", `${metrics.llm_first_token_ms ?? "-"} ms`],
      ["TTS first audio", `${metrics.tts_first_audio_ms ?? "-"} ms`],
      ["Total first audio", `${metrics.total_first_audio_ms ?? "-"} ms`],
      ["Interrupted", String(metrics.interrupted ?? false)],
      ["Filler", String(metrics.filler_played ?? false)]
    ];
    ui.metricsBody.innerHTML = rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("");
  }

  // src/capture-worklet.ts
  var WORKLET_CODE = `
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
  async function setupCapture(onSamples) {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    let context = null;
    let worklet = null;
    try {
      context = new AudioContext();
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
      await context.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);
      worklet = new AudioWorkletNode(context, "siren-capture");
      worklet.port.onmessage = (event) => {
        onSamples(event.data);
      };
      context.createMediaStreamSource(mediaStream).connect(worklet);
    } catch (error) {
      worklet?.disconnect();
      await context?.close().catch(() => void 0);
      mediaStream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    const boundContext = context;
    const boundWorklet = worklet;
    let disposed = false;
    return {
      context: boundContext,
      worklet: boundWorklet,
      sampleRate: boundContext.sampleRate,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        boundWorklet.port.onmessage = null;
        boundWorklet.disconnect();
        mediaStream.getTracks().forEach((track) => track.stop());
        await boundContext.close().catch(() => void 0);
      }
    };
  }

  // src/RealtimeCallTest.ts
  requireToken();
  var PRE_ROLL_MS = 400;
  var PROTOCOL_VERSION = 2;
  function authHeaders() {
    const token = getStoredToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  var ws = null;
  var capture = null;
  var player = null;
  var router = null;
  var uplink = null;
  var resampler = null;
  var captureGeneration = 0;
  var serverState = "idle";
  var serverProtocol = 0;
  var muted = false;
  function vadParams() {
    return {
      confirmMs: Number(ui.vConfirm.value) || 200,
      minSpeechMs: Number(ui.vMin.value) || 400,
      endSilenceMs: Number(ui.vEnd.value) || 700,
      rmsRatio: Number(ui.vRatio.value) || 4
    };
  }
  function jitterBufferMs() {
    return Number(ui.vJitter.value) || 350;
  }
  function sendJson(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
  function sendFrame(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
    }
  }
  function ensureConversationId() {
    const existing = (ui.conversationId.value || "").trim();
    if (existing) return existing;
    const generated = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ui.conversationId.value = generated;
    return generated;
  }
  ui.callBtn.addEventListener("click", async () => {
    ui.callBtn.disabled = true;
    setBadge("connecting");
    try {
      const response = await fetch("/v1/calls", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          // 电话必须绑定网页当前 conversation（P0-4.5）；未填则本地生成并回填输入框
          conversation_id: ensureConversationId()
        })
      });
      if (!response.ok) throw new Error(`\u521B\u5EFA\u901A\u8BDD\u5931\u8D25 HTTP ${response.status}`);
      const payload = await response.json();
      await connectSocket(payload.ws_url, payload.token);
      ui.muteBtn.disabled = false;
      ui.hangupBtn.disabled = false;
    } catch (error) {
      setBadge("error");
      logEvent(`\u547C\u53EB\u5931\u8D25\uFF1A${error.message}`);
      ui.callBtn.disabled = false;
    }
  });
  async function connectSocket(wsUrl, token) {
    const url = new URL(wsUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";
    url.searchParams.set("token", token);
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      setBadge("idle");
      logEvent("WebSocket \u5DF2\u8FDE\u63A5");
      sendJson({
        t: "ready",
        protocol: PROTOCOL_VERSION,
        capabilities: { playback_drain: true, stream_identity: true, local_barge_in: true }
      });
      void setupCapture2();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleServerMessage(JSON.parse(event.data));
      } else {
        router?.handleBinary(event.data);
      }
    };
    ws.onclose = (event) => {
      logEvent(`WebSocket \u5173\u95ED code=${event.code}`);
      teardown();
      setBadge("ended");
      ui.callBtn.disabled = false;
    };
    ws.onerror = () => {
      logEvent("WebSocket \u9519\u8BEF");
    };
  }
  async function setupCapture2() {
    const generation = captureGeneration;
    const pipeline = await setupCapture((samples) => handleCapturedSamples(samples));
    if (generation !== captureGeneration) {
      await pipeline.dispose().catch(() => void 0);
      return;
    }
    capture = pipeline;
    player = new JitteredPcmPlayer(
      capture.context,
      jitterBufferMs,
      (streamId) => router?.notifyStreamIdle(streamId)
    );
    router = new StreamRouter({
      onChunk: (buffer, header) => player?.feed(buffer, header.rate, header.stream_id),
      onStreamStart: (streamId) => {
        player?.stopAll();
        player?.resetTimeline();
        logEvent(`\u8F93\u51FA\u6D41\u5F00\u59CB ${streamId}`);
      },
      onStreamEnd: (streamId) => {
        player?.markStreamEnd(streamId);
        logEvent(`PCM \u7ED3\u675F ${streamId}`);
      },
      onDrained: (streamId) => {
        sendJson({ t: "playback_drained", stream_id: streamId });
        logEvent(`\u64AD\u653E\u5B8C\u6BD5 drained ${streamId}`);
      },
      onDropped: (reason, details) => logEvent(`\u4E22\u5F03 chunk\uFF1A${reason} ${JSON.stringify(details)}`)
    });
    uplink = new UtteranceUplink({
      vad: new VadMachine(vadParams),
      preRoll: new AudioPreRollBuffer(16e3 * PRE_ROLL_MS / 1e3),
      framer: new Pcm16Framer(320),
      // 20ms @16k
      sendJson: (message) => sendJson(message),
      sendFrame: (frame) => sendFrame(frame),
      isAiActive: () => serverState === "thinking" || serverState === "speaking",
      isAiSpeaking: () => serverState === "speaking",
      onLocalBargeIn: () => player?.stopAll(),
      log: (message) => logEvent(message)
    });
    uplink.setMode(ui.modeSelect.value === "ptt" ? "ptt" : "vad");
    if (muted) uplink.setMuted(true);
    resampler = new Float32Resampler(capture.sampleRate, 16e3);
    logEvent(`\u91C7\u96C6\u5C31\u7EEA rate=${capture.sampleRate} pre-roll=${PRE_ROLL_MS}ms`);
  }
  function handleCapturedSamples(samples) {
    if (!resampler || !uplink) return;
    const targetSamples = resampler.push(samples);
    if (targetSamples.length === 0) return;
    if (ui.modeSelect.value === "vad") {
      ui.noiseFloor.textContent = uplink.vadStatus;
    }
    uplink.handleSamples(targetSamples);
  }
  function handleServerMessage(message) {
    if (router?.handleJson(message)) {
      if (message.t === "interrupted") {
        const streamId = typeof message.stream_id === "string" ? message.stream_id : null;
        player?.cancelStream(streamId);
        logEvent(`\u5DF2\u88AB\u6253\u65AD\uFF08interrupted ${streamId ?? ""}\uFF09`);
      }
      return;
    }
    const type = message.t;
    switch (type) {
      case "ready":
        serverProtocol = Number(message.protocol ?? 0);
        logEvent(`\u534F\u8BAE\u534F\u5546 v${serverProtocol}`);
        break;
      case "partial":
        ui.partial.textContent = String(message.text ?? "");
        break;
      case "asr":
        ui.asrLog.textContent = `${message.text}
${ui.asrLog.textContent ?? ""}`;
        ui.partial.textContent = "";
        logEvent("ASR final");
        break;
      case "state":
        serverState = String(message.state ?? "");
        setBadge(serverState);
        uplink?.onServerState(serverState);
        break;
      case "reply":
        ui.reply.textContent = String(message.text ?? "");
        break;
      case "notice":
        logEvent(String(message.message ?? ""));
        break;
      case "metrics":
        renderMetrics(message.metrics);
        break;
      case "error":
        logEvent(`\u9519\u8BEF ${message.code}: ${message.message}`);
        break;
      case "pong":
        break;
      default:
        logEvent(`\u672A\u77E5\u6D88\u606F ${type}`);
    }
  }
  ui.muteBtn.addEventListener("click", () => {
    muted = !muted;
    ui.muteBtn.textContent = muted ? "\u{1F399} Unmute" : "\u{1F507} Mute";
    uplink?.setMuted(muted);
    logEvent(muted ? "\u5DF2\u9759\u97F3\uFF08\u505C\u6B62\u4E0A\u884C\uFF09" : "\u53D6\u6D88\u9759\u97F3");
  });
  ui.hangupBtn.addEventListener("click", () => {
    ws?.close(1e3, "hangup");
  });
  ui.modeSelect.addEventListener("change", () => {
    const ptt = ui.modeSelect.value === "ptt";
    ui.pttBtn.style.display = ptt ? "" : "none";
    uplink?.setMode(ptt ? "ptt" : "vad");
  });
  ui.pttBtn.addEventListener("mousedown", () => uplink?.startPtt());
  ui.pttBtn.addEventListener("mouseup", () => uplink?.endPtt());
  ui.pttBtn.addEventListener("mouseleave", () => uplink?.endPtt());
  ui.pttBtn.addEventListener("touchstart", (event) => {
    event.preventDefault();
    uplink?.startPtt();
  });
  ui.pttBtn.addEventListener("touchend", (event) => {
    event.preventDefault();
    uplink?.endPtt();
  });
  ui.stateBadge.addEventListener("click", () => {
    if (serverState === "speaking" || serverState === "thinking") {
      player?.stopAll();
      sendJson({ t: "abort" });
      logEvent("\u624B\u52A8 barge-in \u2192 abort");
    }
  });
  function teardown() {
    captureGeneration++;
    uplink?.reset();
    router?.reset();
    player?.stopAll();
    player = null;
    router = null;
    uplink = null;
    resampler = null;
    void capture?.dispose().catch(() => void 0);
    capture = null;
    serverState = "idle";
    ui.muteBtn.disabled = true;
    ui.hangupBtn.disabled = true;
  }
  window.setInterval(() => sendJson({ t: "ping" }), 25e3);
})();
