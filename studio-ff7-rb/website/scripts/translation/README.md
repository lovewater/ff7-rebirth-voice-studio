# 日文、英文各自独立翻译成中文

该任务为后续翻译对照积累资料，**不会改变网页正在使用的字幕、音频、锁定状态或MOD**。

- `lines.translate_zh_jp`：只依据日文及同演出日文上下文得到的中文。
- `lines.translate_zh_en`：只依据英文及同演出英文上下文得到的中文。
- 不读取原游戏中文字幕、人工改稿或另一源语言，保留三种中文文本的独立对照价值。
- 场景演出依据现有`dialogue_evidence`和`samePerformance`确定边界，沿列表id顺序向前、向后各取最多两条同语言非空字幕，遇到其他演出即停止。没有可靠演出证据或不是演出则仅送当前句。
- 基础翻译提示词和按需追加的官方人名提示词在提示词库“独立翻译”分类的“日英独立中文翻译”组管理，运行时每次读取当前最新启用版本。

## 调用与断点

翻译统一调用现有 `volcengine` 套餐连接的 **MiniMax M3**（请求模型 `minimax-m3`），显式关闭思考，不再调用已拆除的离线自部署模型，不切换其他模型。仅影响参考译文任务，TTS 与改稿的模型路由不变。每次请求仍进入 `llm_access_logs`，task 为 `independent-translation-jp/en`，记录真实模型、输入、输出及用量。

请求使用 JSON 输出，最多512 token；严格解析完整对象，只接受唯一非空 `translation` 字段，散文、围栏、数组和多余字段失败后按原断点策略重试。

三个worker逐条领取`line_translation_jobs`，每成功一条即同一事务写译文和done状态。失败指数退避，最长6小时，后续自动重试。进程异常退出不影响已完成项；重启后回收running任务。仅对官方源文非空、对应参考译文为空的项排队；已填译文不覆盖，写入前再次核对源文hash和译文空值。两种语言分别计一项。

`watchdog.sh`持有flock直到Node退出，cron重复启动会直接返回。必须通过watchdog启动后台，不要直接启动第二个runner。

## 运维

MiniMax 使用生产环境的 `VOLCENGINE_LLM_URL` / `VOLCENGINE_LLM_KEY`，模型按请求明确指定，不依赖全局默认模型，不需要离线模型配置。

`TRANSLATION_STATE_DIR` 可指定独立批次状态目录，`TRANSLATION_SCOPE_FILE` 可指定只含stem字符串的非空JSON数组；种子任务、领取、失败恢复及进度都限制在该范围。`TRANSLATION_PRIORITY_STEM` 可优先补齐用户当前查看的一条。源上下文仍读取完整同演出资料，不因为范围过滤而误接邻句。

watchdog默认读取状态目录的 `model.env`，可保留为空文件，或通过 `TRANSLATION_ENV_FILE` 指定安全配置文件。真实密钥和批次清单均不提交。

- 启动：`website/scripts/translation/watchdog.sh`，cron按每分钟同命令检查。
- 暂停并禁止cron恢复：创建`website/data/translation-background/STOP`；已在途的最多三条会自然完成，不再取新任务。
- 立即停止：先创建STOP，再向`watchdog.pid`中的进程发送TERM（等待在途完成）或KILL（立即停止、下次启动自动回收）。不要只kill而不创建STOP，否则cron会恢复，这是设计的断点监控。
- 恢复：删除STOP，再调用watchdog或等下一分钟cron。
- 进度：`node website/scripts/translate-dialogue.cjs --status`。
- 调度日志：`website/data/translation-background/run-YYYY-MM-DD.log`。按日分文件，watchdog启动时清理14天前调度日志；完整模型日志保存数据库。
- `--prepare`：只同步任务表，不请求模型；watchdog会透传这些参数。
- `--limit=N`：烟测用，正常长期任务不传。

语法及上下文测试：`node --test website/scripts/translation/context.test.cjs`。迁移为`db/init/065_independent_translations.sql`。

## 官方人名复核

先运行 `python3 studio-ff7-rb/worker/build_translation_names.py`，从游戏 US/CN/JP TxtRes 相同条目ID提取对照。完整清单和来源写入 `work/translation-name-glossary.md`；通用角色称呼只列入清单，不当作具体人名命中。

`node website/scripts/translation/prepare-name-review.cjs` 预览当前英文含人名的句子；加 `--apply` 将两种语言的对应任务重新入队。**只按当前一句英文筛选人名**，最长名称优先且检查词边界，不追加上下句名字，不发送整张表。人名提示只包含命中人物的英文、日文、官方中文名。原游戏中文字幕仍不作为翻译参考；官方人名是唯一术语约束。日文原句未说该人名时，不要求为了英文术语表强行添加。

迁移 `070_translation_official_names.sql` 保存目标词表版本、完成版本、旧译文和优先级。同一词表版本重复准备不再入队；准备时不清空现有译文，成功后才替换独立译文字段，原字幕、音频和锁不变。完成后继续由原有 watchdog/cron 和三个 worker 断点执行。
