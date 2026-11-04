# 台词「跳过」状态

用户决定暂不制作当前安装中没有对应独立日文资源的EN-only台词，覆盖此前第一章5条英文参考补做的使用策略。

`094_line_processing_state.sql` 为 `lines` 添加独立的 `processing_state=active|skipped`、`skip_reason`、`skipped_at`，并添加 `line_processing_events` 审计。它不是旧 `skip_timing`，也不是某个音频版本的 `review_state`。原有音频、字幕、锁定选择和自动运行历史保留；取消跳过直接恢复原有选择，不重新生成。两款游戏分别存储状态。

详情页可跳过/取消跳过；列表、移动审核页、轮询快照和首页显示状态，支持 `flag=skipped`。跳过优先于人工异常及历史锁定的健康显示；不计入正常、待确认、未生成或已处理计数，另计 `skipped_n`，也不再显示日文预览警告。已处理加跳过覆盖整个章节且没有待处理时，章节仍算完成。

自动入口在读取台词和创建任务事务中各检查一次状态，forceGenerate不能绕过；排队任务执行前重新检查。已跳过直接返回，不创建空运行、不调用LLM、ASR、TTS。手动两种TTS接口返回409/LINE_SKIPPED，须先取消跳过。状态API与自动建任务共用台词行锁；正在自动运行的台词拒绝修改状态，避免执行中换状态。Rebirth全量、增量共用的普通锁定、补充资产和战斗库读取均排除skipped；Remake封包仍未开放，未来适配器也必须遵守此状态。

本次只按明确的 `jp_source_absence.scope=no-corresponding-independent-jp-resource-in-installed-game` 和 `audio_extraction.jp_source_absent=true` 批量标记355条。逐条核对来源证明及JP文件确实不存在，单事务落库并审计；保留18个已有版本与5个锁定，逐份音频SHA、版本字段和锁定ID复核未变。不把文件暂时丢失、低音量或待关联当成缺源。42条广播已有真实JP候选，逐片关联未定，继续active，不按slot猜配。

第一章当前：总计685，已处理680，跳过5，待处理0，仍完成。原685条锁定记录仍在，其中5条因跳过暂停生效；不能再把全部锁定记录数当作实际使用数量。历史自动169通过/14失败保留，不改写历史统计。

167项网站相关回归、45项worker打包回归、TypeScript、生产构建通过；ESLint无错误，保留两条历史unused警告。浏览器验证跳过/恢复、原锁定保留、灰色状态、筛选；HTTP验证强制自动入口直接跳过、两个TTS入口拦截。两站已部署 `sha256:15ed69c302486ff6e18ce24c5147d4f721f38d7aed014e8b281b9df2b75fa648`，Remake355跳过、Rebirth0；未启动推理或封包。

断点与证据：`work/skip-missing-jp-20261105/private/{plan,applied,validation,deployment,http-generation-guards}.json`。批量脚本 `apply_skips.cjs` 仅限冻结355、校验游戏身份/源证据/既有音频，重复运行保留已有跳过原因。日后若真实JP恢复或用户要求使用英文，先核对来源，再由详情页取消跳过；不要修改历史音频或伪造JP。

## 2026-11-05 补充：列表与统计完全排除跳过

按用户最新要求，processing_state=skipped不再出现于列表、筛选选项、人物数量、首页区域数量、已处理数量、分页/异常队列定位或项目API数量，移除“跳过N”统计卡片。即使手填flag=skipped也返回空列表。直接详情仍能查看原因并取消跳过，历史版本及锁定不删除。Remake有效总数34825（35180−355），第一章有效680条/已处理680条；原先685含跳过5的口径已取消。Rebirth当前无跳过条目。两个网站已上线；验证记录work/hide-skipped-lines-20261105/private/。


## 2026-11-05 追加：忽略无法确定日文配对的英文孤立条目

用户明确要求将an_town8_AnnounceA__clip0000__en等条目忽略。42条无确定JP配对的孤立EN行已通过processing-state接口设为skipped；原因注明对应JP已在独立条目存在、逐片配对未定，不误报为日文素材不存在。独立JP条目继续正常制作，现有版本/选择不删除。列表及统计沿用统一active过滤，不新增另一套忽略状态。
