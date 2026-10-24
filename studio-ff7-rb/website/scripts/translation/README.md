# 日文、英文各自独立翻译成中文

该任务为后续翻译对照积累资料，**不会改变网页正在使用的字幕、音频、锁定状态或MOD**。

- `lines.translate_zh_jp`：只依据日文及同演出日文上下文得到的中文。
- `lines.translate_zh_en`：只依据英文及同演出英文上下文得到的中文。
- 不读取原游戏中文字幕、人工改稿或另一源语言，保留三种中文文本的独立对照价值。
- 场景演出依据现有`dialogue_evidence`和`samePerformance`确定边界，沿列表id顺序向前、向后各取最多两条同语言非空字幕，遇到其他演出即停止。没有可靠演出证据或不是演出则仅送当前句。
- 基础翻译提示词和按需追加的官方人名提示词在提示词库“独立翻译”分类的“日英独立中文翻译”组管理，运行时每次读取当前最新启用版本。

## 调用与断点

调用现有通用`self-hosted`适配器，流式、明确关闭思考（`selfHostedThinking:false`→`chat_template_kwargs.enable_thinking:false`）、连续重复10次熔断，单次最多三次HTTP尝试，不回退收费模型。每次模型尝试都进入现有`llm_access_logs`，task为`independent-translation-jp/en`，包含stem、输入、输出、思考及接口实际返回的token数。

翻译输出额度按当前原文（不含上下文）的Unicode码点数`n`计算：`clamp(ceil((64+2*n)/32)*32,96,512)`，最短句96，硬上限512 token。当前日文最长67字对应224，英文最长182字符对应448。请求保留`response_format:json_object`，并对完整输出严格`JSON.parse`，仅接受唯一非空`translation`字符串字段；散文、代码围栏、数组、多余字段都失败重试。适配器对语法不合法及`finish_reason:length`重试，不接受截断JSON；字段不合规进入任务表退避重试。无思考时完全不发送medium、preserve_thinking等设置。通用调用默认仍思考，只有此翻译任务显式关闭，不影响TTS流程。

三个worker逐条领取`line_translation_jobs`，每成功一条即同一事务写译文和done状态。失败指数退避，最长6小时，后续自动重试。进程异常退出不影响已完成项；重启后回收running任务。首次启动排入全部官方日文/英文非空项（两种语言分别计一项），后续不重复已完成项。官方源文hash改变才重新排队，不会覆盖另一语言译文。

`watchdog.sh`持有flock直到Node退出，cron重复启动会直接返回。必须通过watchdog启动后台，不要直接启动第二个runner。

## 运维

真实模型配置存放在ignored目录`website/data/translation-background/model.env`，权限600。变量为`SELF_HOSTED_LLM_URL`、`SELF_HOSTED_LLM_MODEL`、`SELF_HOSTED_LLM_KEY`。可用`TRANSLATION_ENV_FILE`指定其他安全配置文件，值不写进代码/cron/log。

- 启动：`website/scripts/translation/watchdog.sh`，cron按每分钟同命令检查。
- 暂停并禁止cron恢复：创建`website/data/translation-background/STOP`；已在途的最多三条会自然完成，不再取新任务。
- 立即停止：先创建STOP，再向`watchdog.pid`中的进程发送TERM（等待在途完成）或KILL（立即停止、下次启动自动回收）。不要只kill而不创建STOP，否则cron会恢复，这是设计的断点监控。
- 恢复：删除STOP，再调用watchdog或等下一分钟cron。
- 进度：`node website/scripts/translate-dialogue.cjs --status`。
- 调度日志：`website/data/translation-background/run-YYYY-MM-DD.log`。按日分文件，watchdog启动时清理14天前调度日志；完整模型日志保存数据库。
- `--prepare`：只同步任务表，不请求模型。
- `--limit=N`：烟测用，正常长期任务不传。

语法及上下文测试：`node --test website/scripts/translation/context.test.cjs`。迁移为`db/init/065_independent_translations.sql`。

## 官方人名复核

先运行 `python3 studio-ff7-rb/worker/build_translation_names.py`，从游戏 US/CN/JP TxtRes 相同条目ID提取对照。完整清单和来源写入 `work/translation-name-glossary.md`；通用角色称呼只列入清单，不当作具体人名命中。

`node website/scripts/translation/prepare-name-review.cjs` 预览当前英文含人名的句子；加 `--apply` 将两种语言的对应任务重新入队。**只按当前一句英文筛选人名**，最长名称优先且检查词边界，不追加上下句名字，不发送整张表。人名提示只包含命中人物的英文、日文、官方中文名。原游戏中文字幕仍不作为翻译参考；官方人名是唯一术语约束。日文原句未说该人名时，不要求为了英文术语表强行添加。

迁移 `070_translation_official_names.sql` 保存目标词表版本、完成版本、旧译文和优先级。同一词表版本重复准备不再入队；准备时不清空现有译文，成功后才替换独立译文字段，原字幕、音频和锁不变。完成后继续由原有 watchdog/cron 和三个 worker 断点执行。
