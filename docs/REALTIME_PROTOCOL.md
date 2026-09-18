# Siren 实时通话协议（v2）

> 协议版本 2（v1.1 Realtime Hardening）。新增：pre-roll、本地 barge-in、
> 下行 Stream Identity（stream_id + sequence）、playback_drained、ready 能力协商。
> 每帧真实采样率始终以 `pcm` 头为准，`ready` 中的 rate 只是期望值。

## 建立

```text
POST /v1/calls          { "conversation_id": "...", "voice_profile": "main" }
-> 201 { call_id, ws_url, token, expires_at, conversation_id, voice_profile }

GET /ws/call/{call_id}?token={short-lived-token}   (WebSocket)
```

- `conversation_id` **必填**：CallSession 必须绑定网页当前使用的同一个 conversation
  （callId ≠ conversationId；callId 只是临时实时通信会话，挂断即销毁，conversation 保留）。
- token 默认 120 秒过期，创建时**冻结** conversation + voice profile；握手只接受
  `call_id` + `token`，query 里的 `conversation_id` / `voice_profile` 一律忽略并告警。
- 握手失败关闭码 `4001`；同一 call_id 已有活跃会话 `4002`；背压超限 `4005`。

## 音频约定

| 方向 | 格式 |
|---|---|
| 上行（Client → Server binary） | PCM16 / 16kHz / mono |
| 下行（Server → Client binary） | PCM16 / 默认 24kHz / mono（每 chunk 真实 rate 见 pcm 头） |

浏览器采集链路：`getUserMedia → AudioWorklet → Float32 → 线性重采样 16k → PCM16 → WS binary`。

## Client → Server（文本帧 JSON）

| 消息 | 说明 |
|---|---|
| `{"t":"ready","protocol":2,"capabilities":{...}}` | 连接就绪 + 能力上报（playback_drain / stream_identity / local_barge_in） |
| `{"t":"start"}` | 开始一次讲话（新建 ASR 会话，建连期间 PCM 由服务端 prebuffer） |
| `{"t":"end"}` | 结束讲话，等待 final / partial 采纳 |
| `{"t":"abort"}` | Barge-in：取消当前轮（本地已先停播，此帧用于服务端取消） |
| `{"t":"playback_drained","stream_id":"out_..."}` | 该输出流真正播完后 ACK（P0-4） |
| `{"t":"ping"}` | 保活，回 `pong` |

## Server → Client（文本帧 JSON）

| 消息 | 说明 |
|---|---|
| `{"t":"ready","protocol":2,"audio":{"input_rate":16000,"output_rate":24000,"format":"pcm16"}}` | 协议协商 + 音频契约（来自 RealtimeVoiceProvider 边界） |
| `{"t":"partial","text":"..."}` | ASR 增量字幕（覆盖式更新） |
| `{"t":"asr","text":"..."}` | 本轮最终识别 |
| `{"t":"state","state":"thinking"}` | 状态机迁移 |
| `{"t":"reply","text":"..."}` | 完整回复文本（语音失败也不丢） |
| `{"t":"pcm","stream_id":"out_x","sequence":0,"rate":24000,"bytes":1920}` | **每个**二进制帧前的 JSON 头（P0-3） |
| `{"t":"pcm_end","stream_id":"out_x"}` | 本轮 PCM 结束（流粒度） |
| `{"t":"interrupted","stream_id":"out_x"}` | 打断完成；该输出流永久失效 |
| `{"t":"metrics",...}` | 本轮延迟指标 |
| `{"t":"pong"}` / `{"t":"error",...}` | 心跳 / 错误（asr_failed / tts_failed / core_failed / invalid_state） |

### Stream Identity 与 sequence（P0-3）

- 每轮 TTS 输出独立 `output_stream_id`（`out_` 前缀），紧跟一个 binary 帧。
- 客户端规则：新流开始 → 清旧播放队列；旧流迟到 chunk 丢弃；被 `interrupted`
  的流不允许复活；`sequence <= last` 丢弃（duplicate/stale），`> last+1` 记录
  gap 但继续播放（单块丢包不杀整通电话）；`bytes` 与 binary 长度不符丢弃；
  binary 无对应头丢弃。
