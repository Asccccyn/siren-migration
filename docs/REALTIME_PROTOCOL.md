# Siren 实时通话协议

## 建立

```text
POST /v1/calls          { "conversation_id": "...", "voice_profile": "main" }
-> 201 { call_id, ws_url, token, expires_at }

GET /ws/call/{call_id}?token={short-lived-token}   (WebSocket)
```

- token 默认 120 秒过期，绑定 call_id；握手失败关闭码 `4001`。
- 同一 call_id 已有活跃会话时关闭码 `4002`。

## 音频约定

| 方向 | 格式 |
|---|---|
| 上行（Client → Server binary） | PCM16 / 16kHz / mono |
| 下行（Server → Client binary） | PCM16 / 24kHz / mono |

浏览器采集链路：`getUserMedia → AudioWorklet → Float32 → 线性重采样 16k → PCM16 → WS binary`（不得使用已废弃的 ScriptProcessorNode）。

## Client → Server（文本帧 JSON）

| 消息 | 说明 |
|---|---|
| `{"t":"ready"}` | 连接就绪，服务端回当前 state |
| `{"t":"start"}` | 开始一次讲话（新建 ASR 会话，建连期间 PCM 由服务端 prebuffer） |
| `{"t":"end"}` | 结束讲话，等待 final / partial 采纳 |
| `{"t":"abort"}` | Barge-in：取消当前轮 |
| `{"t":"ping"}` | 保活，回 `pong` |

## Server → Client（文本帧 JSON）

| 消息 | 说明 |
|---|---|
| `{"t":"partial","text":"..."}` | ASR 增量字幕 |
| `{"t":"asr","text":"..."}` | 本轮最终识别 |
| `{"t":"state","state":"thinking"}` | 状态机迁移（connecting/listening/thinking/speaking/interrupted/ended/error 由前端展示） |
| `{"t":"reply","text":"..."}` | 完整回复文本（语音失败也不丢） |
| `{"t":"pcm","rate":24000}` | PCM 流开始，其后为 binary 帧 |
| `{"t":"pcm_end"}` | 本轮 PCM 结束 |
| `{"t":"interrupted"}` | 打断完成，客户端须清空播放队列 |
| `{"t":"metrics",...}` | 本轮延迟指标（asr_latency_ms / llm_first_token_ms / tts_first_audio_ms / total_first_audio_ms） |
| `{"t":"pong"}` | 心跳响应 |
| `{"t":"error","code":"...","message":"..."}` | 错误（asr_failed / tts_failed / core_failed / invalid_state） |

## 状态机

```text
IDLE → LISTENING → ENDING → THINKING → SPEAKING → LISTENING → ...
SPEAKING --abort--> INTERRUPTING → LISTENING
```

前端状态由服务端 `state` 帧下发，不自行猜测。

## Barge-in 语义

客户端在 thinking/speaking 期间发 `{"t":"abort"}`，服务端：

1. 取消 Core LLM 流（core.cancel(turnId)）
2. 停止当前 TTS 流迭代
3. 停止后续 PCM 下发（已排队未发送的句子丢弃）
4. 下发 `interrupted`，客户端清空播放队列
5. 已真正播出的句子保留为该轮 assistant 文本（写回 call_turns，interrupted=1）
6. 立即回 LISTENING

## 播放端建议（jitter buffer）

- 首块 `{"t":"pcm"}` 后：`nextAt = ctx.currentTime + JITTER_BUFFER_MS/1000`（默认 350ms，可配置）。
- 每个 binary 帧转 `AudioBuffer(1, n, 24000)`，`source.start(nextAt)`，`nextAt += duration`，形成连续时间轴。
- 收到 `interrupted` 立即 `source.stop()` 全部已调度节点并重置 `nextAt`。

## VAD（浏览器端第一层）

RMS + 自适应噪声基线；默认参数（均可配置，服务端 `.env` 有对应下发项）：

| 参数 | 默认 |
|---|---|
| 确认讲话 | 200ms |
| 最短有效语音 | 400ms |
| 结束静音 | 700ms |
| RMS 倍数 | 4x noise floor |
