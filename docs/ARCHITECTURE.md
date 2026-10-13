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
| `apps/server` | Fastify应用、REST/WS/MCP、OAuth注册/授权/可靠撤销、维护者授权管理 |
| `apps/web` | 候选语音、VoiceTurnCoordinator、播放参考残差、stream router与播放进度；协商后可语音打断 |

## 4. 关键设计约束

1. **MCP 与 REST 复用同一个 `VoiceService`** —— `apps/server` 的路由与 MCP 工具都只做参数翻译，不写业务逻辑。
2. **Provider 全部通过 Adapter** —— 业务层只见 `AsrProvider` / `TtsProvider` 接口；火山、ElevenLabs 细节封在各 provider 包内。
3. **CallSession 显式状态机** —— `IDLE → LISTENING → ENDING → THINKING → SPEAKING → LISTENING`（正常结束 speaking→listening 直达）；`interrupting` 只用于真实打断。
4. **关联语音打断** —— 客户端先作废旧input/输出再停播，服务端按目标身份幂等取消并接纳新ASR；旧清理不挡新输入。TTS批量/流式均传播signal，火山session CancelSession不误杀共享连接。Core原文、已发送句子与客户端播放进度分开，不冒称已听。
5. **双重句首保护** —— 客户端按候选确认窗增长的有界pre-roll，ACK后按序提交；服务端ASR prebuffer覆盖建连期。minSpeech用于结束有效性，不延长打断确认。
6. **聊天历史唯一真源在 Core** —— Siren 的 `call_turns` 只是通话元数据（含延迟指标），不是第二套聊天历史。电话必须绑定网页当前 conversation（POST /v1/calls 必填 conversation_id，token 冻结，callId ≠ conversationId）。
7. **降级链** —— 零PCM的ProviderError允许一次Batch fallback，signal贯通上游；已有PCM不重播。失败仍保留已收到文本；原生stream错误会明确失败，不冒称所有错误都触发batch。
8. **下行 Stream Identity（协议 v2）** —— 每轮 TTS 输出独立 `output_stream_id`；每个二进制帧前有 `{t:pcm, stream_id, sequence, rate, bytes}` 头；旧流迟到 chunk 丢弃、被打断流不复活；`playback_drained` 基于真实播放结束，服务端 4s 超时兜底。
9. **采样率全链路保留** —— Provider chunk 携带真实 sampleRate；`pcm` 头 rate 与二进制帧一致；ready 帧的 audio 契约来自 RealtimeVoiceProvider 边界。
10. **幂等与 fail-closed** —— voice_assets 的 object key 含 asset_id（并发同 message_id 落败者不会误删 winner 对象）；生产启动强制 SIREN_INTERNAL_TOKEN + 显式 SIREN_SIGNING_SECRET + R2 半配置阻断（SIREN_ALLOW_MOCK_IN_PRODUCTION 只豁免 mock provider）。
11. **Provider 边界** —— CallCenter 经 `CascadeRealtimeProvider`（流式 ASR + 流式 TTS 组合）装配会话；未来 speech-to-speech 模型实现 `RealtimeVoiceProvider` 即可整体替换，CoreBridge / conversation 所有权不动。

## 5. 数据

- SQLite（`data/siren.db`，WAL）：`voice_assets`（message_id 唯一索引支持幂等）、`call_sessions`、`call_turns`。
- 对象存储：配置 R2_* 时用 Cloudflare R2（private + presigned URL）；否则回退本地磁盘 `data/objects/`，通过 `/v1/assets/*` 的 HMAC 签名 URL 代理，访问模型与 R2 一致。
- Object Key：`voice/{YYYY}/{MM}/{conversation_id}/{message_id}/{asset_id}/audio.{ext}`及仅投递元数据的meta.json。filler位于fillers/{profile}/{category}，manifest记录来源与完成态。
- 实时 PCM 默认不落对象存储，只保存 transcript 与指标。

## 6. 安全

- 浏览器永远拿不到 `VOLC_ACCESS_TOKEN` / `ELEVENLABS_API_KEY` / `R2_SECRET` / `CORE_API_TOKEN`。
- 受保护语音API接受静态Bearer/OAuth；web/login、OAuth发现/授权按各自门控。OAuth客户端管理仅静态维护者token；签名资源独立验证。生产缺token/签名密钥拒绝启动。
- 实时通话必须 `POST /v1/calls` 换短生命周期 token（默认 120s），WS 握手只认 call_id + token；conversation / voice profile 在创建时冻结进 token，握手参数不可改写。
- 日志脱敏（v1.1）：按 credential 词段精确匹配（camelCase 归一化），延迟指标白名单（llm_first_token_ms / token_count / input_tokens / output_tokens / max_tokens）不误伤，真实 token 类字段全部 `[redacted]`；文本内容默认不落日志（`LOG_TRANSCRIPTS=false`）。
- 上传走 UUID 临时文件 + 大小限制 + 用后即删 + 启动清扫；对象 key 与资源路由均有路径穿越防护；multipart 音频格式按文件 part 自身 mimetype 推断。

## 7. 生命周期

启动：加载 `.env` → 建目录 → 清理过期临时文件 → 生产配置校验（Mock 禁入生产）→ 打开 SQLite（自动迁移）→ 监听。

关停：SIGINT/SIGTERM → `CallCenter.destroyAll()`（逐会话 destroy：取消 ASR/LLM/TTS）→ Fastify close → SQLite close。

## 8. 数据与运行边界（1012）

SQLite新正文/转写/供应商音色ID字段加密，旧明文只兼容读取不自动迁移；data_unreadable明确失败且不覆写原密文。新meta不重复存正文，音频本体与历史备份不在字段加密范围。密钥轮换与历史迁移必须独立可恢复维护。

OAuth撤销立即内存拒绝并等待串行原子写完成才应答；文件损坏/不可读使初始化失败，首次无文件允许初始化。删除/回滚状态文件会改变安全状态，运维不得把它当无损重置。本设计为单进程，不宣称多实例或断电恢复验收。

语音打断源码和本地协议验证已实现；外放声学与真实设备未验收。客户端仅显示协商得到的模式；不支持时为明确手动兼容模式。Core与设备的真实表现不由源码存在推断。