- binary 与 stream_id / sequence 的对应**不依赖猜测**。

### Playback Drain（P0-4，v1.1 审计后为状态机语义）

必须区分「服务端发完 PCM」与「用户听完 PCM」。客户端只在
`pcm_end(stream_id)` **且该流全部 AudioBufferSourceNode 播完**后发送
`playback_drained`。

对声明了 `playback_drain` 能力（协议 v2 ready）的客户端，服务端在
`pcm_end` 后**保持 speaking**，收到 `playback_drained` 才迁移
`speaking → listening`；超时（`PLAYBACK_DRAIN_TIMEOUT_MS`，默认 4s）兜底回
listening，绝不悬挂 session。因此尾音播放期间客户端的
`isAiActive` 判定仍为 true，本地 barge-in 在尾音阶段照常生效
（实测 drain 期抢话 <100ms 内 interrupted）。未声明该能力的旧协议客户端
`pcm_end` 后立即回 listening（降级行为）。被打断的流不要求 drained。

## 状态机

```text
IDLE → LISTENING → ENDING → THINKING → SPEAKING → LISTENING → ...
SPEAKING --abort--> INTERRUPTING → LISTENING
```

正常说完一句回复是 `speaking → listening` 直达（协议 v2 客户端中间多一段
drain 等待期，期间状态保持 speaking）；`interrupting` 只用于真实打断。

## Barge-in 语义（三层）

1. **浏览器本地立即停播**（P0-2）：VAD 确认用户重新开口且处于 thinking/speaking
   时，先 `player.stopAll()` 再发 `{"t":"abort"}`，不等服务端往返；一次 AI 轮次
   防抖，回 listening 后重新武装。
2. **Siren server 取消当前轮**：取消 Core 流（core.cancel）、abortTurn、作废旧
   输出流（`interrupted` + stream_id）、清 reply pipeline、回 LISTENING。
3. **Provider 正式 abort**：turn 级 AbortSignal 立即终止 TTS 上游
   （火山双向流式连接 terminate / ElevenLabs fetch 取消），ASR 会话关闭。

服务端 `interrupted` 帧保留用于最终确认 / 清理 / 调试。

## 客户端 pre-roll（P0-1 首音保护）

持续采集的 16kHz 样本始终进入 400ms 环形缓冲（`AudioPreRollBuffer`）；
VAD 确认 start 的瞬间随 `{"t":"start"}` flush 全部缓冲（含当前块），
判定窗口内的句首音频不丢。当前块先入缓冲再判定，flush 已含当前块，
不会重复发送。服务端 `asr-prebuffer` 是建连期保护，两者互补、缺一不可。

## 播放端建议（jitter buffer）

- 首块 `pcm` 后：`nextAt = ctx.currentTime + JITTER_BUFFER_MS/1000`（默认 350ms）。
- 每个 binary 帧按其头内 `rate` 转 `AudioBuffer(1, n, rate)`，`source.start(nextAt)`
  连续排程；播放器按 stream_id 跟踪节点，流结束且节点清零时触发 drained。
- 收到 `interrupted` / 新流开始立即 `stop()` 全部已调度节点并重置时间轴。

## VAD（浏览器端第一层）

RMS + 自适应噪声基线；默认参数（均可配置）：

| 参数 | 默认 |
|---|---|
| 确认讲话 | 200ms |
| 最短有效语音 | 400ms |
| 结束静音 | 700ms |
| RMS 倍数 | 4x noise floor |

## Conversation 绑定（P0-4.5）

电话内 ASR final 作为 user message 进入 Core 的同一 conversation
（`modality: voice_call`）；电话回复写回同一 conversation（Core 生成侧 +
`call_turns` 元数据）。电话期间网页 typed message 走 Core 文字链路进入同一
conversation；不存在「电话专用 conversation」。
