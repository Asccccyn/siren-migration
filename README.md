# Siren v1.1.1（1012 根因返修 + 可语音打断实现）

- 2026-10-27（工作树修复，**未部署**）：通话音频清单增加 `audio_finalized`，由现有会话与按 call_id 关联的收尾任务推导；WS 关闭后，取消回收及实际音频保存完成前保持 false，不新增持久状态或迁移。完整/部分/无音频收尾、既有生命周期回归及 est 联合反例通过，类型检查和服务构建通过。

- 2026-10-27（**已部署并启动**，代码 `6505648`，发布目录 `~/Projects/siren-releases/voice-backend-20261027`）：operation_id 合成/重放响应使用实际资产格式，继承取消贯穿、先持久后交付与同操作恢复。REST/MCP 15 项及类型检查通过；按现有构建脚本生成服务与客户端，数据库 v6。当前用既有 `node apps/server/dist/index.js` 命令以 nohup 运行在 8790，生产模式、健康 200；Core 已由误指向 oído:8791 修正为 est:18787，既有令牌的真实入口鉴权通过（空输入 422，零模型派发）。数据仍在 `~/Projects/siren/data`，日志 `~/Library/Logs/siren/voice-backend-20261027.log`；回退资料 `~/Backups/pre-voice-backend-20261027-160943`。真实 ASR/TTS 与设备效果未复验。

> Siren 是耳朵和嘴巴，不是第二个大脑。
> ASR / TTS / 异步语音 / 实时通话 / MCP；Core继续拥有人格、记忆与聊天历史。

当前客户端已实现**直接开口打断**：协商成功后，AI思考/播放期间确认近端语音，先在本地作废旧输出并停播，再取消旧轮、接纳新输入。手动徽章和PTT保留。服务端不支持新能力时明确显示“仅支持手动打断”。

**能力口径**：本地逻辑、合成回声、假Provider及回环协议已验证；iPhone外放、真实供应商的后继轮识别和真实Core中断语义本批未执行。实现代码不等于已经达到GPT语音的设备体验。详见 [交接记录](docs/HANDOFF_1012.md)。

## 当前基线与接手摘要

