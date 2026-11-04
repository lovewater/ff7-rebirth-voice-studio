# Remake 日文转写、独立翻译及拟声原声复核

这是 Remake 独立后台，入口为 `scripts/preprocess-dialogue.cjs`。不读取 Rebirth 私密配置，不使用其翻译 runner、全局模型通道或任务表；不调用任何 TTS、Seed-ASR、变声或改稿服务。用户已于 2026-11-04 明确授权本作本地 27B no-think 与 11GB Qwen ASR，实际启动批次由当前操作记录确认。

## 数据和顺序

- 四个 line workers；独立 ASR 和 LLM semaphore 各最多四个请求。ASR 服务原有 GPU 锁保持，ASR 与 LLM 可以流水重叠。不同进程的辅助 LLM 工作须由操作方协调，使本次总并发仍不超过四个。
- PostgreSQL 必须是 `studio_ff7_remake`，账号必须是 `ff7remake`；音频根标识必须属于 Remake。程序启动后还核对实际数据库/账号；不会默认连接 Rebirth。
- `remake_preprocess_jobs` 按 stem 领取整条，独立保存 ASR、日译中、英译中、波形、分类与锁定 checkpoint；`remake_preprocess_events` 保存各阶段完整历史。每成功一阶段立即持久化。单进程 PG advisory lock 防止另一进程回收活任务，重启仅回收本 scope 的进行中状态，不重跑成功 checkpoint。
- 最初官方日文字幕缺失事实和原始三语值保存在 job.origin；ASR 完整响应、Japanese 请求语种、源 SHA、模型及是否填入正文的结果保存在事件和 checkpoint。只在 `text_jp` 仍为预期空值时填 ASR，已有官方或人工源文绝不覆盖。`text_en`、官方 `text_zh` 始终保留。
- ASR 完立即做日文独立翻译，再做已有官方英文的独立翻译。分别只依据本语言当前原文、同演出本语言前后各最多两句；不把官方中文、人工改稿或另一种语言整句送入翻译。本句日文直接命中和英文命中的本作人名取并集作为辨认参考，`matched_in_current_source` 标明当前待译原文是否确实出现；只强制当前源文出现的人名，禁止把另一版或上下文的人名强塞进译文。
- 日译中写 `translate_zh_jp`，英译中写 `translate_zh_en`；已有译文不覆盖，写入时对源文和目标空值做 CAS，成功结果与 checkpoint 同事务提交。原文发生变化的 retry 重新计算 hash，不把旧结果硬写回。
- 翻译使用本库每次调用时的最新启用 `translation.independent.system/input` 及命中时的 `translation.name-glossary`。不存在启用版本则报错重试，不能静默回退内置版本。本作游戏身份仅在 system prompt 中替换。
- 一般译文使用公共完整 JSON 严格 parser，唯一非空 `translation` 字段。ASR 正常返回空则仍请求翻译，只接受完整 `{"translation":""}`，保存 `untranslatable_empty` 状态，禁止补写正文或无限重试空源文。失败 ASR 绝不冒充正常空识别。
- 长转写按当前源文长度提高输出预算，从至少 512 到 8192；length 重试提高预算，最大预算仍截断时保存 `needs_review_output_limit`，保留源文交复核，不无限重复相同预算。分类失败批次后续按单条重试，格式/截断达到预算后保存 `needs_manual_review`，不自动锁定。

## 缺原声与多声道

`extra.audio_extraction.missing_jp=true` 时绝不取 EN 强制 Japanese。保留可译官方英文；每 60 秒重读原声恢复结果，已成功的译文不重复。当提取审计明确给出 `audio_extraction.jp_source_absent=true`，将其作为 `source_exception: confirmed_no_independent_jp_source_for_row` 例外完成并保留 `jp_source_absence` 证据，范围仅限当前目录条目，不代表整场没有日文；不能只凭 missing_jp 就宣布确实没有原声。

多声道/混合 MP3 仍须 ASR 和独立翻译，保留提取 provenance；`preview_only`、`eligible_for_generation=false`、缺 JP 或超过双声道只会阻止最终原声锁，不能跳过 ASR/翻译。

## 最后的拟声复核与锁

