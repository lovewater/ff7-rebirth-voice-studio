# Remake 官方人名与翻译约束

运行词表为 `work/preprocess/name-glossary.json`，只属于数据库 `studio_ff7_remake` 与游戏 `remake`。2026-11-04 当前162条记录中，73条确证专名允许匹配，89条通称 `matchable:false`。运行数据不提交。重建命令：

```bash
python3 studio-ff7-remake/worker/export_name_glossary.py
```

导出使用临时文件后原子替换，`revision` 为实际内容SHA256。流水线逐请求读入，无需重启；以实际运行文件数量为准。

本轮73专名版本的内容校验为 `ad80b4d9e2e51f732144d70e0b94d58cc01521aaed7fdf15194ea3ef343f1cb0`。公共翻译输入保护另有独立版本：#59 保留行首呼语，#60 将**当前源句实际命中的拼写**直接写成 `Corneo → 古留根尾` 这样的约束。仅列出词表JSON别名不足以保证模型采用官方名；约束必须对应本路当前输入的实际匹配结果。版本号是本次验收记录，后续以实际代码与运行词表revision为准。

## 来源与优先级

全部来自本机游戏原始 `Text/{CN,JP,US}/*_TxtRes` 经 `ff7r-text-tool` 解码的112份文件；不读Rebirth词表、数据库或生成译文。

1. 官方Resident明确的人物 `name_*` 字段：同一ID的中日英值直接互证，优先于ACTOR中敬称、变装显示名的多数票。
2. 官方Resident `menu_Loading_Character_*_Title`：只用于明确人物名字/全名，职业、物种、组织条目排除。不将界面标题中的称呼强加到只说简称的正文。
3. 其它人名从同VoiceID的三语ACTOR提取，至少3条且同一中日对应占非空样本90%以上才采用；保留异名计数及样本。

词表每条保存 `evidence` / `official_name_fields`，含真实ID、CN/JP/US资产路径及三语原值。游戏官方显示名与每句原ACTOR继续独立保留。

明确补充示例：

| 英文 | 中文约束 | 日文 | 官方字段 |
|---|---|---|---|
| Madam M | 玛姆 | マム | `Resident.$name_mom` |
| President Shinra | 神罗总裁 | プレジデント神羅 | `Resident.$menu_Loading_Character_President_Title` |
| Don Corneo | 古留根尾 | コルネオ | `Resident.$name_cln` |

`name_pre` 中“总裁 / プレジデント”是泛称，不作为强制专名匹配。Madam M的ACTOR“玛姆/玛姆女士”差异属于敬称，不是人物冲突；使用明确 `name_mom` 的玛姆。完整日文称呼 `マダム・マム` 仅因同一人物的官方Loading Title互证，保存为带 `verified:true` 与字段证据的别名，不凭ASR猜假名。

## 简称与通称

Corneo安全简称已通过多条同VoiceID正文中 `Corneo / コルネオ / 古留根尾` 互证，保存样本及总数后才加入 `english_aliases`；不加入泛称Don。

Customer、Guest、Server、主播/设备广播、店主/职业、Chocobo物种、Jessie's Mom、Big Bro等即使ACTOR稳定也不是可强制的人名，全部禁匹配。Old Snapper是本作确证的特定人物昵称，保留官方对应。

Ms. Folia / Red XIII 的简称没有足够明确的独立简称中文证据时不猜；不能由“フォリア”强加“老师”，也不能由“レッド”强加XIII或让英语颜色red匹配人名。

英文只约束当前句确实命中的名字；日文直接命中只能使用官方canonical或有明确验证证据的别名。两路翻译各自按本路源文是否说出这个名字判断，不能将上下文/另一语言未在本句出现的名字强塞进译文。

## 回归验证

`test_name_glossary.py` 覆盖明确Resident单条名字优先、泛称不因name字段而变专名、Corneo至少3条三语正文证据。公共 `translation/names.cjs` 实测可命中Cloud、Jessie、Biggs、Aerith、Marlene、Madam M、President Shinra、Corneo，不能命中Customer、Guest等泛称。
