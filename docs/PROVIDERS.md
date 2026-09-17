# Provider 说明

所有 Provider 通过 `@siren/contracts` 的接口隔离，业务层不感知供应商：

```ts
interface AsrProvider { transcribe(input): Promise<TranscriptResult>; createStream(options, handlers): Promise<AsrStream> }
interface TtsProvider { synthesize(request): Promise<TtsAudioResult>; synthesizeStream(request, signal?): AsyncIterable<PcmChunk> }
```

选择由环境变量控制：`ASR_PROVIDER` / `ASYNC_TTS_PROVIDER` / `REALTIME_TTS_PROVIDER`（volc | elevenlabs | mock）。

开发环境缺少凭据时自动回退 Mock 并打警告；**生产环境直接拒绝启动**（`SIREN_ALLOW_MOCK_IN_PRODUCTION=true` 只豁免 mock provider 一组，不豁免 token / 签名 / R2 完整性检查）。

实时通话侧统一经 `RealtimeVoiceProvider` 边界（P1-1）：默认实现
`CascadeRealtimeProvider` 组合「流式 ASR + 流式 TTS」并显式声明
`inputSampleRate / outputSampleRate`；未来 speech-to-speech 模型
（Qwen Realtime / OpenAI / Gemini / 本地 S2S）实现同一接口即可接入，
CoreBridge 与 conversation 所有权不变。

## 火山 ASR（packages/providers/volc-asr）

- **批量**：`POST {VOLC_ASR_BATCH_URL}`（默认 `https://openspeech.bytedance.com/api/v1/auc`，大模型 one-shot），Header `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id`（默认 `volc.bigasr.auc.duration`）/ `Authorization: Bearer;{token}`，audio.data 为 base64。
- **流式（v1.1 按当前官方协议重写，P0-8）**：大模型流式识别 v3
  `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`（双向流式，实时出字；
  可用 `VOLC_ASR_WS_URL` 换 `bigmodel_async` 优化版 / `bigmodel_nostream` 多语种版）。
  - 鉴权走 HTTP header：`X-Api-App-Key`（APP ID）/ `X-Api-Access-Key`（AccessToken）/
    `X-Api-Resource-Id`（默认 `volc.bigasr.sauc.duration`，Seed ASR 为 `volc.seedasr.sauc.duration`）/
    `X-Api-Connect-Id`（每次连接 UUID）。
  - 二进制帧：`[4B header][payload size][gzip payload]`；首帧 full client request
    （JSON：app/user/audio/request），音频帧 audio-only（PCM16/16k，约 100ms/包），
    末帧 audio-only + last-packet flag；服务端 full response 带 sequence（负值=末包）。
  - `options` 真正生效：profile → `user.uid`；language → `audio.language`
    （仅多语种 `bigmodel_nostream` 端点携带）。
  - partial 覆盖式更新；`definite=true` 的 final 只提交一次（重复下发不重复拼接）。
  - 协议编解码集中在 `protocol.ts`；上游字段若调整只改该文件。
- 真实验收：`VOLC_REAL_INTEGRATION=1` + 凭据运行 `tests/volc-real-integration.test.ts`。

## 火山 TTS（packages/providers/volc-tts）

- **批量**：`POST {VOLC_TTS_URL}`（默认 `https://openspeech.bytedance.com/api/v1/tts`），`app{appid,token,cluster}` + `audio{voice_type,encoding,speed_ratio,emotion...}` + `request{reqid,text,operation:query}`；code=3000 成功。异步链路 `encoding=mp3`；实时兜底 `encoding=pcm` + 真实 sample_rate。
- **实时（v1.1 重写为真 provider-level streaming，P0-9）**：v3 双向流式
  `wss://openspeech.bytedance.com/api/v3/tts/bidirection`（事件驱动：
  StartConnection → StartSession(speaker/audio_params) → TaskRequest(text 流式输入)
  → TTSResponse(音频流式输出) → FinishSession）。
  - Header 鉴权同 ASR v3；资源 ID `VOLC_TTS_RESOURCE_ID`（默认 `volc.service_type.10029`）。
  - 连接复用：一条 WebSocket 承载多个 session（按 session id 多路复用），
    句间无需重新握手；断线自动丢弃、下次重建。
  - `synthesizeStream(request, signal)`：AbortSignal 立即 terminate 连接
    （barge-in 不再后台烧 TTS）；chunk 携带真实 sampleRate（P0-7）。
  - 情绪映射：`voice-map.ts` 的 emotion / emotion_scale 进入 `audio_params`；
    语速映射为 `speech_rate`（[-50,100]）；音色 ID 只来自 profile / `VOLC_VOICE_ID`。
- 旧的「句子级批量 + 预取」假流式实现已删除。

## ElevenLabs（packages/providers/elevenlabs-tts）

- 批量格式显式映射（P1-2）：`mp3 → mp3_44100_128`（如实返回 mp3/44100）；
  `wav/pcm → pcm_{rate}`（ElevenLabs 无 wav 输出，如实返回 pcm + 正确 MIME）；
  不支持的 pcm 采样率抛 `unsupported_format`，不伪装。
- 流式：官方 `/v1/text-to-speech/{id}/stream` 端点 + 响应体增量读取
  （provider 端流式；pcm_24000），AbortSignal 透传 fetch。
- 情绪映射到 `voice_settings`；需要 `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`。

## Mock（packages/providers/mock）

- `MockAsrProvider`：可脚本化 partials/final/failEnd；feed 计数字节。
- `MockTtsProvider`：按文本长度生成正弦 PCM（60ms/字）；`faults` 注入流式/批量失败
  用于验证降级链；`synthesizeStream` 尊重 AbortSignal（取消即抛错）。

## 新增 Provider 步骤

1. 新建 `packages/providers/<name>`，实现 `AsrProvider` 或 `TtsProvider`
   （实时语音整体替换则实现 `RealtimeVoiceProvider`）；
2. 在 `provider-registry.ts` 注册环境变量分支；
3. 在 voice profile JSON 中把 `provider` 指向它；
4. 无需改动任何业务代码。