转写/翻译阶段后，最多四批、每批最多八条交同一本地 27B 复核。使用共享 `onomatopoeia-reuse-policy.ts` 的可复用性原则；返回每条独立 kind、日中英三份只删除拟声后的正文、能否直接复用及理由。正文必须是原文仅删除内容后的结果，不能改写。ASR 空、模型服务错误、格式不符或任何正文证据均不能当纯拟声。

CPU `worker/preprocess_acoustics.py` 从可寻址完整原声解码原采样率、保留各声道 float32 PCM；不会把反相声道混零，也不会通过 PCM16 舍入把微弱信号变零。声学证据仅证明解码、精确零及实际活动，不声称判断语言。纯拟声自动锁还需要正常非空 ASR、模型确认无正文和可直接复用、独立保守拟声音节校验、合格单/双声道与非零活动。证据不足保留未锁供人工处理；不会切片、重编码或伪造核字通过。

真正 PCM 精确全零走独立原声保留分支，ASR 空并不妨碍该**声学精确零**分支，但缺文件、解码失败、低响度或混合预览不能触发。

自动锁沿网站 `voice_gpu_key=jp-lock`、`status=ready`、`review_state=locked` 语义，`subtitle_text=NULL` 保留游戏原字幕；原 MP3 字节独占复制到本作 `tts/<stem>/<id>.mp3`，验证复制及源 SHA 一致。事务锁定 lines 行后再次比对三语源文、提取 metadata、源音频 SHA 和人工状态，绝不清掉任何已有锁/异常。Remake 专属 review revision 记录锁、取消、字幕改动，用户在处理期间“锁后又取消”也优先。文件新建后任何 PG/COMMIT 异常都保留本次独占文件待审计；新连接暂时查不到 row 不能证明原事务已回滚，不自动删除可能被已提交或稍后提交 row 引用的音频。后续孤立文件清理由独立审计决定。

`done` 表示资料流水线处理结束，**不表示已经锁定或所有条目可生成中文**；请看 `checkpoints.lock.state`、分类、`needs_review_*` 和 `source_exception`。

## 配置与运行

本机真实配置在 `.private/preprocess.env`，权限 0600，不提交、不打印。必须配置：

```dotenv
FF7_GAME_ID=remake
DATABASE_URL=postgres://ff7remake@<host>:<port>/studio_ff7_remake
AUDIO_DATA_ROOT=/absolute/path/to/studio-ff7-remake/website/data
REMAKE_PREPROCESS_LLM_URL=http://<local-model>/v1
REMAKE_PREPROCESS_LLM_MODEL=<local-27b-model-id>
REMAKE_PREPROCESS_LLM_API_KEY=<secret-or-empty>
REMAKE_PREPROCESS_ASR_URL=http://<local-asr>:8001
REMAKE_PREPROCESS_CONCURRENCY=4
```

`REMAKE_PREPROCESS_DATA_ROOT` 也可指定音频根，两种变量同时存在必须一致。可选 `REMAKE_PREPROCESS_STATE_DIR`（默认本作 `work/preprocess`）、`REMAKE_PREPROCESS_SCOPE_FILE`（非空 JSON stem 数组）、`REMAKE_PREPROCESS_TIMEOUT_MS`（默认 600000）。`name-glossary.json` 只从本作 state 目录读取，格式与公共 `scripts/translation/names.cjs` 相同；不存在则明确使用空术语表，绝不回退 Rebirth 词表；每次翻译请求重新读取本作词表，新文件下次请求生效，已完成译文不自动重译。

从项目根执行，`--prepare` 只建本作专属表/trigger 和任务，不推理：

```bash
export REMAKE_PREPROCESS_ENV_FILE=/srv/ff7-sound/studio-ff7-remake/.private/preprocess.env
node studio-ff7-remake/scripts/preprocess-dialogue.cjs --prepare
node studio-ff7-remake/scripts/preprocess-dialogue.cjs --status
```

有限 scope 烟测及断点重跑：

```bash
export REMAKE_PREPROCESS_SCOPE_FILE=/absolute/path/to/stems.json
node studio-ff7-remake/scripts/preprocess-dialogue.cjs --once --limit=12
```

`--phase=preprocess|classify|all`（默认 all）；`--once` 仅处理目前可领取的一遍；`--limit` 是每阶段本次最多条数。正式长期运行不设 scope/limit/once；启动方须先确认本次授权、模型健康及其它模型任务的总并发。

