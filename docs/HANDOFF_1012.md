# 1012 根因修复与可语音打断交接

日期：2026-10-12（America/Los_Angeles）。代码基线：**7dff481c8c4722b10174d84fed078940f2c20ec4**；起点694ecee。文档基线由后续docs提交记录，README是入口。

**本地代码和验证已完成；生产重启、iPhone外放与真实供应商验收未执行。** 新能力是可语音打断的实现，不声称已达到GPT语音的实际设备效果。主仓代码与本地构建会交接到main，不推送远端，不自行重启现役服务。

## 用户能得到的变化

- 新客户端/服务端协商voice_interrupt后，AI思考/播放期间确认用户讲话即可本地停播并接新一句。手动徽章和PTT仍可用，旧服务端明确显示手动模式。
- 先作废旧input输出再停播，旧轮迟到首PCM/字幕/状态不能复活。新音频等待自己的input_started ACK，旧上游取消不挡住新输入。
- 候选窗与minSpeech分离，pre-roll按合法确认窗口增长；默认配置不再确定丢首块。静音/PTT不会因回调意外恢复上行。
- 呼叫点击同步resume AudioContext，等待协议ready才采集；旧socket/迟到权限结果隔离；拨号HTTP未完成也可挂断并关闭准备中的音频上下文。
- 实际播放总线给AudioWorklet提供参考；浏览器AEC之后，用有界单延迟相关性残差辅助人声判断，包含强/弱双讲合成测试。真实多路径/非线性回声效果仍未知。

## 根因修复清单

| 领域 | 实施结果 | 主要新验证 |
|---|---|---|
| 下载生命周期 | 同一总期限覆盖DNS、重定向、响应头与body，超时真正落定并清理；解析结果钉住连接 | audio-fetch.test.ts头前超时/body stall |
| turn取消/响应体 | 批量及流式TTS signal贯通HTTP和bidi聚合；Core done/error/return取消body并释放reader | batch-tts-cancellation、core-response-lifecycle、排队bidi取消 |
| 轮次交接 | 目标身份、幂等interrupt、新input ACK及所有turn下行身份；实际会话准入限流 | voice-interrupt-session与client-flow |
| 字段加密 | 业务enc1明文照常加密；严格IV/tag/编码；错钥明确data_unreadable，原密文不改 | field-crypto正常/前缀/截短tag/错钥/恢复 |
| OAuth状态 | 成功前等待提交、失败503、损坏文件拒绝初始化、onClose等待写队列 | oauth-state延迟/失败/重启/并发回归 |
| DCR恢复 | 基本限速和输入上限；pending可回收；静态维护者列表/移除API，无secret返回 | oauth-state容量/权限/事务失败 |
| 日志 | 递归与bindings脱敏；Error只提取安全分类字段，默认不记录原始message；启动失败也走安全字段 | logger-redaction实际错误传播 |
| Provider/配置 | 当前TTS链路精确检查profile；R2解析trim与readiness/装配共用验证 | provider-registry混用/掩盖/空白bucket |
| 数据副本 | 新meta去掉正文、转写和供应商音色ID，正文留字段加密DB | field-crypto对象meta验收 |
| filler | 可导入无副作用，显式mock，正确profile/能力，manifest记录来源，finally dispose | generate-fillers假Provider/关闭断言 |
| MCP播放器 | text恢复；get/list/speak的解密失败明确分类 | 实际resource JS消费真实tool结果 |
| 诊断/AST | 失效会话repro停用；底层ASR脚本默认拒绝、flag才可实机；mts进typecheck；真实包入口与层规则/SCC修正 | diagnostic-scripts-safety、audit-coupling夹具 |

## 验证结果

在隔离工作树前台执行，使用已有依赖、合成临时数据；本地WS/HTTP为回环随机端口。加载只允许回环的网络护栏，并明确VOLC_REAL_INTEGRATION=0。

