"use strict";
(() => {
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

  // src/AsyncVoiceTest.ts
  requireToken();
  function authHeaders() {
    const token = getStoredToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  function el(id) {
    return document.getElementById(id);
  }
  var startRecBtn = el("startRec");
  var stopRecBtn = el("stopRec");
  var recTime = el("recTime");
  var asrOut = el("asrOut");
  var recorder = null;
  var chunks = [];
  var timer = null;
  var startedAt = 0;
  startRecBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : void 0;
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : void 0);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void uploadRecording(new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }));
      };
      recorder.start(250);
      startedAt = Date.now();
      startRecBtn.disabled = true;
      stopRecBtn.disabled = false;
      timer = window.setInterval(() => {
        recTime.textContent = `\u25CF ${((Date.now() - startedAt) / 1e3).toFixed(1)}s`;
      }, 200);
    } catch (error) {
      asrOut.textContent = `\u65E0\u6CD5\u8BBF\u95EE\u9EA6\u514B\u98CE\uFF1A${error.message}`;
    }
  });
  stopRecBtn.addEventListener("click", () => {
    recorder?.stop();
    if (timer !== null) window.clearInterval(timer);
    startRecBtn.disabled = false;
    stopRecBtn.disabled = true;
  });
  async function uploadRecording(blob) {
    asrOut.textContent = "\u8F6C\u5199\u4E2D\u2026";
    const form = new FormData();
    form.append("audio", blob, "recording.webm");
    form.append("format", "webm");
    const conversation = (el("asrConv").value || "").trim();
    if (conversation) form.append("conversation_id", conversation);
    if (el("asrStore").checked) form.append("store", "true");
    try {
      const response = await fetch("/v1/voice/transcribe", {
        method: "POST",
        headers: authHeaders(),
        body: form
      });
      const payload = await response.json();
      asrOut.textContent = JSON.stringify(payload, null, 2);
    } catch (error) {
      asrOut.textContent = `\u8F6C\u5199\u5931\u8D25\uFF1A${error.message}`;
    }
  }
  var speakBtn = el("speakBtn");
  var ttsText = el("ttsText");
  var emotionSelect = el("emotion");
  var speedInput = el("speed");
  var speedVal = el("speedVal");
  var player = el("player");
  var ttsMeta = el("ttsMeta");
  speedInput.addEventListener("input", () => {
    speedVal.textContent = Number(speedInput.value).toFixed(2);
  });
  speakBtn.addEventListener("click", async () => {
    const text = ttsText.value.trim();
    if (!text) return;
    speakBtn.disabled = true;
    ttsMeta.textContent = "\u5408\u6210\u4E2D\u2026";
    try {
      const response = await fetch("/v1/voice/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          text,
          emotion: emotionSelect.value,
          speed: Number(speedInput.value),
          format: "mp3"
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }
      const durationMs = response.headers.get("x-siren-duration-ms") ?? "?";
      const format = response.headers.get("x-siren-format") ?? "?";
      const blob = await response.blob();
      player.src = URL.createObjectURL(blob);
      await player.play();
      ttsMeta.textContent = `format=${format} duration=${durationMs}ms bytes=${blob.size}`;
    } catch (error) {
      ttsMeta.textContent = `\u5408\u6210\u5931\u8D25\uFF1A${error.message}`;
    } finally {
      speakBtn.disabled = false;
    }
  });
})();