创建 state 目录下 `STOP` 会停止领取，已在途条目自然完成；TERM/INT 同样停止领取。重启需删除 STOP，重新运行相同入口。任务回退最长六小时；缺 JP 等资源恢复固定一分钟。操作方可用 systemd 管理本作进程，不复用 Rebirth 的 watchdog 或 cron。

所有 LLM 请求调用前写 `llm_access_logs`，记录完整真实 request_body、模型、prompt keys、输入、响应、usage 和错误；`chat_template_kwargs.enable_thinking=false` 每次显式发送。只读取本次显式本地 endpoint，无付费或 Rebirth 路由回退，响应模型不一致也拒绝；返回非零 reasoning_tokens 或非空 reasoning 内容时直接判请求失败，保留日志供检查。密钥和 Authorization 不进入日志。

## 测试与已执行烟测

```bash
node --test studio-ff7-remake/scripts/preprocess/preprocess.test.cjs
python3 -m unittest discover -s studio-ff7-remake/worker -p test_preprocess_acoustics.py -v
```

2026-11-04 首批真实 scope 12 条：8 ASR（含 2 多声道）、3 官方双语、1 缺 JP 待恢复；11 日译中、3 英译中、1 拟声批次共 15 次本地 27B 访问，全部明确 no-think、未返回 reasoning。5 个合格整句原声锁复制 SHA 全通过，2 个 preview 拒锁、1 个缺人物不锁；1 缺 JP 等恢复。真实 PG 回滚检查源文/译文 CAS、extra 隔离、人工锁后取消优先全部通过；同 scope 重启没有增加 ASR/模型阶段。证据在本作 `work/preprocess/smoke-*`。这批烟测不等于全量已运行或完成。

## 2026-11-04 后续稳健增强

翻译上下文的 `dialogue_evidence` 保持数据库原值；本字段为 null 时，worker **只读投影** `extra.audio_sources.jp.path`（缺日文时用 `en.path`）为 `voice_asset`。只接受资源路径中真实 `/Cut/<area>/<event>/`，以 area/event 为边界取前后各最多两句同语言源文；不按章节、相邻编号或整个声库拼接。已有非空人工/官方 evidence 优先，不回写或覆盖该字段。增强只影响后续新请求，不重译已完成记录。

`audio_extraction.jp_pairing_unresolved=true` 的广播 EN-only 条目，若同时有 `extra.jp_pairing_unresolved` 的具名整 cue 审计、候选真实 JP 目录行/路径及 SHA，则每次重读候选状态。**全部**候选必须已完成正常 Japanese ASR 和日文独立翻译（空 ASR 必须有 `untranslatable_empty` checkpoint），或本来就有官方 JP 且译文已存在；实际 MP3 SHA、ASR 源 SHA 和当前源文 hash 也要一致。候选尚在排队、仅有文件、ASR失败或只有ASR没译文时继续等待。

满足后在事务中再次检查本行 metadata、候选源文和译文状态，登记 `source_exception.state=jp-already-processed-in-other-rows-pairing-unresolved` 并结束等待。范围仅限当前英文目录行，明确没有建立逐片配对：不写本行 text_jp、不创建 JP 文件、不调用这行 Japanese ASR、不生成/锁定成品。完整候选及已处理阶段的事件引用留在证据中；355 条确证无独立对应资源的 scoped 例外分支保持。


## 日文直接命中的官方人名与有限修复

`preprocess/names.cjs` 仅用于 Remake，不改公共 Rebirth 的英文命中策略。当前本作词表有 73 个确证专名条目（包含全名与简称），89 个通用称呼不参与强制译名；Customer=客不匹配“乗客”，人名不会因为角色标签大写就自动成为专名。Madam M 等 ACTOR 中因敬称而出现不同中文写法的角色，使用本游戏 Resident 同 ID 三语正式名称作依据，不降低通称过滤标准。

日文匹配 NFKC 归一、最长优先，可紧接助词/尊称；以额外片假名词干为边界，避免把サラリーマン、サムライ、コムギ中的子串认作莎拉、山姆、麦子，半角写法同样适用。明确尊称如クラウドさん/クラウドサン可以匹配。只读官方 canonical；日文别名只有 `japanese_aliases_verified=true` 的可信数组，或 `{text,verified:true,evidence:...}` 条目才接受，不猜 ASR 错字或未知名。模型收到别版命中的名字时，`matched_in_current_source=false` 明确禁止补写；译后校验只要求当前待译日文/英文直接出现的名字必须使用官方中文。

