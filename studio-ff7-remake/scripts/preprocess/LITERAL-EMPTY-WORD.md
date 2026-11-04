# Remake 字面“空。”被误当成无文本的翻译补救

2026-11-04，两个条目的 Japanese ASR 正常成功，原文均为字面 `空。`，state 为 `recognized`，不是正常空识别：

- `VO_EN0008_00_Vice_Standard_02__clip0023`
- `VO_EN0000_00_SecuritySoldier_04__clip0297`

两条没有英文或官方中文供独立翻译参考。既有非空源守卫正确拒绝模型返回的空译文，没有为通过检查删掉源文、重跑 ASR 或手填业务译文。

## 同一本地 27B no-think 实验

使用原日志请求 messages 及相同输出预算顺序复现；修改组仅在 system 前追加“源语正文与空字符串必须区分”：current 是已保存待译文字，不是识别状态/音频元数据；字面“空/空。”存在即是非空正文，应按指定语言忠实非空翻译；只有真正空字符串才可空译，不根据词义或猜音频清空结果，不改 ASR，不翻上下文。

| 源条目 | 原业务日志 | 原请求重放 | 增加规则 | 重复验证 |
|---|---:|---:|---:|---:|
| Vice clip0023 | #52609 | #56329：`{"translation":""}`，拒绝 | #56331：`{"translation":"空。"}`，通过 | #56334：同结果，通过 |
| SecuritySoldier clip0297 | #53151 | #56336：`{"translation":""}`，拒绝 | #56339：`{"translation":"空。"}`，通过 | #56341：同结果，通过 |

请求/响应均为 `Qwen/Qwen3.8-27B-FP8`，每次明确 no-think，完整真实请求和响应保存在 Remake `llm_access_logs`。

## 应用范围

已追加 Remake `translation.independent.system` 审核版本 **#61**，保留旧 **#47**，不改 Rebirth。程序每次模型请求动态读取最新启用模板，所以不重启/不另开 worker。主进程完成当前分类阶段后，原有断点重试会读新规则。

本专项没有写两条业务译文，没有改源文、checkpoint、attempts 或排队时间；没有调用 ASR 或 TTS。原 `parseIndependentTranslation` 守卫不变：非空源的空译文拒绝，真正空源仅允许空译文，空源编正文仍拒绝。

代码为 `nonempty-source-prompt.cjs`，幂等模板追加函数为 `appendNonemptySourceSystem`；`nonempty-source-prompt.test.cjs` 覆盖字面“空。”与真正空字符串的既有守卫及只追加版本的行为。44 项本作 CPU 测试全部通过。

完整报告和复现实验脚本在本作 ignored `work/preprocess/validation/literal-empty-word-probe.*`。少量真实探针不能保证所有以后生成都合规，原有严格校验与断点重试继续保留。
