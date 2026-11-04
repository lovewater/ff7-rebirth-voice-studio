# Remake 当前条行首呼语与英文别名映射专项

2026-11-04，仅本作独立翻译，模型始终为显式本地 `Qwen/Qwen3.8-27B-FP8`，no-think。没有调用 TTS，没有手填业务译文，没有放松官方姓名校验，也没有向日译中加入官方中文/英文台词。

## 行首姓名被当作说话人标签

`ev_town7_2420_0040_big_0` 日文原文为 `クラウド\nウェッジを送ってやってくれ`。原请求 #5988 及真实重放 #6848 均只译“把威吉送过去”，漏掉呼唤“克劳德”；严格名字校验拒绝，未落库。

在本作独立翻译 input 前增加正文边界规则：current 中的换行仅为字幕显示；行首人名、称呼、呼语仍是当前台词，不当作说话人标签省略；只翻 current，不翻前后文，不从另一语言补写。#6849、#6850 连续两次正确返回“克劳德\n把威吉送过去吧”，Cloud/Wedge 校验通过。

因此追加 Remake `translation.independent.input` 审核版本 #59，保留旧 #46，不改 Rebirth。最新模板由每次请求动态读取，无需因该数据库提示词变更重启。实现/幂等追加入口：`leading-name-prompt.cjs`；CPU 回归：`leading-name-prompt.test.cjs`。

## Corneo 已验证别名仍被另行音译

本作词表已审核 `Corneo` 是 `Don Corneo` 的英文简称，官方中文均为“古留根尾”。原请求 #7008 / 重放 #7177 / #7482 将 Corneo Cup 另译“科尔诺杯”，均被严格校验拒绝。

只在 JSON 加 `verified_english_aliases:["Corneo"]` 并说明同一人物仍不够：#7178、#7179 仍错误。该未通过方案没有发布为模板版本。

最终只针对**当前待译原文确实命中的姓名**，向模型同时提供已审核别名字段和明确的源拼写→官方姓名对照，如 `Corneo → 古留根尾`。名字组成杯赛、地点或机构复合名称时也不能重新音译；仅其他语言命中的条目依旧标 `matched_in_current_source=false`，明确不能补进当前译文。#7486、#7493 连续两次返回“古留根尾杯的最终决战……现在开始！”，原校验通过。

实现仅修改 Remake `names.promptNames`、新增 `nameGlossaryText`，公共 Rebirth names 不变。追加 Remake `translation.name-glossary` 审核版 #60，保留旧 #58。幂等模板维护函数在 `name-alias-prompt.cjs`。本作主进程由 root 平稳重启至唯一 PID 3926484 后加载新的 names 代码；本专项未启动第二个 worker。

## 实际失败队列的结果

重启后，仅对当时仍为 `status=retry AND error=translation-name-mismatch` 的两条任务提前 `next_attempt_at`。没有重置 attempts、旧译、checkpoint 或其它字段；事务校验除计时字段外前后一致。直接追加 `remake_preprocess_events.stage=retry_schedule` 不可变审计，不调用会改 checkpoint 的通用事件函数。其它 error 不动；另三条已被主进程自然领取成功，不再重跑。

五条已知失败任务最终全部 `done`、`error=NULL`，译文与机器 checkpoint 一致且再次通过严格名字校验：

| stem | 对应成功日志 | 实际保存结果 |
|---|---:|---|
| ev_town7_2420_0040_big_0 | JP #7163 | 克劳德\n把威吉送过去吧 |
| ev_slu5b_3290_0080_soc_0 | EN #7096 | 就在古留根尾竞技场！ |
| ev_slu5b_3330_0240_koc_0 | EN #7719 | 古留根尾杯半决赛的第二场比赛……现在开始！ |
| ev_slu5b_3360_0070_koc_0 | EN #7767 | 接下来登场的是——古留根尾杯五连冠得主！ |
| ev_slu5b_3360_0160_ev1_0 | EN #7768 | 古留根尾杯的最终决战……现在开始！ |

#7163 确认带 #59 的正文边界规则；#7719/#7767/#7768 确认同时带 #59、#60 英文别名规则和当前源拼写映射。#7096 在新 names 代码上线前已自行生成正确结果，按规则保留而不重跑。所有上述保存请求都记录实际本地 27B/no-think。

本地原始报告（不提交数据）位于 `work/preprocess/validation/`：`leading-name-prompt-probe.json`、`corneo-alias-probe.json`、`corneo-explicit-mapping-probe.json`、`name-retry-schedule-1793733859512.json`、`name-retry-observation.json`。复现实验脚本同目录归档；真实密钥仍只从 ignored 私密配置读取。

42 项本作 CPU 测试通过。真实模型探针只能证明这些样本，不能保证所有以后生成都会合规；严格姓名校验和原有断点重试继续保留。