Remake 词表提示词追加为独立审核版本 #58，旧 #48 保留，Rebirth 提示词不动。`name-review.cjs` 默认只读审计；`--update-prompt` 幂等追加本作审核版本，`--apply` 仅对确证遗漏官方名字、当前译文等于机器 checkpoint、源文 hash 未变、访问日志证明本流水线生成、人工 review revision 未变且无人工标记的记录排专项复核：

```bash
node studio-ff7-remake/scripts/preprocess/name-review.cjs
node studio-ff7-remake/scripts/preprocess/name-review.cjs --update-prompt --apply
```

旧译始终可见；新译通过官方名校验后，在事务中再次 CAS 源文、旧目标和人工选择，再替换独立译文字段。保留旧 checkpoint、旧译、新旧模型访问日志及复核事件；正确记录和人工修改完全不重跑，不触碰官方 text_zh。

已审计首批 1775 条机器日译中：修正通用称呼词表后，95 条含名译文正确、10 条可安全修复、1670 条无直接人名；2 条 Customer 子串误报排除不动。10 条有限修复现均已完成，旧译和日志保留。扩充词表后只读复查 4055 条已保存日译中，其中 233 条明确含已知人名，均使用官方译名；尚在处理及被校验拦下的失败请求不计入这项已保存译文复查。另实际原声经 Japanese ASR 返回“クラウド。”，不发送官方字幕/英文，仅凭 ASR 命中 Cloud/クラウド/克劳德，真实模型请求 log #2817 正确返回“克劳德。”；乱译“克劳迪”校验拒绝。证据在 `work/preprocess/validation/japanese-name-*`。

发现 `クラウド\nウェッジを送ってやってくれ` 虽带正确词表，模型仍会把首行呼语误当说话人标签而漏译，严格姓名校验已拦截。真实原请求复现 log #6848 后，在 Remake 本库追加 `translation.independent.input` #59（保留原 #46），明确当前条换行只用于显示，行首人名/呼语也是正文，不能省略；仍只翻当前条，不搬用前后文。相同 27B no-think 两次验证 #6849/#6850 均保留“克劳德”和“威吉”。提示词按请求动态读取，无需重启全量任务；不降低校验或手填业务译文。完整证据为 `work/preprocess/validation/leading-name-prompt-probe.json`。

英文简称另有实际失败：`Corneo` 已参与词表匹配，但只展示 canonical `Don Corneo` 或仅增加 JSON aliases 字段，模型仍会输出“科尔诺”。本作 `nameGlossaryText` 现同时列出当前源真正命中的明确映射，如 `"Corneo" → "古留根尾"`，并说明杯赛、地点等复合名也沿用该官方译名。未出现在当前源的另一语言人物名仍禁止加入译文。原请求 #7482 失败、新映射 #7486/#7493 连续通过；新增 glossary 提示词 #60，保留旧 #58。41 项 CPU 回归通过，03:23 平稳重启唯一 runner 加载本作代码；没有修改公共 Rebirth 名称模块。证据 `work/preprocess/validation/corneo-explicit-mapping-probe.json`。

## 源变更异常终态与词义保护

所有分类分支在请求前和模型返回后检查当前 JP 文件 SHA，锁复制前及锁事务内也检查。与旧 ASR/波形记录不一致时，写 `source_exception=source_changed_requires_review`，任务进入独立 `needs_review` 终态，**不计作正常 done**。保留既有原文、译文、ASR 和历史，不盲目重算覆盖，不无限重试旧字轴；此状态表示异常已记录，必须专项审核后再决定重算。长期 runner 的待处理计数排除此异常终态，`--status` 仍单独报告。

纯拟声锁依然要求模型语义分类和独立保守守卫同时通过；はい/いいえ/いい/おい等明确语言表达在提示词和独立守卫中均拒作拟声。不是凭短句、全假名或空正文就锁原声。实际 27B synthetic 反例测试 log #2816：8 个明确日语词句均 speech/reusable=false，4 个兼容非语言/应答对照均通过；synthetic 只写测试日志，没有给任何业务行造声学证据或锁。
