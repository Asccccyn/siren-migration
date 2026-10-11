# Siren Voice MCP

端点：`POST /mcp`（Streamable HTTP，stateless JSON 模式；公网 `https://voice.example.invalid/mcp`）。

- 鉴权双轨：**静态 `SIREN_INTERNAL_TOKEN` Bearer**（机器直连）**或 MCP OAuth 2.1**（见下节），两者同权共存。
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
- 令牌只接受严格规范编码（等价签名变体一律拒收），OAuth access 与静态 token 在 `/v1/*` 与 `/mcp` 同权。

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
  "format": "mp3"
}
```

## voice_transcribe

输入 `audio_url`（http/https，≤25MB，30s 超时）或 `object_key`。

返回 `{"text","language","duration_ms"}`。ASR 失败明确报错，不猜内容。

## voice_get

输入 `voice_message_id` 或 `message_id`，返回资产元数据 + 新签名的 `audio_url`。

## voice_list

支持 `conversation_id` / `message_id` / `from` / `to` / `limit`（ISO 时间），返回 `{"items":[...]}`。

## 错误约定

工具失败时返回 `isError: true`，content 为 JSON：

```json
{ "error": "invalid_input" | "asr_failed" | "tts_failed" | "not_found", "details"?: [...] }
```
