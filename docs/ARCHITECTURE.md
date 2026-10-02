# Siren 架构说明

> Siren 是对方的耳朵和嘴巴，不是第二个对方。

## 1. 定位

Siren 是独立语音能力层，只负责：

- ASR（批量 / 流式）
- TTS（批量 / 流式）
- 异步语音消息（语音条）
- 实时语音通话（WebSocket）
- 音频资产管理（R2 / SQLite）
- MCP 语音工具

它**不负责**：对方人格、长期记忆、Agent 决策、身份、主聊天历史真源、业务级工具调用逻辑。

```
                    Peer Core
          人格 / LLM / 记忆 / 对话 / 工具
                        │
            ┌───────────┴───────────┐
       Async Voice             Realtime Call
        Voice MCP                WebSocket
       Batch ASR/TTS          Stream ASR/TTS
            └───────────┬───────────┘
                  Siren Voice Core
```

## 2. 单进程部署

v1 只有一个 Node 进程（`apps/server`），统一挂载：

| 能力 | 入口 |
|---|---|
| REST | `/v1/voice/*`、`/v1/calls` |
| MCP（Streamable HTTP） | `POST /mcp` |
| 实时通话 | `/ws/call/:callId` |
| Health | `GET /health` |
| 资源代理（本地存储模式） | `/v1/assets/*` |
| Web（唯一入口页资源） | `/assets/*` |

Cloudflare Tunnel：`voice.example.invalid → http://127.0.0.1:8790`。

## 3. Monorepo 模块

| 模块 | 职责 |
|---|---|
| `packages/contracts` | 全部跨模块协议（Provider 接口、RealtimeVoiceProvider、WS 消息、MCP schema、事件） |
| `packages/audio` | PCM/重采样/时长/WAV 工具 |
| `packages/telemetry` | 结构化日志（credential 词段脱敏 + 指标白名单）+ 延迟采集 |
| `packages/storage` | SQLite（voice_assets / call_sessions / call_turns）+ R2 / 本地对象存储 |
| `packages/core-bridge` | 对接Peer Core（HttpCoreBridge / MockCoreBridge） |
| `packages/providers/volc-asr` | 火山批量（auc one-shot）+ 流式（v3 sauc 大模型）识别 |
| `packages/providers/volc-tts` | 火山批量合成 + v3 双向流式（bidirection）合成 |
| `packages/providers/elevenlabs-tts` | ElevenLabs 可替换 TTS（显式格式映射 + /stream 流式） |
| `packages/providers/mock` | 开发 / 测试 Mock |
| `packages/voice-core` | VoiceService、CallSession、状态机、切句、Filler、Token、配置、ReplyPipeline、CascadeRealtimeProvider |
| `apps/server` | Fastify 应用（REST + WS + MCP） |
| `apps/web` | 唯一入口页客户端（pre-roll / 本地 barge-in / stream router 均在此层） |

## 4. 关键设计约束

