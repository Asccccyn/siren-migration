# Provider 说明

所有 Provider 通过 `@siren/contracts` 的接口隔离，业务层不感知供应商：

```ts
interface AsrProvider { transcribe(input): Promise<TranscriptResult>; createStream(options, handlers): Promise<AsrStream> }
interface TtsProvider { synthesize(request): Promise<TtsAudioResult>; synthesizeStream(request): AsyncIterable<PcmChunk> }
```

选择由环境变量控制：`ASR_PROVIDER` / `ASYNC_TTS_PROVIDER` / `REALTIME_TTS_PROVIDER`（volc | elevenlabs | mock）。

开发环境缺少凭据时自动回退 Mock 并打警告；**生产环境直接拒绝启动**（`SIREN_ALLOW_MOCK_IN_PRODUCTION=true` 才能豁免，仅限调试）。

## 火山 ASR（packages/providers/volc-asr）

- **批量**：`POST {VOLC_ASR_BATCH_URL}`（默认 `https://openspeech.bytedance.com/api/v1/auc`，大模型 one-shot），Header `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id`（默认 `volc.bigasr.auc.duration`）/ `Authorization: Bearer;{token}`，audio.data 为 base64。
- **流式**：`wss://openspeech.bytedance.com/api/v2/asr`（v2 sauc 协议），帧格式 `[4B 大端 header 长度][header JSON][payload]`，首帧 sequence=1 携带完整请求，末帧负 sequence；`show_utterances` 拿 `definite` 区分 partial/final。
- 端点与资源 ID 均可用 `VOLC_ASR_WS_URL` / `VOLC_ASR_BATCH_URL` / `VOLC_ASR_BATCH_RESOURCE_ID` 覆盖；协议编解码集中在 `protocol.ts`，调整协议只改一个文件。
- 上游协议若与我实现有出入（官方迭代较快），只需修改 `protocol.ts` / `batch.ts` 的字段名，不影响任何业务代码。

## 火山 TTS（packages/providers/volc-tts）

- **批量**：`POST {VOLC_TTS_URL}`（默认 `https://openspeech.bytedance.com/api/v1/tts`），`app{appid,token,cluster}` + `audio{voice_type,encoding,speed_ratio,emotion...}` + `request{reqid,text,operation:query}`；code=3000 成功，`data` 为 base64 音频，`duration` 为秒。
  - 异步链路 `encoding=mp3`；实时兜底 `encoding=pcm` + `sample_rate=24000`。
- **流式（v1 实现策略）**：按“句子粒度批量合成 + 深度 1 预取流水线”实现 `synthesizeStream`——CallSession 在上一句播放期间启动下一句合成，首句延迟 = 单句 HTTP 合成耗时，听感等价流式协议。后续若切换火山 v3 双向流式 WebSocket（`bidirectionaltts`），只需替换 `stream.ts`，接口不变。
- **情绪映射**：`voice-map.ts` 的 `DEFAULT_EMOTION_MAP`（warm→降速、happy→emotion=happy 等），可被 voice profile 的 `emotionMap` 逐项覆盖。音色 ID 只来自 profile / `VOLC_VOICE_ID`。

## ElevenLabs（packages/providers/elevenlabs-tts）

- 批量 `output_format=mp3_44100_128`；流式 `output_format=pcm_24000`（PCM16 24k mono）。
- 情绪映射到 `voice_settings`（stability / style）；语速通过 stability 间接微调。
- 需要 `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`。

## Mock（packages/providers/mock）

- `MockAsrProvider`：可脚本化 partials/final/failEnd；feed 计数字节。
- `MockTtsProvider`：按文本长度生成正弦 PCM（60ms/字）；`faults` 注入流式/批量失败用于验证降级链。

## 新增 Provider 步骤

1. 新建 `packages/providers/<name>`，实现 `AsrProvider` 或 `TtsProvider`；
2. 在 `provider-registry.ts` 注册环境变量分支；
3. 在 voice profile JSON 中把 `provider` 指向它；
4. 无需改动任何业务代码。
