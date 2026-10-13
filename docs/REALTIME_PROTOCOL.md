# Siren 实时协议 v2：关联输入与语音打断扩展

协议号保持2。新客户端先协商voice_interrupt；未协商的旧客户端继续使用原start/end/abort手动流程。协商成功后不能用重复ready降级成无身份操作。

## 建立与音频

POST /v1/calls必填conversation_id，token冻结conversation/voice profile。WS为/ws/call/:callId?token=...。上行PCM16/16kHz/mono；下行PCM16默认24kHz，每帧rate为准。

关闭码：4001无效/吊销token、4002相同call重放、4004非法消息、4005背压、4006实际并发容量已满。预签token不占活跃连接许可，createSession才检查并占位。

## 协商与输入

```json
{"t":"ready","protocol":2,"capabilities":{"playback_drain":true,"stream_identity":true,"voice_interrupt":true}}
```

server ready含protocol/audio、capabilities.voice_interrupt、vad（confirm_ms/min_speech_ms/end_silence_ms/rms_ratio）与jitter_ms。客户端等待ready后才启动采集，不能在协商未知时先发legacy start。

| Client消息 | 语义 |
|---|---|
| start + input_id | 首个输入；ID为1–128字符、通话内不可复用 |
| end + input_id | 提交当前输入 |
| abort + input_id + 可选playback | 只取消目标输入/回复，不自动开新ASR |
| interrupt + target_input_id + new_input_id + 可选playback | 原子作废目标旧轮并装配新input/prebuffer；不等旧上游清理完成 |
| playback_drained + stream_id | 客户端该流已排空，按原协议处理 |
| ping | 保活 |

playback形如{"stream_id":"out_...","played_ms":123}，必须finite且非负，只有与被取消输出匹配时才标client_reported；缺失/不匹配为unknown，不当作精确已听文本。

服务端立即回复{"t":"input_started","input_id":"..."}。这不是供应商ASR ready；PCM进入prebuffer。当前同ID的重复start/interrupt只重发ACK，不重建ASR；更早退役ID及过期target不能取消/重启新轮。无活跃turn时仅允许针对最近一个已知input的交接。

当前客户端ACK前缓冲最多256KiB、最多等待5s；超限/拒绝/超时中止并提示重呼叫。end在已缓存PCM之后发送。服务端ASR final/timeout/空结果为不同终态。

## 下行身份与播放

协商后的state/partial/asr/reply/pcm/pcm_end/interrupted/metrics/notice/error携带input_id；连接级ready/pong例外。客户端先按input_id过滤，再处理stream_id；所以thinking中迟到的旧首帧不能被当作新stream播放。

每个PCM二进制帧之前都有JSON头：

```json
{"t":"pcm","input_id":"in_...","stream_id":"out_...","sequence":0,"rate":24000,"bytes":960}
```

header+下一binary按序配对。无头、长度不符、旧input、已取消stream、重复sequence丢弃；gap记录并继续。被拒旧PCM头也会清理待配对头，不能把其binary错配到新流。

## 本地确认与原子交接

1. 候选音频一直保留；自然模式确认近端讲话后，先切换允许的input身份并作废旧输出，再stopAll。
2. 发送interrupt，等待新input_started后按序flush候选PCM；旧Core/TTS清理独立进行。
3. 旧partial/final/state/PCM、旧abort与drained ACK不能覆盖新input；旧记录/metrics只有一次终态。
4. 手动徽章使用同一作废/取消入口。静音或切PTT清除待恢复意图；PTT没有新按压不发送。

ENDING新起声采用替换政策：取消旧ASR并开始独立输入，不自动拼接两句。旧轮已收到的partial仅保留为未定稿interrupted记录；迟到final被隔离。没有完整final时不声称旧句已完整转写。

## VAD、参考回声与缓冲

VAD确认默认200ms；minSpeech默认400ms，用于结束后判断有效短句，不能拖慢起声确认；结束静音700ms、RMS ratio4、jitter350ms。合法0值不被默认值吞掉。候选期冻结参数，下一候选应用新值。

pre-roll至少400ms，按合法确认窗口+余量+触发块增长（最大3s）；确认参数有界。回声参考只辅助检测，送入ASR的候选保留原浏览器AEC处理后的mic样本，避免晚确认删除首段。

AudioContext在呼叫点击手势内resume。播放总线同时连接实际输出与AudioWorklet参考输入；采集graph输出静音以保持处理。辅助相关性模型每20ms分析一次、用有界历史估计单延迟参考残差；它不是经过多路径/非线性设备标定的完整AEC。纯回声、强/弱近端叠加有合成测试，iPhone真实外放尚未验收。

## Drain、播放事实与Core

pcm_end加本地播放节点排空才发送playback_drained；服务端默认4s兜底。服务端回listening不等于本地必已播完，客户端仍可作废旧排队音频。打断的流不再要求drain；旧ACK不写第二份completed结果。

Core请求保持同一conversation，可附：

```json
{"interrupted_turn":{"turn_id":"...","input_id":"...","output_stream_id":"...","playback":{"basis":"client_reported","played_ms":123}}}
```

这是客户端观察，不是用户实际听见的保证；没有字音对齐，不按时长裁出精确已听正文。实际Core是否采用此字段需真实接入验证。Core done立即结束应用流并取消/释放HTTP body/reader；取消也必须传播到批量和流式TTS。

notice包括empty_transcript；error包括asr_failed/asr_timeout/audio_budget_exceeded/tts_failed/core_failed及输入身份错误。批量fallback仅零PCM输出时允许；部分PCM后不整句重播。Core失败的已收原文从统一reply出口发布一次。

## 验收范围

本地四轮联动已覆盖thinking抢话→speaking抢话→手动取消→再次语音输入，逐轮非零PCM与final、迟到旧首帧、ACK顺序及旧状态隔离。设备可听停播延迟、iPhone外放误触发率、真实后继轮识别和真实Core历史仍NOT_EXECUTED，不能用mock替代。