- 2026-10-24（第二追加，未部署）：A11 柔性挂断——requestHangup 立即回执→正文真实 drain→linger（默认 15s 可配）→新输入取消/到期 model_hangup(1000)；用户挂断即时；linger 为 notice 帧非媒体状态；/v1/calls/:id/hangup-request 服务间入口；soft-hangup 4 测试绿，405 绿。
- 2026-10-24（同分支追加，未部署）：协议①②——通话用户原声资产化（采纳后 PCM→WAV voice_assets，CoreTurnInput.audioRef 上桥，未装配缺省不阻断）+/v1/voice-assets/:id/audio 服务间取回+/v1/conversations/:id/invites 卡片数据源；call-audio-protocol 2 测试绿，401 绿。
- 2026-10-24（隔离分支，未部署）：GLM CallHome 执行轮——RE-16 列表/游标/回执预算收口（8192B 唯一总页合同+查询指纹快照游标+坏游标 isError+speak 模型面最小化单份）、RE-17 指标分母真实化（接纳轮不丢行/recognized=真实回复链/unknown=null+覆盖率/outcome 值域触发器）、B5 来电邀请持久状态（迁移004 call_invites：服务端过期回收+重启恢复+竞态单终态+declined≠expired）；探针 13/14（R7-01 v==3 快照断言被 004 取代、语义补充断言绿）；399 绿+2 跳过、tsc 0。
- 2026-10-23（分支 `audit-fix-joint-voice-20261023` 叠加，未部署）：R7 轮次终态批（她 D6 裁定）：migration 003 `call_turns.outcome`（历史行 NULL=unknown 不回填）；新写入区分 completed/interrupted/asr_failed/asr_timeout/core_failed/tts_failed/**asr_empty（中性，空转写轮如实落库不再丢弃）**；聚合脚本新增 outcome 分布与三口径分母（接纳轮=全部行/识别轮=回复链四值/asr_empty 单列不计故障）。全套 392 绿+2 跳过、tsc 0。设备/真实供应商维维持 NOT_EXECUTED。

2026-10-13 更新交接说明；本次仅维护文档，未重跑代码测试。

| 项目 | 当前记录 |
|---|---|
| 已交付代码 | `7dff481` 已合入本地 `main`，主仓本地构建已完成 |
| 上一份冻结记录 | `2849129`（1012 交接与协议文档）；本次文档提交见 `git log` |
| 已做改动 | 可语音打断与轮次隔离、取消/连接清理、OAuth 状态可靠提交、字段加密及错误语义、日志脱敏、Provider 配置边界 |
| 本地验证 | 2026-10-12 对上述代码：352 通过、2 跳过；typecheck / lint / build 通过 |
| 仍未全绿 | AST 未检出循环/跨层违规，但 42 条长度超限、10 条提示，退出码 1 |
| 部署与实机 | 本轮及上一实施轮未推送远端、未执行生产重启；现役版本未核实。iPhone 外放与真实 ASR / TTS / Core 验收未执行 |

接手先读 [实施交接](docs/HANDOFF_1012.md) 与 [实时协议](docs/REALTIME_PROTOCOL.md)，核对客户端 `client=1012-interrupt` 和服务端 `ready.capabilities.voice_interrupt`。配置、备份及部署窗口确认后，再按交接中的顺序申请生产与实机验证；仓库已更新不等于现役进程已加载新代码。

## 快速开始

Node >=20，pnpm >=9。先安装依赖，再复制模板；不要把配置模板中的空值当成可用登录配置。

```bash
pnpm install
cp .env.example .env
# 编辑 .env：填写自己的 SIREN_INTERNAL_TOKEN 与 SIREN_WEB_PASSWORD。
# 本地启动还需改为 SIREN_PUBLIC_URL=http://127.0.0.1:8790；不要保留模板占位域名。
# 本地开发可使用mock；生产还必须设置NODE_ENV=production、显式签名密钥、真实Provider与Core。
pnpm build
pnpm dev
# 已构建的服务使用 pnpm start
```

打开 http://127.0.0.1:8790/，密码登录后页内三标签：信箱、实时通话、异步语音。
`SIREN_WEB_PASSWORD`或`SIREN_INTERNAL_TOKEN`未设置时登录返回503。

- `GET /health`：健康元数据。
- `POST /mcp`：stateless Streamable HTTP；静态Bearer或OAuth语音凭据。
- `POST /v1/calls`：必填conversation_id，返回短token与ws_url；客户端追加token建立WS。
- `/play/*`及旧playground页面已删除；静态资源不提供独立HTML别名。
- 入口与静态资源响应为no-cache；这不替换已运行旧tab，排障应核对协商能力与实际加载版本。

## 命令与验证

| 命令 | 作用 |
|---|---|
| `pnpm build` | server bundle与web客户端 |
| `pnpm typecheck` | TS严格检查，含保留的mts诊断脚本 |
| `pnpm lint` | ESLint |
| `VOLC_REAL_INTEGRATION=0 pnpm test` | 本地测试；真实供应商两例默认跳过，2026-10-12记录为352通过/2跳过，总354例、54文件；实机例不计通过 |
| `node scripts/audit-coupling.mjs` | AST依赖/循环/分层/长度；超长仍如实报错，不为绿灯改阈值 |
| `pnpm fillers -- --mock` | 明确生成mock filler；真实生成另行批准 |
| `node scripts/ws-smoke.mjs` | 会调用目标运行中服务；执行前确认批准与配额 |
| `pnpm cleanup:tmp` | 清理临时文件；生产执行需明确目标 |

本地无真实凭据时使用Mock，不能据此声称实机ASR/TTS或音色已验收。

## Provider与Core

- `ASR_PROVIDER=volc|mock`；`ASYNC_TTS_PROVIDER`/`REALTIME_TTS_PROVIDER=volc|elevenlabs|mock`。
- 火山支持`VOLC_API_KEY`或`VOLC_APP_ID`+`VOLC_ACCESS_TOKEN`。流式ASR、批量ASR、TTS资源和端点说明见[PROVIDERS](docs/PROVIDERS.md)。
- 个人音色放`data/voices/*.json`（gitignore）；空voiceId按档案provider读取环境兜底。实际TTS链路必须与档案provider匹配，不再用ASR或其他TTS供应商的并集放行。混合链路需选择匹配档案，不自动跨供应商映射音色ID。
- 复刻音色与系统音色资源不同；真实资源开通、音色和听感本批未核实，不能复制历史声明当新验收。
- R2要么不配并使用本地签名对象存储，要么配齐并使用非空有效bucket。所有相关配置在解析时trim；实际bucket私有策略仍需部署验收。

Core接入：`SIREN_CORE_BRIDGE=http`、`CORE_BASE_URL`及可选`CORE_API_TOKEN`。接口仍为：

```text
POST {CORE_BASE_URL}/v1/chat/stream
Content-Type: application/x-ndjson
body: conversation_id / call_id / turn_id / modality:"voice_call" / text
response: {"type":"delta","text":"..."}逐行，最后{"type":"done"}
```

done是逻辑终态，Siren随后关闭响应体/释放reader；取消信号贯穿Core HTTP、流式和批量TTS。下一次Core请求可附`interrupted_turn`，含旧轮关联和`playback.basis=client_reported|unknown`，不是精确已听文本；对端是否消费这个可选字段尚未真实验证。

## 自然语音打断与边界

- WS保持protocol=2，以`voice_interrupt`协商扩展；详见[实时协议](docs/REALTIME_PROTOCOL.md)。
- 新输入先等待`input_started`，PCM在本地有界缓冲；ACK只表示服务端接纳/prebuffer已装配，不表示供应商模型已识别。
- old input_id的迟到首PCM、字幕、状态和取消不会覆盖新轮。旧上游清理不挡住新输入。
- VAD确认窗决定何时触发；minSpeech判断结束后的有效短句，二者不再强绑。候选pre-roll随合法确认窗增长，保留首块。
- 浏览器AEC与实际播放参考的相关性残差共同辅助近端检测。此简化参考模型不是经过设备标定的完整声学AEC；合成单延迟/强弱双讲通过不证明非线性、多路径或iPhone外放。
- ENDING中新起声按“替换为新输入”处理，不自动拼接两段。旧轮已有partial仅保留为未定稿中断记录；尚未完成的真实识别不能声称已保留完整文字。
- 静音撤销待恢复意图；PTT必须新按压。手机音频上下文在呼叫点击手势内resume，迟到权限/旧socket回调不复活旧通话。
- 客户端播放进度按已调度片段与中止时刻观察，不能等同用户实际听见或逐字对齐。

## 数据、安全与运维范围

- Web显示名由`SIREN_PEER_NAME`/`SIREN_MAILBOX_NAME`注入，URL不承载个人称呼。
- SQLite新正文/转写/音色ID采用AES-256-GCM字段加密；合法enc1:开头明文也照常加密，严格12B IV/16B tag。错钥/损坏返回`data_unreadable`，不再伪装成空正文。
- `SIREN_DATA_KEY`可独立配置；缺省从签名密钥派生。**更换密钥前必须有恢复方案与旧钥保留**。旧无前缀明文只兼容读取，不自动迁移；历史密文/备份/旧meta本批未读未改。
- 新对象meta只保存投递元数据，不重复存text/tts_script/transcript/供应商音色ID。音频对象本体仍由签名URL/private bucket控制，未新增全对象加密或自动历史迁移。
- 默认日志递归脱敏，原始错误message不会直接写入；保留安全错误name/code和定位元数据。
- OAuth注册、持久撤销、限速与维护者API详见[MCP](docs/MCP.md)。语音API双轨共存；OAuth客户端管理只允许静态维护者token。
- Call token/会话及幂等在途合并为单进程设计；并发上限在实际WS会话注册处生效。没有宣称分布式配额或多实例强一致。
- 部署历史曾记录nohup和重启后隧道530；本批未读取现役配置、重启服务或操作隧道。请以维护者实际运行方式为准，不把源码提交当已部署。
- 脱敏前回滚bundle的内容未读；本批未删除。保留/隔离/销毁应在备份与恢复策略明确后单独决定。
- 历史iPhone“打断后紧接轮空转写”根因仍未定案；旧缓存只是历史假设之一。原会话repro因判据失效已停用，新的本地逐轮用例不能代替真实手机验证。
- Reconnect/Resume、多实例协调和S2S模型仍未实现；不因增加语音打断声称具备这些能力。

## 基线与批次索引

README是当前基线入口。旧提交可由git log检索，不改写历史或声称仍可达的实现期提交已消失。

| 批次 | 提交 | 范围 |
|---|---|---|
| 1012 文档冻结 | `2849129` | 交接、协议和能力边界；代码已合入本地 main，未执行生产重启 |
| 1012 根因修复与可语音打断 | `7dff481` | 关联轮次交接、真实取消/reader清理、候选首音、浏览器生命周期/回声参考、OAuth可靠提交、字段加密与错误语义、配置边界和本地回归；设备/生产未验收 |
| 1011 第一轮返修 | `a6333e5..694ecee`（9 commits） | 复审基线；当时278通过/2跳过，但仍有未闭合与新增风险，不沿用“全清”结论 |
| 1011 半双工规避 | `fdd0b69` + `3179da9` | 历史临时规避；本批按用户要求恢复可语音打断目标 |
| 音色资源文档 | `2dc3044` | 历史资源配置说明，非本批真实验收 |
| 排障与观测 | `374dd9b` + `7d03971` | 历史门控、notice、超时与观测 |
| MCP OAuth / 唯一入口 | `1e0472d` + `c95dd5d` | 初始接入与旧页面清理 |
| 语音档案移出git | `92da0a2` | 私人档案改为data/voices；不据此声称已独立验证全历史脱敏 |
| 初版与模块拆分 | `ab3816c` + `513dc3d` | 实现期起点与按职责拆分，现行历史仍可达 |
