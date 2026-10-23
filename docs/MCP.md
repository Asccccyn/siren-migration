# Siren Voice MCP

端点：`POST /mcp`（Streamable HTTP，stateless JSON 模式；公网 `https://voice.example.invalid/mcp`）。

- 鉴权双轨：**静态 `SIREN_INTERNAL_TOKEN` Bearer**（机器直连）**或 MCP OAuth 2.1**（见下节），两者在语音API共存；客户端管理API仅静态维护者token。
- MCP 与 REST 共用同一个 `VoiceService`，能力与行为完全一致。
- GET / DELETE（SSE 会话管理）在 stateless 模式下返回 405。

## OAuth 2.1 接入（不支持自定义 Bearer 的客户端用这条）

- 发现：`GET /.well-known/oauth-protected-resource` 与 `GET /.well-known/oauth-authorization-server`；
  `/mcp` 未带凭证的 401 附 RFC 9727 `WWW-Authenticate` 指针，标准客户端自动进入流程。
- 动态注册（RFC 7591）：`POST /oauth/register`（redirect_uris 必填，http/https、无 fragment；
  注册表落盘 `data/oauth-clients.json`，总量上限 200）。
- 授权码 + PKCE(S256)：`GET/POST /oauth/authorize`（密码门复用 `SIREN_WEB_PASSWORD`）→ 302 回调
  （经 URL 参数追加，保留回调自身 query）→ `POST /oauth/token` 换 access(1h) + refresh。
- 刷新令牌**一次性轮换**：每次刷新发新 refresh，旧 refresh 立即吊销（重放按 invalid_grant 拒绝）；
  吊销名单落盘 `data/oauth-revoked.json`，重启不复活。`POST /oauth/revoke` 按到期时间登记回收。
- 令牌只接受严格规范编码（等价签名变体一律拒收），OAuth access与静态token在语音API及/mcp放行；/v1/oauth/clients管理是明确例外。

## 客户端配置示例

```json
{
  "mcpServers": {
    "siren-voice": {
      "type": "http",
      "url": "https://voice.example.invalid/mcp",
      "headers": { "Authorization": "Bearer <SIREN_INTERNAL_TOKEN>" }
    }
  }
}
```

## voice_speak

对方文字回复 → 语音条（Batch TTS → R2 → voice_assets）。

输入：

```json
{
  "text": "你，我在。",
  "tts_script": "[softly] 你，我在。",
  "voice_profile": "main",
  "emotion": "warm",
  "conversation_id": "conv-1",
  "message_id": "msg-42",
  "language": "zh-CN",
  "speed": 1.0
}
```

- `text`（用户看到）与 `tts_script`（交给 TTS）必须分离。
- `message_id` 幂等：重复调用返回既有资产，不重复合成。

返回：

```json
{
  "voice_message_id": "...",
  "audio_url": "https://.../audio.mp3?...",
  "duration_ms": 2150,
  "format": "mp3",
  "text": "你，我在。"
}
```

## voice_transcribe

输入 `audio_url`（http/https，≤25MB，30s 超时）或 `object_key`。

返回 `{"text","language","duration_ms"}`。ASR 失败明确报错，不猜内容。

## voice_get

输入 `voice_message_id` 或 `message_id`，返回可读正文或转写、时长、方向、语言、格式、创建时间和新签名的 `audio_url`。返回的 `id` 可作为下一次 `voice_get.voice_message_id` 换取新 URL。TTS 脚本、音色参数与内部会话/消息关联留在存储及 REST UI，不进入此模型投影。

## voice_list

支持 `conversation_id` / `message_id` / `from` / `to` / `limit`（ISO 时间），返回 `{"items":[...]}`。

## 错误约定

工具失败时返回 `isError: true`，content 为 JSON：

```json
{ "error": "invalid_input" | "asr_failed" | "tts_failed" | "not_found", "details"?: [...] }
```

## 1012 持久状态与容量恢复

- revoke与refresh轮换成功前等待持久提交；写失败返回503，不能把新refresh作为成功发放。文件损坏/不可读拒绝初始化；仅缺文件按初始状态处理，维护时不得删除已部署撤销文件。关停等待写链。
- DCR：每IP每分钟10次、全局60次；body最大16KiB，1–8个URI/每个最多2048B，client_name最多256B。
- 新注册pending在24小时后过期，容量满时可回收最旧pending；授权过的客户端及旧版档案不自动淘汰。撤销限速每IP60/min、全局600/min。
- 维护者（静态SIREN_INTERNAL_TOKEN）可GET /v1/oauth/clients查看无secret清单，POST /v1/oauth/clients/:clientId/remove移除客户端。OAuth access不能访问这些管理接口；移除后该客户端AT/RT不再有效。
- voice_speak保留text字段供随仓播放器展开正文；结构化结果、文本content与UI meta的兼容负载仍保留，未为瘦身破坏消费者。
- voice_get/list/speak遇密文不可读返回isError及data_unreadable，不伪装成功空字段。REST相关读取返回503。
- audio_url下载在一次总期限内完成DNS、连接、重定向和body；DNS解析结果钉住实际连接，超时终止请求/流并让调用方落定。

## 2026-10-23 R3′：voice_get / voice_list 长正文分页（破坏性变更）

- `voice_get` 正文/转写按 1200 汉字/页投影：首次调用只回首页 + `text_page { index, total_pages, total_chars, next_cursor? }`；翻页带 `cursor`（上页 `next_cursor`）再调。**`text` 字段不再一次返回全文**（旧消费者若依赖全文须循环翻页拼回）。游标锚 checksum：资产不可变，翻页按 id 复取并校验，不符= `snapshot_stale` 如实报。
- `voice_list` 列表项正文只带 ≤120 字摘录 + `full_text_via`（提示用 voice_get 取全文）；输出新增 `next_cursor`（keyset：`(created_at, id)`，并发新增不进当前游标页——新消息由后续首次查询可见，不挤入进行中的翻页）。
- 两个工具的投影均带字节预算门（get 8192B；list 8192B×页大小上限），超预算如实报 `projection_over_budget`，不截断造绿。
- 背景：审计 SIR-U01（4000 字 get≈12340B 超预算无续读）——本变更为修复，当时无长正文消费者依赖（见 glm-root-cause-20261023/R3P_PAGINATION_PREMISE.md 消费者清单）。
