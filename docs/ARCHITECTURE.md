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
| Playground | `/playground/` |

Cloudflare Tunnel：`voice.example.invalid → http://127.0.0.1:8790`。

## 3. Monorepo 模块

| 模块 | 职责 |
|---|---|
| `packages/contracts` | 全部跨模块协议（Provider 接口、WS 消息、MCP schema、事件） |
| `packages/audio` | PCM/重采样/时长/WAV 工具 |
| `packages/telemetry` | 结构化日志（脱敏）+ 延迟采集 |
| `packages/storage` | SQLite（voice_assets / call_sessions / call_turns）+ R2 / 本地对象存储 |
| `packages/core-bridge` | 对接Peer Core（HttpCoreBridge / MockCoreBridge） |
| `packages/providers/volc-asr` | 火山批量（auc one-shot）+ 流式（v2 sauc）识别 |
| `packages/providers/volc-tts` | 火山批量合成 + 句子级流水线流式合成 |
| `packages/providers/elevenlabs-tts` | ElevenLabs 可替换 TTS |
| `packages/providers/mock` | 开发 / 测试 Mock |
| `packages/voice-core` | VoiceService、CallSession、状态机、切句、Filler、Token、配置 |
| `apps/server` | Fastify 应用（REST + WS + MCP） |
| `apps/playground` | 独立语音测试页 |

## 4. 关键设计约束

1. **MCP 与 REST 复用同一个 `VoiceService`** —— `apps/server` 的路由与 MCP 工具都只做参数翻译，不写业务逻辑。
2. **Provider 全部通过 Adapter** —— 业务层只见 `AsrProvider` / `TtsProvider` 接口；火山、ElevenLabs 细节封在各 provider 包内。
3. **CallSession 显式状态机** —— `IDLE → LISTENING → ENDING → THINKING → SPEAKING → LISTENING`；打断 `SPEAKING → INTERRUPTING → LISTENING`。
4. **Barge-in 真正取消** —— `abort` 会：取消 Core 流（`core.cancel(turnId)`）、中止 TTS 迭代（AbortController + turn.aborted 检查）、停止后续 PCM 下发、通知浏览器清空播放队列（`interrupted` 帧）、保留已真正播出的文本、立刻回到 LISTENING。
5. **ASR prebuffer** —— 每次讲话新建 ASR 会话；建连期间 PCM 进 prebuffer，ready 后先补发再实时转发，保证不丢句首。
6. **聊天历史唯一真源在 Core** —— Siren 的 `call_turns` 只是通话元数据（含延迟指标），不是第二套聊天历史。
7. **降级链** —— Streaming TTS 失败 → Batch TTS（PCM）→ 若仍失败保留文字消息（`reply` 帧照发）；ASR 失败明确报错，绝不猜内容。

## 5. 数据

- SQLite（`data/siren.db`，WAL）：`voice_assets`（message_id 唯一索引支持幂等）、`call_sessions`、`call_turns`。
- 对象存储：配置 R2_* 时用 Cloudflare R2（private + presigned URL）；否则回退本地磁盘 `data/objects/`，通过 `/v1/assets/*` 的 HMAC 签名 URL 代理，访问模型与 R2 一致。
- Object Key：`voice/{YYYY}/{MM}/{conversation_id}/{message_id}/audio.{mp3|wav}` + `meta.json`；filler 在 `fillers/{profile}/{category}`。
- 实时 PCM 默认不落对象存储，只保存 transcript 与指标。

## 6. 安全

- 浏览器永远拿不到 `VOLC_ACCESS_TOKEN` / `ELEVENLABS_API_KEY` / `R2_SECRET` / `CORE_API_TOKEN`。
- `SIREN_INTERNAL_TOKEN` 配置后，`/v1/*`（除签名资源）与 `/mcp` 需要 Bearer。
- 实时通话必须 `POST /v1/calls` 换短生命周期 token（默认 120s），WS 握手校验且绑定 call_id。
- 日志脱敏：token/secret/key/authorization/cookie 一律 `[redacted]`；文本内容默认不落日志（`LOG_TRANSCRIPTS=false`）。
- 上传走 UUID 临时文件 + 大小限制 + 用后即删 + 启动清扫；对象 key 与资源路由均有路径穿越防护。

## 7. 生命周期

启动：加载 `.env` → 建目录 → 清理过期临时文件 → 生产配置校验（Mock 禁入生产）→ 打开 SQLite（自动迁移）→ 监听。

关停：SIGINT/SIGTERM → `CallCenter.destroyAll()`（逐会话 destroy：取消 ASR/LLM/TTS）→ Fastify close → SQLite close。