- **352 passed / 2 skipped，总354例；53 passed / 1 skipped，总54个测试文件。**
- pnpm typecheck：exit0，含保留mts。
- pnpm lint：exit0。
- pnpm build：exit0，server bundle与客户端构建完成；客户端产物与write:false重建逐字节一致。
- git diff --check：exit0。
- AST：165文件、435内部边；未检出文件/包循环、跨层违规或内部未解析边。**42条文件/函数长度超限、10条提示仍在，命令exit1**，没有改阈值掩盖。

真实Provider实现的fake传输取消检查与纯接口mock分开；fake回环测试不冒充实机。第一轮整合遇到新ready门控与旧浏览器fixture的3个失败，已按新协商语义修正后全量通过；另一次pnpm参数转发误跑全套触发沙箱端口阻塞，主动结束并改用明确过滤。这些过程没有用失败结果填PASS。

客户端生成产物：realtime-call-test.js 57360B，SHA256 19258f706021da2b00ef15b58f959fb9324fc8233e5060dd01c38a9184cfcf6d；async-voice-test.js 8382B，SHA256 3a8e96faeda7af85e519fd82c3a869543777e17794ee15f956ad056be5f11084。

## 明确政策与剩余边界

1. ENDING再起声采用**新输入替换**，不自动合并旧句；旧partial只按未定稿中断记录保留，不能宣称完整识别。新句与迟到final隔离已本地验证。
2. played_ms是客户端观察的排程进度，basis标client_reported或unknown；sentText表示已下发而非用户已听。真实Core如何处理interrupted_turn未验收，未修改外部Core仓库。
3. 真实手机外放、系统AEC实际效果、声学误触发率、真实ASR连续打断和供应商取消效果均NOT_EXECUTED。当前没有真实设备p95延迟数据。
4. 旧明文/历史meta/备份没有迁移或清理；旧无前缀字段仅兼容读取。旧版本曾写入的非法enc1字面记录仍需独立、可恢复的数据维护，不能盲目把失败密文当明文。
5. 默认数据密钥从签名密钥派生；实际部署若换密钥，必须保留旧钥和恢复方案。错误密钥现在明确失败而不是成功空正文。
6. OAuth存储为单进程：成功应答等待原子写，正常进程重启有测试；多实例写入/断电耐久性未验收。缺文件被视为首次初始化，运维不得删已部署状态文件作为重置。
7. 活跃连接及每轮PCM有上限；每日账单、跨实例幂等/配额、长时间极限负载不是本批实现。
8. 维护性长度超限继续接受复核。状态机/组合根/测试组保留职责集中，不为42条长度记录机械拆分。公共无引用类型及进一步JSON压缩未强行删除；兼容负载保留。
9. 旧iPhone空转写的真实根因仍unknown，不把修复本地反例宣称为历史实机问题已定案。新严格关联流程替代了旧无目标自动abort。

## 交接与运行步骤

- main更新后，先检查README和docs/REALTIME_PROTOCOL.md的新握手合同；运行中的旧Node进程不会因Git提交自动成为已验收新服务。
- 本批没有读取或修改生产.env/data、没有改密钥、迁移数据库、改网络/隧道、执行ws-smoke、调用真实ASR/TTS/Core或删除回滚bundle。
- 部署者确认配置/备份与窗口后再重启。新客户端连接旧服务端会显示手动兼容模式；不要把这当新功能失效，先核对server能力与客户端client=1012-interrupt日志。
- 真实验证分两步：设备+本地假服务验证采集/播放/回声，再在明确秒数/字符/Core轮次预算内验证真实链路。用户已要求的iPhone外放不能由桌面或耳机测试替代。
- 原repro-session-abort CLI退出2，明确停用；repro-asr-abort无flag退出2且不会读配置/音频或联网。--allow-real-asr只能在另行批准后执行，约束的是最大PCM输入30.2秒，不代表供应商实际计费保证。
- 安全/代码回滚与数据回滚分开。不能删oauth-revoked.json“恢复服务”，也不能替换SIREN_DATA_KEY后把data_unreadable当无数据继续覆盖。

本批真实ASR输入0秒、TTS字符0、Siren真实Core/Codex调用0。模型自身推理费用没有工具可靠总数，记unknown。所有代码修改来自明确修复授权，未推送远端；设备/生产验收需后续单独批准。
