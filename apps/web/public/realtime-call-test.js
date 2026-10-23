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
      __publicField(this, "speechStartAt", null);
      __publicField(this, "utteranceStartAt", 0);
      __publicField(this, "lastVoiceAt", 0);
      __publicField(this, "inSpeech", false);
      __publicField(this, "lastRms", 0);
      __publicField(this, "lastNoiseUpdateAt", 0);
      __publicField(this, "candidateParams", null);
    }
    get threshold() {
      return Math.max(3e-3, this.noiseFloor * this.params().rmsRatio);
    }
    /** Candidate settings freeze until end; reserve a trigger block as well. */
    get requiredPreRollSamples() {
      return Math.ceil(Math.max(400, this.params().confirmMs + 80) * 16e3 / 1e3);
    }
    params() {
      if (this.candidateParams) return this.candidateParams;
      const raw = this.getParams();
      const bounded = (n, fallback, max) => Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : fallback;
      return {
        confirmMs: bounded(raw.confirmMs, 200, 2e3),
        minSpeechMs: bounded(raw.minSpeechMs, 400, 1e4),
        endSilenceMs: bounded(raw.endSilenceMs, 700, 5e3),
        rmsRatio: Math.max(1, bounded(raw.rmsRatio, 4, 20))
      };
    }
    get noiseFloorValue() {
      return this.noiseFloor;
    }
    get lastRmsValue() {
      return this.lastRms;
    }
    process(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rmsValue = Math.sqrt(sum / samples.length);
      this.lastRms = rmsValue;
      const params = this.params();
      const threshold = Math.max(3e-3, this.noiseFloor * params.rmsRatio);
      const now = this.now();
      if (!this.inSpeech) {
        if (rmsValue > threshold) {
          if (this.speechStartAt === null) {
            this.speechStartAt = now;
            this.candidateParams = params;
          }
          if (now - this.speechStartAt >= params.confirmMs) {
            this.inSpeech = true;
            this.utteranceStartAt = this.speechStartAt;
            this.lastVoiceAt = now;
            return { event: "start" };
          }
        } else {
          this.speechStartAt = null;
          this.candidateParams = null;
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
        this.speechStartAt = null;
        this.candidateParams = null;
        return { event: "end", spokenMs, valid: spokenMs >= params.minSpeechMs };
      }
      return { event: "none" };
    }
    reset() {
      this.noiseFloor = INITIAL_NOISE_FLOOR;
      this.speechStartAt = null;
      this.utteranceStartAt = 0;
      this.lastVoiceAt = 0;
      this.inSpeech = false;
      this.lastNoiseUpdateAt = 0;
      this.candidateParams = null;
    }
  };

  // src/pcm-player.ts
  var JitteredPcmPlayer = class {
    constructor(ctx, getJitterMs, onStreamIdle, output = ctx.destination) {
      this.ctx = ctx;
      this.getJitterMs = getJitterMs;
      this.onStreamIdle = onStreamIdle;
      this.output = output;
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
      source.connect(this.output);
      const now = this.ctx.currentTime;
      if (this.nextAt < now) {
        this.nextAt = now + this.getJitterMs() / 1e3;
      }
      const span = { start: this.nextAt, duration: audioBuffer.duration };
      state.spans.push(span);
      source.start(this.nextAt);
      this.nextAt += audioBuffer.duration;
      state.sources.add(source);
      source.onended = () => {
        state.sources.delete(source);
        state.completedSeconds += Math.max(0, Math.min(span.duration, (state.stoppedAt ?? this.ctx.currentTime) - span.start));
        const index = state.spans.indexOf(span);
        if (index >= 0) state.spans.splice(index, 1);
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
        state.stoppedAt ?? (state.stoppedAt = this.ctx.currentTime);
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
    /** Client-observed rendered duration only; never derive a text prefix from it. */
    playedMs(streamId) {
      const state = this.streams.get(streamId);
      if (!state) return 0;
      return state.spans.reduce((sum, span) => sum + Math.max(0, Math.min(span.duration, (state.stoppedAt ?? this.ctx.currentTime) - span.start)), state.completedSeconds) * 1e3;
    }
    stateOf(streamId) {
      let state = this.streams.get(streamId);
      if (!state) {
        state = { sources: /* @__PURE__ */ new Set(), ended: false, cancelled: false, drainedNotified: false, spans: [], completedSeconds: 0 };
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
    /** Local interrupt must tombstone the current output before stopping playback. */
    invalidateActive() {
      this.cancelStream(this.activeStreamId ?? void 0);
      this.pendingHeader = null;
    }
    discardPendingBinary() {
      this.pendingHeader = null;
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
      /** AI 活跃期间吞掉的 VAD start，等回 listening 再决定是否接上 */
      __publicField(this, "suppressedByAi", false);
      /** 最近一次 VAD 判定是否处于说话中（suppression 恢复用，与 sending 解耦） */
      __publicField(this, "vadSpeech", false);
      /** 本轮 utterance 是否已 begin（startInput 已调用，coordinator 侧已有 input 身份） */
      __publicField(this, "inputBegan", false);
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
        this.finishInput(true);
        this.deps.log?.("\u5207\u6362\u6A21\u5F0F\uFF0C\u7ED3\u675F\u5F53\u524D utterance -> end");
      }
      this.mode = mode;
      this.suppressedByAi = false;
      this.vadSpeech = false;
      this.deps.vad.reset();
      this.deps.preRoll.clear();
    }
    setMuted(muted2) {
      this.muted = muted2;
      if (muted2) {
        this.suppressedByAi = false;
        this.vadSpeech = false;
        this.deps.vad.reset();
        this.deps.preRoll.clear();
        if (this.sending) {
          this.sending = false;
          this.flushFramerTail();
          this.finishInput(true);
        }
      }
    }
    /** 服务端 state 帧驱动；回 listening/idle 时若用户仍在说话则接上被吞的 utterance。
     * S1011-005：恢复是输入许可的综合判定——仅 VAD 模式、未静音、当前未在发送时才成立 */
    onServerState(state) {
      if (state === "listening" || state === "idle" || state === "interrupted") {
        if (this.suppressedByAi) {
          this.suppressedByAi = false;
          if (this.vadSpeech && this.mode === "vad" && !this.muted && !this.sending) {
            this.beginSending();
            this.deps.log?.("\u534A\u53CC\u5DE5\u95E8\u63A7\u89E3\u9664\uFF1A\u6062\u590D\u4E0A\u884C\uFF08\u53E5\u9996\u6765\u81EA pre-roll\uFF09");
          }
        }
      }
    }
    /** 16kHz Float32 采样块入口（已重采样） */
    handleSamples(samples, detectionSamples = samples) {
      if (this.muted || samples.length === 0) return;
      if (this.mode === "ptt") {
        if (this.sending) this.sendFrames(samples);
        return;
      }
      if (!this.sending) {
        this.deps.preRoll.ensureCapacity(this.deps.vad.requiredPreRollSamples + samples.length);
        this.deps.preRoll.push(samples);
      }
      const outcome = this.deps.vad.process(detectionSamples);
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
      if (this.sending || this.muted || this.mode !== "ptt") return;
      if (this.deps.isAiActive() && !this.deps.canInterrupt?.()) return;
      this.sending = true;
      this.deps.preRoll.clear();
      this.startInput();
      this.deps.log?.("PTT: start");
    }
    endPtt() {
      if (!this.sending) return;
      this.sending = false;
      this.flushFramerTail();
      this.finishInput(true);
      this.deps.log?.("PTT: end");
    }
    /** teardown 时复位 */
    reset() {
      this.sending = false;
      this.suppressedByAi = false;
      this.vadSpeech = false;
      this.inputBegan = false;
      this.deps.preRoll.clear();
      this.deps.framer.reset();
      this.deps.vad.reset();
    }
    handleVadStart() {
      if (this.deps.isAiActive() && !this.deps.canInterrupt?.()) {
        this.suppressedByAi = true;
        this.deps.log?.("AI \u6D3B\u8DC3\uFF08\u534A\u53CC\u5DE5\uFF09\uFF1A\u5FFD\u7565\u672C\u6B21 VAD start\uFF0C\u53E5\u9996\u7559\u5728 pre-roll");
        return false;
      }
      if (this.sending) return false;
      this.beginSending();
      return true;
    }
    /** 开始一次上行 utterance：start + flush pre-roll（句首保护） */
    beginSending() {
      this.sending = true;
      this.startInput();
      this.deps.log?.(`VAD: \u8BF4\u8BDD\u5F00\u59CB -> start\uFF08pre-roll ${Math.round(this.deps.preRoll.bufferedMs)}ms\uFF09`);
      this.sendFrames(this.deps.preRoll.drain());
    }
    handleVadEnd(outcome) {
      if (outcome.event !== "end") return;
      if (!this.sending) return;
      this.sending = false;
      this.flushFramerTail();
      this.finishInput(outcome.valid);
      this.deps.log?.(
        `VAD: \u9759\u97F3\u65AD\u53E5 -> end\uFF08spoken ${Math.round(outcome.spokenMs)}ms${outcome.valid ? "" : "\uFF0C\u77ED\u4E8E\u6700\u77ED\u8BED\u97F3\u95E8\uFF0C\u4EA4\u670D\u52A1\u7AEF\u5224\u5B9A"}\uFF09`
      );
    }
    startInput() {
      if (this.deps.startInput) this.deps.startInput();
      else this.deps.sendJson({ t: "start" });
      this.inputBegan = true;
    }
    finishInput(valid) {
      const submit = valid || this.inputBegan;
      this.inputBegan = false;
      if (this.deps.finishInput) this.deps.finishInput(submit);
      else this.deps.sendJson({ t: submit ? "end" : "abort" });
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
    /** Grow before accepting a candidate block; preserve samples already retained. */
    ensureCapacity(capacitySamples) {
      const capacity = Math.ceil(capacitySamples);
      if (!Number.isFinite(capacity) || capacity <= this.ring.length) return;
      if (capacity > 16e3 * 3) throw new Error("pre-roll window exceeds 3 seconds");
      const kept = this.drain();
      this.ring = new Float32Array(capacity);
      this.push(kept);
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
    voiceModeStatus: document.getElementById("voiceModeStatus"),
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
      // C11：正文（非 filler）首音；只有 filler 时显示 '-'
      ["Server first content PCM", `${metrics.first_content_audio_ms ?? "-"} ms`],
      ["Interrupted", String(metrics.interrupted ?? false)],
      ["Filler", String(metrics.filler_played ?? false)]
    ];
    ui.metricsBody.innerHTML = rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join("");
  }

  // src/capture-worklet.ts
  var WORKLET_CODE = `
class SirenCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const microphone = new Float32Array(input[0]);
      const reference = new Float32Array(inputs[1]?.[0] ?? microphone.length);
      this.port.postMessage({ microphone, reference }, [microphone.buffer, reference.buffer]);
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('siren-capture', SirenCaptureProcessor);
`;
  function installDeviceWatch(audioTracks, onDeviceLost) {
    let lost = false;
    let released = false;
    const notify = () => {
      if (lost || released) return;
      lost = true;
      onDeviceLost?.();
    };
    for (const track of audioTracks) {
      track.onended = () => notify();
    }
    let onDeviceChange = null;
    if (navigator.mediaDevices?.addEventListener) {
      onDeviceChange = () => {
        if (audioTracks.some((track) => track.readyState === "ended")) notify();
      };
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    }
    return {
      get lost() {
        return lost;
      },
      release() {
        released = true;
        for (const track of audioTracks) track.onended = null;
        if (onDeviceChange && navigator.mediaDevices?.removeEventListener) {
          navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
        }
      }
    };
  }
  async function setupCapture(onSamples, preparedContext, onDeviceLost) {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const audioTracks = mediaStream.getAudioTracks();
    const deviceWatch = installDeviceWatch(audioTracks, onDeviceLost);
    let context = preparedContext ?? null;
    let worklet = null;
    let playbackInput = null;
    try {
      context ?? (context = new AudioContext());
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      worklet = new AudioWorkletNode(context, "siren-capture", { numberOfInputs: 2, outputChannelCount: [1] });
      worklet.port.onmessage = (event) => {
        onSamples(event.data.microphone, event.data.reference);
      };
      playbackInput = context.createGain();
      playbackInput.connect(context.destination);
      playbackInput.connect(worklet, 0, 1);
      worklet.connect(context.destination);
      context.createMediaStreamSource(mediaStream).connect(worklet);
    } catch (error) {
      worklet?.disconnect();
      playbackInput?.disconnect();
      deviceWatch.release();
      mediaStream.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => void 0);
      throw error;
    }
    const boundContext = context;
    const boundWorklet = worklet;
    const boundPlayback = playbackInput;
    let disposed = false;
    return {
      context: boundContext,
      worklet: boundWorklet,
      sampleRate: boundContext.sampleRate,
      playbackInput: boundPlayback,
      echoCancellation: audioTracks[0]?.getSettings().echoCancellation,
      get deviceLost() {
        return deviceWatch.lost;
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        deviceWatch.release();
        boundWorklet.port.onmessage = null;
        boundWorklet.disconnect();
        boundPlayback.disconnect();
        mediaStream.getTracks().forEach((track) => track.stop());
        await boundContext.close().catch(() => void 0);
      }
    };
  }

  // src/voice-turn-coordinator.ts
  var VoiceTurnCoordinator = class {
    constructor(deps) {
      this.deps = deps;
      __publicField(this, "sequence", 0);
      __publicField(this, "current", null);
      __publicField(this, "outputAllowed", false);
      __publicField(this, "acknowledged", false);
      __publicField(this, "pending", []);
      __publicField(this, "pendingBytes", 0);
      __publicField(this, "pendingEnd", false);
      __publicField(this, "timer");
      __publicField(this, "negotiated", null);
      __publicField(this, "prefix");
      this.prefix = deps.idPrefix ?? `in_${Math.random().toString(36).slice(2, 12)}`;
    }
    get supported() {
      return this.negotiated === true;
    }
    get inputId() {
      return this.current;
    }
    negotiate(supported) {
      if (this.negotiated !== true) this.negotiated = supported;
    }
    begin() {
      if (this.negotiated === null) {
        this.deps.onFailure("capability_not_ready");
        return;
      }
      if (!this.negotiated) {
        this.deps.sendJson({ t: "start" });
        return;
      }
      const previous = this.current;
      const next = `${this.prefix}_${++this.sequence}`;
      this.clearPending();
      this.current = next;
      this.outputAllowed = true;
      this.acknowledged = false;
      const playback = this.deps.invalidateOutput();
      this.timer = setTimeout(() => this.fail("input_ack_timeout"), this.deps.ackTimeoutMs ?? 5e3);
      this.deps.sendJson(previous ? { t: "interrupt", target_input_id: previous, new_input_id: next, ...playback ? { playback } : {} } : { t: "start", input_id: next });
    }
    sendFrame(frame) {
      if (this.negotiated === null) return;
      if (!this.negotiated) {
        this.deps.sendFrame(frame);
        return;
      }
      if (!this.current || !this.outputAllowed || this.pendingEnd) return;
      if (this.acknowledged) {
        this.deps.sendFrame(frame);
        return;
      }
      if (this.pendingBytes + frame.byteLength > (this.deps.maxPendingBytes ?? 256 * 1024)) {
        this.fail("input_buffer_overflow");
        return;
      }
      this.pending.push(frame.slice(0));
      this.pendingBytes += frame.byteLength;
    }
    finish(valid = true) {
      if (this.negotiated === null) return;
      if (!valid) {
        this.abort();
        return;
      }
      if (!this.negotiated) {
        this.deps.sendJson({ t: "end" });
        return;
      }
      if (!this.current || !this.outputAllowed) return;
      if (this.pendingEnd) return;
      this.pendingEnd = true;
      if (this.acknowledged) this.deps.sendJson({ t: "end", input_id: this.current });
    }
    abort() {
      this.outputAllowed = false;
      const playback = this.deps.invalidateOutput();
      this.clearPending();
      if (this.negotiated === null) return;
      if (!this.negotiated) {
        this.deps.sendJson({ t: "abort" });
        return;
      }
      if (this.current) this.deps.sendJson({ t: "abort", input_id: this.current, ...playback ? { playback } : {} });
    }
    /** Filter every turn frame, not just PCM: old final/state cannot overwrite new input. */
    accept(message) {
      if (!this.negotiated || message.t === "ready" || message.t === "pong") return true;
      const id = typeof message.input_id === "string" ? message.input_id : null;
      if (message.t === "input_started") {
        if (id !== this.current || !this.outputAllowed || this.acknowledged) return false;
        clearTimeout(this.timer);
        this.timer = void 0;
        this.acknowledged = true;
        const pending = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const frame of pending) this.deps.sendFrame(frame);
        if (this.pendingEnd) this.deps.sendJson({ t: "end", input_id: id });
        return true;
      }
      if (id !== this.current) {
        return !id && message.t === "error";
      }
      if (message.t === "error" && !this.acknowledged && this.outputAllowed) {
        this.fail(String(message.code ?? "input_rejected"));
        return true;
      }
      if (!this.outputAllowed) {
        return message.t === "interrupted" || message.t === "metrics" || message.t === "notice" || message.t === "error" || message.t === "state" && message.state === "listening";
      }
      return true;
    }
    reset() {
      this.clearPending();
      this.current = null;
      this.outputAllowed = false;
      this.negotiated = null;
    }
    fail(reason) {
      this.abort();
      this.deps.onFailure(reason);
    }
    clearPending() {
      clearTimeout(this.timer);
      this.timer = void 0;
      this.pending = [];
      this.pendingBytes = 0;
      this.pendingEnd = false;
      this.acknowledged = false;
    }
  };

  // src/playback-echo-guard.ts
  var PlaybackEchoGuard = class {
    constructor() {
      __publicField(this, "reference", new Float32Array(2048));
      // 512ms at 4kHz
      __publicField(this, "microphone", new Float32Array(128));
      // 32ms matching window
      __publicField(this, "fullReference", new Float32Array(8192));
      __publicField(this, "fullHead", 0);
      __publicField(this, "match", null);
      __publicField(this, "refHead", 0);
      __publicField(this, "micHead", 0);
      __publicField(this, "refCount", 0);
      __publicField(this, "micCount", 0);
      __publicField(this, "phase", 0);
      __publicField(this, "echo", false);
      __publicField(this, "analysisSamples", 0);
    }
    get suppressingEcho() {
      return this.echo;
    }
    /** 浸泡测试用：内部三个环形缓冲均为固定容量，此值不随处理时长增长 */
    get fixedBufferSamples() {
      return this.reference.length + this.fullReference.length + this.microphone.length;
    }
    /** Both inputs are synchronous 16kHz samples from the same AudioContext. */
    process(mic, rendered) {
      for (let i = 0; i < mic.length; i++) {
        this.fullReference[this.fullHead] = rendered[i] ?? 0;
        this.fullHead = (this.fullHead + 1) % this.fullReference.length;
        if (this.phase++ % 4 !== 0) continue;
        this.reference[this.refHead] = rendered[i] ?? 0;
        this.refHead = (this.refHead + 1) % this.reference.length;
        this.refCount = Math.min(this.refCount + 1, this.reference.length);
        this.microphone[this.micHead] = mic[i];
        this.micHead = (this.micHead + 1) % this.microphone.length;
        this.micCount = Math.min(this.micCount + 1, this.microphone.length);
      }
      this.analysisSamples += mic.length;
      if (this.analysisSamples >= 320) {
        this.analysisSamples %= 320;
        this.match = this.estimateEcho();
        this.echo = this.match !== null;
      }
      if (!this.match) return mic;
      const { lag, gain } = this.match;
      return Float32Array.from(mic, (sample, i) => {
        const index = (this.fullHead - mic.length + i - lag * 4 + this.fullReference.length * 2) % this.fullReference.length;
        const residual = sample - gain * this.fullReference[index];
        return Math.abs(residual) < 1e-6 ? 0 : residual;
      });
    }
    reset() {
      this.reference.fill(0);
      this.microphone.fill(0);
      this.fullReference.fill(0);
      this.fullHead = 0;
      this.match = null;
      this.refHead = this.micHead = this.refCount = this.micCount = this.phase = 0;
      this.echo = false;
      this.analysisSamples = 0;
    }
    estimateEcho() {
      const n = this.microphone.length;
      if (this.micCount < n || this.refCount < n) return null;
      let micEnergy = 0;
      for (let i = 0; i < n; i++) micEnergy += this.microphone[i] ** 2;
      if (micEnergy < 1e-7) return null;
      let bestScore = 0.9;
      let best = null;
      const maxLag = Math.min(1400, this.refCount - n);
      for (let lag = 0; lag <= maxLag; lag += 2) {
        let cross = 0;
        let refEnergy = 0;
        for (let i = 0; i < n; i++) {
          const r = this.reference[(this.refHead - n - lag + i + this.reference.length) % this.reference.length];
          const m = this.microphone[(this.micHead + i) % n];
          cross += r * m;
          refEnergy += r * r;
        }
        const score = refEnergy > 1e-6 ? cross * cross / (micEnergy * refEnergy) : 0;
        if (score > bestScore && Math.abs(cross / refEnergy) <= 8) {
          bestScore = score;
          best = { lag, gain: cross / refEnergy };
        }
      }
      return best;
    }
  };

  // src/RealtimeCallTest.ts
  requireToken();
  var PRE_ROLL_MS = 400;
  var PROTOCOL_VERSION = 2;
  var CLOSE_DEVICE_LOST = 4007;
  function authHeaders() {
    const token = getStoredToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  var ws = null;
  var capture = null;
  var pendingAudioContext = null;
  var captureRequested = false;
  var readyTimer;
  var callRequest = null;
  var player = null;
  var router = null;
  var uplink = null;
  var resampler = null;
  var referenceResampler = null;
  var turns = null;
  var echoGuard = new PlaybackEchoGuard();
  var captureGeneration = 0;
  var serverState = "idle";
  var serverProtocol = 0;
  var muted = false;
  var deviceLost = false;
  var serverVadDefaults = null;
  var serverJitterMs = null;
  function setting(value, fallback) {
    if (value === void 0 || value === null || String(value).trim() === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function applyServerTuning(message) {
    const vad = message.vad;
    if (vad) {
      serverVadDefaults = {
        confirmMs: setting(vad.confirm_ms, 200),
        minSpeechMs: setting(vad.min_speech_ms, 400),
        endSilenceMs: setting(vad.end_silence_ms, 700),
        rmsRatio: setting(vad.rms_ratio, 4)
      };
      if (!ui.vConfirm.dataset.touched) ui.vConfirm.value = String(serverVadDefaults.confirmMs);
      if (!ui.vMin.dataset.touched) ui.vMin.value = String(serverVadDefaults.minSpeechMs);
      if (!ui.vEnd.dataset.touched) ui.vEnd.value = String(serverVadDefaults.endSilenceMs);
      if (!ui.vRatio.dataset.touched) ui.vRatio.value = String(serverVadDefaults.rmsRatio);
    }
    if (typeof message.jitter_ms === "number") {
      serverJitterMs = message.jitter_ms;
      if (!ui.vJitter.dataset.touched) ui.vJitter.value = String(serverJitterMs);
    }
  }
  function vadParams() {
    const base = serverVadDefaults ?? { confirmMs: 200, minSpeechMs: 400, endSilenceMs: 700, rmsRatio: 4 };
    return {
      confirmMs: setting(ui.vConfirm.value, base.confirmMs),
      minSpeechMs: setting(ui.vMin.value, base.minSpeechMs),
      endSilenceMs: setting(ui.vEnd.value, base.endSilenceMs),
      rmsRatio: setting(ui.vRatio.value, base.rmsRatio)
    };
  }
  function jitterBufferMs() {
    return Math.min(2e3, Math.max(0, setting(ui.vJitter.value, serverJitterMs ?? 350)));
  }
  for (const input of [ui.vConfirm, ui.vMin, ui.vEnd, ui.vRatio, ui.vJitter]) {
    input.addEventListener("input", () => {
      input.dataset.touched = "1";
    });
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
    const generation = ++captureGeneration;
    deviceLost = false;
    ui.callBtn.disabled = true;
    ui.hangupBtn.disabled = false;
    const request = new AbortController();
    callRequest = request;
    setBadge("connecting");
    try {
      pendingAudioContext = new AudioContext();
      const context = pendingAudioContext;
      await context.resume();
      if (generation !== captureGeneration) {
        void context.close().catch(() => void 0);
        return;
      }
      const response = await fetch("/v1/calls", {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          // 电话必须绑定网页当前 conversation（P0-4.5）；未填则本地生成并回填输入框
          conversation_id: ensureConversationId()
        })
      });
      if (!response.ok) throw new Error(`\u521B\u5EFA\u901A\u8BDD\u5931\u8D25 HTTP ${response.status}`);
      const payload = await response.json();
      if (generation !== captureGeneration) {
        void context.close().catch(() => void 0);
        return;
      }
      if (callRequest === request) callRequest = null;
      await connectSocket(payload.ws_url, payload.token);
      ui.muteBtn.disabled = false;
      ui.hangupBtn.disabled = false;
    } catch (error) {
      if (generation !== captureGeneration) return;
      teardown();
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
    const socket = new WebSocket(url);
    ws = socket;
    socket.binaryType = "arraybuffer";
    turns = new VoiceTurnCoordinator({
      sendJson,
      sendFrame,
      invalidateOutput: () => {
        const streamId = router?.activeStream;
        const playback = streamId ? { stream_id: streamId, played_ms: player?.playedMs(streamId) ?? 0 } : void 0;
        router?.invalidateActive();
        player?.stopAll();
        return playback;
      },
      onFailure: (reason) => {
        logEvent(`\u8F93\u5165\u4EA4\u63A5\u5931\u8D25\uFF1A${reason}\uFF0C\u8BF7\u91CD\u65B0\u547C\u53EB`);
        uplink?.reset();
        ws?.close(4004, "input handoff failed");
      }
    });
    socket.onopen = () => {
      if (ws !== socket) return;
      setBadge("idle");
      logEvent("WebSocket \u5DF2\u8FDE\u63A5");
      sendJson({
        t: "ready",
        protocol: PROTOCOL_VERSION,
        capabilities: { playback_drain: true, stream_identity: true, voice_interrupt: true }
      });
      readyTimer = setTimeout(() => {
        if (ws === socket) socket.close(4004, "capability negotiation timeout");
      }, 5e3);
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      if (typeof event.data === "string") {
        handleServerMessage(JSON.parse(event.data));
      } else {
        router?.handleBinary(event.data);
      }
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      logEvent(`WebSocket \u5173\u95ED code=${event.code}`);
      teardown();
      setBadge(deviceLost ? "device_lost" : "ended");
      ui.callBtn.disabled = false;
    };
    socket.onerror = () => {
      if (ws !== socket) return;
      logEvent("WebSocket \u9519\u8BEF");
    };
  }
  async function setupCapture2() {
    const generation = captureGeneration;
    const prepared = pendingAudioContext ?? void 0;
    const pipeline = await setupCapture((samples, reference) => {
      if (generation === captureGeneration) handleCapturedSamples(samples, reference);
    }, prepared, () => {
      if (generation !== captureGeneration) return;
      deviceLost = true;
      logEvent("\u9EA6\u514B\u98CE\u8BBE\u5907\u4E22\u5931\uFF08track ended/devicechange\uFF09\uFF0C\u901A\u8BDD\u7ED3\u675F");
      const socket = ws;
      teardown();
      socket?.close(CLOSE_DEVICE_LOST, "capture device lost");
      setBadge("device_lost");
      ui.callBtn.disabled = false;
    });
    if (generation !== captureGeneration) {
      await pipeline.dispose().catch(() => void 0);
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
      sendFrame: (frame) => turns?.sendFrame(frame),
      startInput: () => turns?.begin(),
      finishInput: (valid) => turns?.finish(valid),
      canInterrupt: () => turns?.supported ?? false,
      isAiActive: hasResponse,
      log: (message) => logEvent(message)
    });
    uplink.setMode(ui.modeSelect.value === "ptt" ? "ptt" : "vad");
    if (muted) uplink.setMuted(true);
    resampler = new Float32Resampler(capture.sampleRate, 16e3);
    referenceResampler = new Float32Resampler(capture.sampleRate, 16e3);
    echoGuard.reset();
    logEvent(`\u91C7\u96C6\u5C31\u7EEA rate=${capture.sampleRate} pre-roll=${PRE_ROLL_MS}ms`);
    if (capture.echoCancellation === false) {
      logEvent("\u8BBE\u5907\u672A\u542F\u7528\u7CFB\u7EDF\u56DE\u58F0\u6D88\u9664\uFF0C\u5EFA\u8BAE\u4F7F\u7528\u8033\u673A\u6216\u6309\u4F4F\u8BF4\u8BDD");
    }
  }
  function handleCapturedSamples(samples, reference) {
    if (!resampler || !referenceResampler || !uplink) return;
    const targetSamples = resampler.push(samples);
    const rendered = referenceResampler.push(reference);
    if (targetSamples.length === 0) return;
    const nearEnd = echoGuard.process(targetSamples, rendered);
    if (ui.modeSelect.value === "vad") {
      ui.noiseFloor.textContent = uplink.vadStatus;
    }
    uplink.handleSamples(targetSamples, nearEnd);
  }
  function handleServerMessage(message) {
    if (turns && !turns.accept(message)) {
      if (message.t === "pcm") router?.discardPendingBinary();
      return;
    }
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
        clearTimeout(readyTimer);
        readyTimer = void 0;
        serverProtocol = Number(message.protocol ?? 0);
        turns?.negotiate(message.capabilities?.voice_interrupt === true);
        applyServerTuning(message);
        ui.voiceModeStatus.textContent = turns?.supported ? "\u5F00\u53E3\u53EF\u6253\u65AD" : "\u670D\u52A1\u7AEF\u4EC5\u652F\u6301\u624B\u52A8\u6253\u65AD";
        logEvent(`\u534F\u8BAE\u534F\u5546 v${serverProtocol}\uFF0Cclient=1012-interrupt`);
        if (!captureRequested && ws) {
          captureRequested = true;
          const socket = ws;
          void setupCapture2().catch((error) => {
            if (ws !== socket) return;
            logEvent(`\u65E0\u6CD5\u542F\u52A8\u9EA6\u514B\u98CE\uFF1A${error.message}`);
            socket.close(4004, "capture unavailable");
          });
        }
        break;
      case "input_started":
        serverState = "listening";
        setBadge(serverState);
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
    const socket = ws;
    teardown();
    socket?.close(1e3, "hangup");
    setBadge("ended");
    ui.callBtn.disabled = false;
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
  function hasResponse() {
    return ["ending", "thinking", "speaking"].includes(serverState) || (player?.scheduledCount ?? 0) > 0;
  }
  ui.stateBadge.addEventListener("click", () => {
    if (hasResponse()) {
      turns?.abort();
      uplink?.reset();
      logEvent("\u624B\u52A8 barge-in \u2192 abort");
    }
  });
  function teardown() {
    captureGeneration++;
    callRequest?.abort();
    callRequest = null;
    clearTimeout(readyTimer);
    readyTimer = void 0;
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
    void capture?.dispose().catch(() => void 0);
    capture = null;
    void pendingAudioContext?.close().catch(() => void 0);
    pendingAudioContext = null;
    serverState = "idle";
    ui.voiceModeStatus.textContent = "\u672A\u8FDE\u63A5";
    ui.muteBtn.disabled = true;
    ui.hangupBtn.disabled = true;
  }
  window.setInterval(() => sendJson({ t: "ping" }), 25e3);
})();
