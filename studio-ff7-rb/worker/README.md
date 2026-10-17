# worker

跑在这台 Linux 上（或 compose `worker` profile），**不**进 Next 进程。抽游戏资源、写 Postgres。

## 已经会的

| 脚本 | 干什么 |
|---|---|
| `catalog_cn.py` | 只扫中文包文件名 → 2.7 万条 catalog |
| `batch_extract.py` | 批量抽 CN（自研 IoStore）和 JP（retoc get）成 320k MP3 |
| `extract_txtres.py` | 官方 TxtRes → `lines.text_jp/text_zh` |
| `fill_speakers.py` / `fill_regions.py` | 人物表、地区表 |
| `classify_kind.py` | 对话 / 旁白 / NPC / 战斗 |
| `classify_dialogue_mode.py` | 从游戏的 PlannerEventSound 与 Dialogue/Cut 资源关联判定场景演出、普通对话或混用；结果写入 `line_meta`，证据写入 `work/dialogue-resource-evidence.jsonl` |
| `analyze_timing.py` | 峰值 10% 静音 → 起止长说 |
| `score_emotion.py` | 不使用emotion |
| `apply_red_persona.py` | 重新拆赤红/纳纳基（抽目录后 stem 仍是 `_red`） |

MP3 落在 `website/data/{jp,cn}/`，不进 git。

## 对话演出类型

先应用 `db/init/027_dialogue_mode.sql`，再在仓库根目录运行 `python3 studio-ff7-rb/worker/classify_dialogue_mode.py`。脚本读取游戏原始 Paks 的目录索引、`PlannerEventSound/JP` 和 `Dialogue/Game/*/Shot` 资产。一个事件的镜头资源可能同时包含演出和普通对话，因此逐句查语音 stem 所在的 Shot：有电影镜头对象或镜头切换轨道归为“场景演出”；没有则归为“普通对话”。未命中 Shot 时再根据事件是否有 Dialogue/Cut 序列判定。直接位于 `Sound/Voice/JP/Cut` 的语音归为场景演出。语音若跨两类镜头复用则标记“混用”；没有关联证据的标记“待判定”。混用默认按场景演出处理，避免漏掉镜头时间槽。

## 中日台词发音长度复核

`analyze_mora_balance.py` 用 OpenJTalk G2P 把日文转成假名、按日语拍数（mora）计数，并用 Fugashi / UniDic Lite 的词读音做交叉核对。中文按汉字数 + 句中标点数 × 1.5 估算。中日文引号（「」『』、“”‘’及英文单双引号）不计停顿拍；中日文整句末尾的连续标点不占时间（包含末尾引号、省略号、波浪号和尾随空白）；字幕换行不等于句末。日文去掉标点和空白后的正文字符数 ≤5 时输出 `SKIP_SHORT`，不计算日文拍数或比例。TTS `[停顿=…]` 控制标记不作为正文计数。筛查依据为文本单位比例，不判断意思、语气或实际口型；词典拍数有分歧或读音未知时要求人工复核。

审校收口协议：每条 `CHANGE` 必须最终归档为以下四类之一：已有候选达到 KEEP、生成新候选并实测达到 KEEP、已有锁定版作为明确例外（`LOCKED_REVIEW`，不得改锁），或明确记录为 `PENDING` 并保留后续责任。`REVIEW_SHORT` / `REVIEW_READING` 也必须单独列出，不能默认为已完成。批次只有在所有 CHANGE 都有上述闭环 disposition 后才能称为“完整完成”；存在 pending CHANGE 时只能称为 backfill/audit incomplete。报告应记录 line ID、stem、latest/used 候选 ID 与 active speech 秒数、是否存在达到 KEEP 的 ready 候选及未决原因。

在仓库根目录安装分析依赖并运行：

```bash
python3 -m venv work/mora-venv
work/mora-venv/bin/pip install -r studio-ff7-rb/worker/requirements-mora.txt
set -a; . studio-ff7-rb/website/.env.local; set +a
work/mora-venv/bin/python studio-ff7-rb/worker/analyze_mora_balance.py --id-range 13597:13647
```

