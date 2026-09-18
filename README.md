# Siren v1.1（Realtime Hardening）

> Siren 是对方的耳朵和嘴巴，不是第二个对方。
> 独立语音能力层：ASR / TTS / 异步语音消息 / 实时通话 / MCP。
> v1.1：实时通话链路强化（pre-roll 首音保护 / 本地 barge-in / 下行流标识 /
> playback_drained / 共享 conversation / 火山 v3 双向流式协议 / 幂等与 fail-closed）。

## 快速开始

```bash
# 0) 环境：Node >= 20，pnpm >= 9
corepack enable   # 或 npm i -g pnpm

# 1) 安装
pnpm install

# 2) 配置（可选：无凭据时自动使用 Mock，开箱即用）
copy .env.example .env   # Windows；Linux/macOS 用 cp

# 3) 构建（server bundle + playground 页面）
pnpm build

# 4) 开发模式（热重载）
pnpm dev

# 5) 生产启动
pnpm start
```

打开 <http://127.0.0.1:8790/playground/> 即可测试异步语音（录音转写 / 文字合成）与实时通话。

- 健康检查：`GET http://127.0.0.1:8790/health`
- MCP 端点：`POST http://127.0.0.1:8790/mcp`（Streamable HTTP，stateless JSON）
- 实时通话 WS：`POST /v1/calls` 换 token → `GET /ws/call/:callId?token=...`

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | tsx 热重载启动服务 |
| `pnpm build` | 构建 server（esbuild bundle）与 playground 页面 |
| `pnpm start` | 运行构建产物 `apps/server/dist/index.js` |
| `pnpm test` | Vitest 全量测试（28 个文件 / 162 个用例，含协议/并发/背压/审计回归专项） |
| `pnpm typecheck` | TypeScript 严格类型检查 |
| `pnpm lint` | ESLint |
| `pnpm fillers` | 预生成 filler 音频（`--mock` 用 Mock 音色） |
| `node scripts/ws-smoke.mjs` | 对运行中的服务做实时链路冒烟 |
| `pnpm cleanup:tmp` | 手动清理临时文件（启动时也会自动清理） |

## 配置火山引擎

`.env`：

```env
ASR_PROVIDER=volc
ASYNC_TTS_PROVIDER=volc
REALTIME_TTS_PROVIDER=volc
VOLC_APP_ID=你的AppID
VOLC_ACCESS_TOKEN=你的AccessToken
VOLC_ASR_RESOURCE_ID=volc.bigasr.sauc.duration      # 大模型流式识别资源（Seed ASR 用 volc.seedasr.sauc.duration）
VOLC_TTS_CLUSTER=volcano_icl
VOLC_TTS_RESOURCE_ID=volc.service_type.10029        # 双向流式 TTS 资源
VOLC_VOICE_ID=你的音色ID                             # 也可配在 config/voices/*.json
```

- 流式识别 = 大模型 sauc v3 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`（双向流式实时出字；`VOLC_ASR_WS_URL` 可换 `bigmodel_async` / `bigmodel_nostream`）。
- 实时合成 = v3 双向流式 `wss://openspeech.bytedance.com/api/v3/tts/bidirection`（文本流式输入、音频流式输出、连接复用多 session）。
- 批量识别默认走 one-shot `volc.bigasr.auc.duration`（`VOLC_ASR_BATCH_RESOURCE_ID` 可覆盖）。
- 端点可用 `VOLC_ASR_WS_URL` / `VOLC_ASR_BATCH_URL` / `VOLC_TTS_URL` / `VOLC_TTS_WS_URL` 覆盖；协议编解码集中在各 provider 的 `protocol.ts` / `bidirectional-protocol.ts` / `batch.ts`。
- 音色配置的唯一来源是 `config/voices/main.json`（`voiceId` 留空回退环境变量），业务代码没有写死的 Voice ID。
- 真实验收（可选）：`VOLC_REAL_INTEGRATION=1` + 凭据运行 `tests/volc-real-integration.test.ts`。

## 配置 Cloudflare R2

```env
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=siren-voice
```

- Bucket 必须 private；客户端只拿 presigned URL（`SIGNED_URL_TTL_S`，默认 1 小时）。
- 未配置 R2 时自动回退本地对象存储 `data/objects/`，通过 `/v1/assets/*` 的 HMAC 签名 URL 代理（访问模型与 R2 一致），生产环境会打警告。

## 接入Peer Core

Siren 不绑定任何 LLM；人格 / 记忆 / 对话历史 / 工具全部在 Core：

```env
SIREN_CORE_BRIDGE=http
CORE_BASE_URL=http://127.0.0.1:8000
CORE_API_TOKEN=...
```