1. **MCP 与 REST 复用同一个 `VoiceService`** —— `apps/server` 的路由与 MCP 工具都只做参数翻译，不写业务逻辑。
2. **Provider 全部通过 Adapter** —— 业务层只见 `AsrProvider` / `TtsProvider` 接口；火山、ElevenLabs 细节封在各 provider 包内。
3. **CallSession 显式状态机** —— `IDLE → LISTENING → ENDING → THINKING → SPEAKING → LISTENING`（正常结束 speaking→listening 直达）；`interrupting` 只用于真实打断。
4. **Barge-in 三层取消** —— ① 浏览器本地立即停播（VAD start + AI 活跃 → stopAll + abort 帧，不等网络往返）；② 服务端取消（core.cancel、作废输出流、清 pipeline、回 LISTENING）；③ Provider 正式 abort（turn 级 AbortSignal 立即终止火山双向流式连接 / ElevenLabs fetch）。保留已真正播出的文本。
5. **双重句首保护** —— 客户端 400ms pre-roll ring（VAD 判定窗口内音频随 start flush）+ 服务端 ASR prebuffer（建连期间补发）。
6. **聊天历史唯一真源在 Core** —— Siren 的 `call_turns` 只是通话元数据（含延迟指标），不是第二套聊天历史。电话必须绑定网页当前 conversation（POST /v1/calls 必填 conversation_id，token 冻结，callId ≠ conversationId）。
7. **降级链** —— Streaming TTS 失败 → Batch TTS（PCM，真实采样率）→ 若仍失败保留文字消息（`reply` 帧照发）；ASR 失败明确报错，绝不猜内容。
8. **下行 Stream Identity（协议 v2）** —— 每轮 TTS 输出独立 `output_stream_id`；每个二进制帧前有 `{t:pcm, stream_id, sequence, rate, bytes}` 头；旧流迟到 chunk 丢弃、被打断流不复活；`playback_drained` 基于真实播放结束，服务端 4s 超时兜底。
9. **采样率全链路保留** —— Provider chunk 携带真实 sampleRate；`pcm` 头 rate 与二进制帧一致；ready 帧的 audio 契约来自 RealtimeVoiceProvider 边界。
10. **幂等与 fail-closed** —— voice_assets 的 object key 含 asset_id（并发同 message_id 落败者不会误删 winner 对象）；生产启动强制 SIREN_INTERNAL_TOKEN + 显式 SIREN_SIGNING_SECRET + R2 半配置阻断（SIREN_ALLOW_MOCK_IN_PRODUCTION 只豁免 mock provider）。
11. **Provider 边界** —— CallCenter 经 `CascadeRealtimeProvider`（流式 ASR + 流式 TTS 组合）装配会话；未来 speech-to-speech 模型实现 `RealtimeVoiceProvider` 即可整体替换，CoreBridge / conversation 所有权不动。

## 5. 数据

- SQLite（`data/siren.db`，WAL）：`voice_assets`（message_id 唯一索引支持幂等）、`call_sessions`、`call_turns`。
- 对象存储：配置 R2_* 时用 Cloudflare R2（private + presigned URL）；否则回退本地磁盘 `data/objects/`，通过 `/v1/assets/*` 的 HMAC 签名 URL 代理，访问模型与 R2 一致。
- Object Key：`voice/{YYYY}/{MM}/{conversation_id}/{message_id}/audio.{mp3|wav}` + `meta.json`；filler 在 `fillers/{profile}/{category}`。
- 实时 PCM 默认不落对象存储，只保存 transcript 与指标。

## 6. 安全

- 浏览器永远拿不到 `VOLC_ACCESS_TOKEN` / `ELEVENLABS_API_KEY` / `R2_SECRET` / `CORE_API_TOKEN`。
- `SIREN_INTERNAL_TOKEN` 配置后，`/v1/*`（除签名资源）与 `/mcp` 需要 Bearer；生产环境未配置直接拒绝启动。
- 实时通话必须 `POST /v1/calls` 换短生命周期 token（默认 120s），WS 握手只认 call_id + token；conversation / voice profile 在创建时冻结进 token，握手参数不可改写。
- 日志脱敏（v1.1）：按 credential 词段精确匹配（camelCase 归一化），延迟指标白名单（llm_first_token_ms / token_count / input_tokens / output_tokens / max_tokens）不误伤，真实 token 类字段全部 `[redacted]`；文本内容默认不落日志（`LOG_TRANSCRIPTS=false`）。
- 上传走 UUID 临时文件 + 大小限制 + 用后即删 + 启动清扫；对象 key 与资源路由均有路径穿越防护；multipart 音频格式按文件 part 自身 mimetype 推断。

## 7. 生命周期

启动：加载 `.env` → 建目录 → 清理过期临时文件 → 生产配置校验（Mock 禁入生产）→ 打开 SQLite（自动迁移）→ 监听。

关停：SIGINT/SIGTERM → `CallCenter.destroyAll()`（逐会话 destroy：取消 ASR/LLM/TTS）→ Fastify close → SQLite close。