默认按最新 ready TTS 文本检查；加 `--version-source used` 检查游戏当前锁定版。自动决定只看 `text_ratio = (JP mora+标点)/(CN汉字+标点)`，默认范围 `1.05–1.35`，范围外标 `CHANGE`。JP/CN 发音时长比 `speech_ratio` 和单位/秒比 `pace_ratio` 只作诊断，不参与是否改词的决定；不要求中日音频总时长相同。可用 `--min-ratio`、`--max-ratio` 调整筛查范围。若检查锁定版且超限，标为 `LOCKED_REVIEW`，不暗示自动解锁。日文 G2P 和 Fugashi 读音不同或有未知读音时标为 `REVIEW_READING`，避免按低置信度数据自动改词。默认跳过 `dialogue_mode=field`、无电影镜头的 `mixed`、未知演出类型和 `lines.subtitle_italic=true` 的斜体画外发言；field 可用 `--include-field` 仅作诊断，此时仍输出 `SKIP_FIELD`。该规则把“是否需改”从模型判断转成稳定阈值筛查；`CHANGE` 只表示应改写候选文本，不会自动改字幕、生成 TTS 或锁定版本。首次运行 OpenJTalk 会下载约 23 MB 的日语读音词典。

两种场合都可能有 `LipSync/Lsd` 文件，不能据此分类。场景演出生成时对齐日文的开头、说话时长和总长；普通对话生成时使用所选时长倍率控制语速，不做日文时间槽的二次压缩或补静音。此流程没有重生成中文音素口型。

## 还不会

- 调用 IndexTTS 生成 ours。打差量包用同目录的 `build_mod.py`，说明在仓库根 `AGENTS.md`。

## 不使用emotion

## 网站拍数服务（2026-09-28）

`mora_core.py` 是 CLI 和网站共用的唯一计算核心，固定 OpenJTalk 0.4.1、Fugashi 1.5.2、UniDic Lite 1.0.8。`mora_server.py` 提供 HTTP `/beats` 批量接口和 `/health`，日文读音按原文本缓存，仅更新 line_meta 的派生拍数缓存，不改音频、锁定、字幕，不调用 LLM。Compose `mora` 服务仅在内部网络开放，由网站 `/api/beats` 代理；部署 `docker compose --profile full up -d --build mora website`。

网站展示原中文及所选 TTS 的独立拍数；始终计算各自实际 `tts_text`，不拿字幕改写代替朗读文本。短句显示跳过而不是 0，读音分歧显示待核对。仅对非斜体的「对话－场景演出」计算。比 = (日文拍数 / 中文拍数) / `NORMAL_JP_CN_RATIO`（现为 1.33），正常中心为 1.00；偏离超过 10% 警告，超过 15% 异常（原范围 1.05–1.35 的相对半宽 ×80%/120%）。再改这个除数时按 `mora_core.py` 里该常数上方的口径重算。SQL 统计和筛选取对时与拍数中较重的等级，排除已锁定和人工确认条目。缓存使用文本 MD5 和规则版本校验，每 30 秒更新；未锁定候选不替代源中文统计。原始计数与新规则不相同，历史报告需明确计算版本。

边界回归：`PYTHONPATH=studio-ff7-rb/worker work/mora-venv/bin/python -m unittest studio-ff7-rb/worker/test_mora_core.py`。

## 自动修正场景对白并生成试听候选

`rewrite_scene_batch.py` 使用网站现有的自动修正模型、本场日英中上下文、拍数服务和 JP zero-shot TTS。先部署本次网站代码（改写接口 `GET` 返回 `literary-0.9-1.1-v1`），再在能访问管理台和 Postgres 的宿主机运行：

```bash
# 默认只扫描，冻结任务清单；不调用大模型，不生成或删除音频。
python3 studio-ff7-rb/worker/rewrite_scene_batch.py
# 执行或续跑同一任务清单。
python3 -u studio-ff7-rb/worker/rewrite_scene_batch.py --execute \
  > work/rewrite-scene-golde.log 2>&1
# 可在运行中从另一终端离线查看进度。
python3 studio-ff7-rb/worker/rewrite_scene_batch.py --status
```