Core 只需实现一个流式接口（NDJSON）：

```text
POST {CORE_BASE_URL}/v1/chat/stream
-> 200 application/x-ndjson
   {"type":"delta","text":"..."}   # 逐段文本
   {"type":"done"}
   {"type":"error","message":"..."}
```

请求体含 `conversation_id / call_id / turn_id / modality:"voice_call" / text`。
未配置 Core 时开发环境自动使用 `MockCoreBridge`（生产环境拒绝启动 Mock）。

## 接入聊天前端

1. **发语音消息**：浏览器 MediaRecorder（WebM/Opus）→ `POST /v1/voice/transcribe`（multipart，`store=true` 可存为 user 资产）→ 拿 transcript 走 Core 文字链路。
2. **收语音消息**：Agent 调 MCP `voice_speak`（或 REST）→ 返回 `audio_url`（签名 URL）+ `duration_ms` → 前端渲染语音气泡（transcript 折叠显示）。
3. **实时通话**：`POST /v1/calls`（`conversation_id` 必填：电话与网页文字共享同一 conversation）→ 用返回的 `ws_url + token` 建 WebSocket；上行 PCM16/16k，下行 PCM16/24k（每 chunk 真实 rate 在 `pcm` 头中）；协议 v2 细节见 `docs/REALTIME_PROTOCOL.md`（pre-roll、本地 barge-in、stream_id/sequence、playback_drained、ready 协商、VAD 参数、jitter buffer）。
4. 配置 `SIREN_INTERNAL_TOKEN` 后，`/v1/*`（除签名资源）与 `/mcp` 需要 `Authorization: Bearer <token>`。

## Playground

- **Async 页**：录音 → ASR → transcript；文字 + 情绪 + 语速 → TTS → 播放。
- **Realtime 页**：Call / Mute / Hang up，VAD 自动断句或按住说话，partial 字幕、final transcript、assistant 文本、PCM 连续时间轴播放（350ms 抖动缓冲可调）、状态徽章、延迟指标表、事件日志。
- 状态徽章可点击，在 thinking/speaking 时触发 barge-in。

## 测试

```bash
pnpm test
```

覆盖：Provider 抽象与生产守卫、VoiceService、MCP 输入校验（真实 MCP 协议）、REST 校验与鉴权、sentence splitter、call 状态机、cancel/abort（音频停止增长断言）、R2/本地对象存储（签名、过期、路径穿越）、SQLite 仓储（message_id 幂等）、WebSocket 协议 e2e（真实端口）、prebuffer、临时文件清理、TTS 流式失败降级、ASR 失败报错、过期 call token。

v1.1 新增专项：pre-roll ring、上行编排（首音保护/无重复块/本地 barge-in 顺序）、
下行流路由（旧流丢弃/sequence 重复/gap/被打断流不复活/drain）、conversation 连续性
（电话-文字共享、跨 call、隔离、重复 end、打断语义）、call token 上下文冻结
（4002 重放/吊销后 4001）、背压完整 teardown（无 zombie session）、abort 幂等、
采样率全链路（16k/24k/48k）、火山 v3 ASR 协议编解码与假服务器全流程、火山双向流式
TTS 事件流（连接复用/并发 session/abort/SessionFailed）、ElevenLabs 格式映射与
流式、message_id 并发幂等（winner 对象不丢）、生产 fail-closed 矩阵、日志脱敏
指标白名单、multipart part mimetype 推断。

## 目录结构

见 `docs/ARCHITECTURE.md`（模块职责、状态机、barge-in 语义、数据模型、安全模型）。
其他文档：`docs/MCP.md`、`docs/REALTIME_PROTOCOL.md`、`docs/PROVIDERS.md`。

## 已知限制（v1.1）

- 火山 Provider 已按 2026-09 官方协议实现（v3 sauc bigmodel / v3 tts bidirection），
  Mock 全绿但**未用真实火山凭据验证**——真实验收前只能视为
  `implementation complete / real-provider verification pending`。
- Call token 为进程内存存储（单进程 v1 设计；多实例部署时换 Redis）。
- 实时 PCM 不落存储（只存 transcript 与指标），完整通话录音留给后续 Recording 模块。
- Mock 的 MP3 以 WAV 容器承载（开发环境占位；生产必须配置真实 Provider）。
- 重连恢复（Reconnect/Resume Lease）、后台 Agent 并行、speech-to-speech 模型接入
  （Qwen Realtime / OpenAI / Gemini）为 v1.5 方向；本轮只留了 `RealtimeVoiceProvider`
  边界与协议能力位，未实现。
