# Siren Voice MCP

端点：`POST /mcp`（Streamable HTTP，stateless JSON 模式；公网 `https://voice.example.invalid/mcp`）。

- 配置 `SIREN_INTERNAL_TOKEN` 后需要 `Authorization: Bearer <token>`。
- MCP 与 REST 共用同一个 `VoiceService`，能力与行为完全一致。
- GET / DELETE（SSE 会话管理）在 stateless 模式下返回 405。

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