默认从 `GOLDE_QST_01_0200_0100_00_rez` 对应的 `lines.id` 开始（包含起点），按 ID 顺序扫描后续所有区域。只处理 `scene` 对话、非斜体、未 `skip_timing`、无锁定版本，日文正文超过 7 字，源中文的 **normalizedRatio 严格 <0.7 或 >1.3**。0.7–1.3 含边界不调用模型或 TTS。除数由当前共享拍数服务决定（2026-10-08 为 1.33），不使用旧的未归一 `ratio`。日文读音待核对的异常行单列 `plan.reading_review`，不算已完成。

每条五轮连续改写，0.9–1.1 含边界都合格，一般从第三轮重点改善措辞，不追求 1.00。第六次调用由同一模型按三语上下文和文字质量择优，允许全部拒绝。程序同时复算字幕及换行转句号后的实际 TTS 文字；只有两者都合格才生成。TTS 沿用现有接口的三候选及时间对齐流程，新音频和字幕保持未锁定、未试听，供用户审核。 字幕跟随原字幕行数，不因文字变长自动增加行数。`subtitleText` 与朗读用的 `ttsText` 分开保存，排版不额外触发TTS。

默认两条改写流水线与一条 TTS 流水线并行；一个 TTS 请求内部已并行生成三条。`--rewrite-workers`（1–4）和 `--tts-workers`（1–2）调整并发，等待 TTS 的队列有上限。**新候选成功保存字幕后**，才调用带 `onlyUnreviewed=1` 的删除接口清理本条开始处理时已有的 ready、未试听且未锁定候选。接口在事务中重查状态；已试听、已锁定或新确认的内容不删，不修改用户审查标记。

日志每实际完成 100 条输出报告（跳过不计数），另每分钟输出状态。SQLite `work/rewrite-scene-golde.sqlite3` 保存候选、选择理由、ID、失败原因和执行状态，旁边的 `.progress.json` 提供总数、完成数、剩余数、未决数、最近完成位置和连续处理到的位置。并行时最近完成位置不等于连续游标。失败不算完成；读音待核对另外计数。

同一 journal 用文件锁禁止双开。中断中的只读改写可重跑；已收到 TTS ID 的任务可继续补字幕和清理，不重复合成。TTS 已提交但没有持久化响应的任务标记 `uncertain`，不会盲目重发，应人工查看该条 `baseline_ids` 之后的记录并恢复日志。`--retry-failed` 仅重试明确失败，不重试 `uncertain`。连续三次调用/基础设施异常停止调度，保留未处理任务。任务清单是冻结快照；后续新一轮请指定新的 `--journal work/新文件名.sqlite3`，不要覆盖正在使用的清单。

验证：`python3 -m unittest discover -s studio-ff7-rb/worker -p test_rewrite_scene_batch.py`；网站目录下 `node scripts/test-rewrite-policy.cjs`、`node scripts/test-batch-delete.cjs` 和 `npx tsc --noEmit --incremental false`。这些验证不调用实际服务。

### 假名时长权重（实验）

设计、标注数据格式、校准命令和正式发布条件见
[docs/mora-duration-weights.md](docs/mora-duration-weights.md)。
`mora_weights.py` 提供完整摩拉分词、权重求和及独立场景验证；未校准权重为 1.0。
共享核心新增 `weightedMora`/`weightStatus` 供后续对照，目前不改变正式比值，不自动处理旧候选。

### 净发声语速对照

详情页支持基于音频的实验对照：每条音频自身峰值的15%为门槛，连续至少200ms安静整段扣除，纯摩拉/汉字除以净发声时长。标点不计拍；原“比”及自动改写保持不变。细节、音频来源及限制见 [docs/net-speech-comparison.md](docs/net-speech-comparison.md)。

净发声统计已增加数据库持久化（`030_speech_metrics.sql`）。`speech-metrics` Compose服务运行 `speech_metrics_batch.py --watch`，单进程、最多一个CPU核，逐条补算并自动发现新音频。网页直接读保存结果；详情及操作触发的缺失项优先排队。可用 `docker compose logs -f speech-metrics` 看进度。运行过的缓存无需因重启重新计算。
