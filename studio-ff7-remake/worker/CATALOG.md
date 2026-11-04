# Remake 原始字幕与语音目录

本入口只读游戏源资源，输出本作目录与独立数据库，不调用推理、改稿或封包。Remake 没有原始中文语音；CN 是游戏官方字幕，所有 `cn_*` 音频时间字段保持 NULL，`website/data/cn/` 不创建替代原音。

实际运行顺序：

```bash
python3 studio-ff7-remake/worker/extract_texts.py
node studio-ff7-remake/worker/export_metadata.cjs
python3 studio-ff7-remake/worker/build_catalog.py --import
(cd studio-ff7-remake/worker && python3 -m unittest test_catalog -v)
python3 studio-ff7-remake/worker/validate_catalog.py --db
```

`extract_texts.py` 使用同目录只读 `pak_v4.py`，从专属索引提取 CN/JP/US TxtRes 的 `.uasset + .uexp`，再用本机 `programs/bin/ff7r-text-tool` 导出 JSON。DataObject 使用上游 MIT 工具 `jordanbtucker/ff7r-data-editor` 的 `lib/upackage` 读取；工具副本在 `work/tools/ff7r-data-editor`。未附带第三方代码，已有工具环境须先配置。2026-11-03 实物校验为 112 份字幕 JSON、107220 个词条、151 份 DataObject，解码错误 0。

音频提取工具继续负责 `work/voice-extraction.jsonl`。目录脚本只接收该日志中 ready 的真实 clip，未完成资产不会伪装成已入库。日志正在写入时可以运行，忽略未写完的末行，下次补上；完成后必须再导入一次，再执行 `python3 studio-ff7-remake/worker/validate_catalog.py --db --complete`；该模式要求提取已完成、零错误、目录快照覆盖全部 JP/US 源资产，拒绝把中间快照当全量。输出：

- `work/voice-catalog.jsonl`：逐个可播放 clip 的目录、正文、源路径、素材索引、时长与分类证据。
- `work/classification.json`：语言与章节统计、章节标题的源行、无法播放的源资产、已验证的重复包别名。

`--import` 固定核对私密配置中角色 `ff7remake`、数据库 `studio_ff7_remake`、音频目录身份 marker 与数据库实际连接身份，不允许回落 Rebirth。重复执行以 stem 更新自有提取信息，保留已有非空正文、人工候选/锁定与其他 extra；不删表、不复制另一游戏资料。

## 身份与语言配对

原 basename 不是唯一键。同名多路径资源由音频工具加 `__asset<去语言源路径SHA256前12位>`，语音银行的子声音另加真实 EntryIndex 的 `__clipNNNN`。源 basename、完整 asset path、pack、SHA 与 EntryIndex 均保留。

普通单声音资产按去语言后的完整路径配对。银行的 JP/EN EntryIndex 不代表同一句：仅在同一规范化资产内双方 `clip.users` 内部 VoiceID 集合完全一致且各自唯一时才配对。无用户标识或有歧义时保持独立，绝不按数字槽位猜。EN-only 银行目录 ID 附 `__en`，不影响真实音频文件名。

网站英文播放的唯一权威是 `line_meta.extra.english_pairing.en_audio_path`，例如 `en/VO_x__clip0007.mp3`；缺失或 NULL 必须显示无英文，不回退 `/en/<JPstem>.mp3`。`audio_sources.en.clip.audio_path` 是冗余审计证据。`english_pairing.status` 记录配对依据。

## 章节与类型

章标题来自本作 `Resident/Chapter` 的 `ChapterNameID`、Resident 官方中文显示数字与 `chapter_title_*`。源内部编号和显示章节不总相等，例如第8章的文本键是 `chapter_number_0009`，第14章另用 `chapter_number_0014_02`；不能按后缀推断。本篇18章和 INTERmission 两章分开排序。

地图候选来自 `Chapter.LocationResidentID_Array`，并展开 `LocationResident.TruthLocationID`。候选唯一才落确定章节；跨章地图保留候选列表及 `SHARED_*` 区域；未找到证据保留 `UNASSIGNED_*`。共享地图需要实际剧情触发数据进一步细分，不能仅按事件编号、文件排序或熟悉的剧情印象补单章。战斗银行独立置于跨章节类别；本作新增挑战与 DLC 语音不得塞到本篇最后一章。

类型直接保留资源路径证据：`/Cut/` 是场景，`/Field/` 下 `BA_*` 为战斗对白、`PV_*` 为事件对白、其余为普通地图对话，`/Character/` 为战斗语音银行。没有字幕时保留无字幕事实。`PV_*` 不自动宣称适用场景口型流程。

正文按真实 VoiceID / 单音源 basename 对齐官方字幕；同 ID 多个地区正文冲突时优先唯一相同源地区，否则标记歧义，留空。不能把银行总文件名对应的一句字幕复制给全部子声音。人物优先保留字幕 ACTOR 原文及源 speaker code；无明确角色证据的银行保持原银行标识，不套用 Rebirth 人物表。

## 预览保护

每条目录都显式写 `extra.audio_extraction.eligible_for_generation`。只有真实可用的 JP clip、源可靠且不属于预览素材时为 true；JP 缺失、失败、未提取或多声道电影预览均为 false。4/6声道保留完整 FLAC，stereo MP3 只供试听。英文的多声道状态不能错误禁用正常的 JP，也不能把不存在的 JP 映射成英文。

本步骤不代表已验证 Remake 的写回、PAK 封包或 Win11 MOD 播放。

## 分类口径补充（2026-11-03 实物复核）

角色通用/战斗声库的章节状态是 `not-applicable`，summary 单独计 `chapter_not_applicable`，不计入剧情章节失败。`content_classification` 进一步区分场景、地图、事件、战斗对白、角色通用声库、角色动作和广播；动作仅依据内部 VoiceID 的明确 `atk_` / `damage_` / `guard_` 等名称，不凭音量、音长推断叫声或情绪。`AN_*` 仅标广播类命名证据，不发明说话内容。

`000-COMON` 对应的 LocationResident 实物有 `UnuseRelease=1` 和 `Detail=召喚テスト`，但这只是 Location 的发布/测试标记，不能证明整个语音目录未使用；声音可能被其他地图、VR或DLC跨目录引用。`002-IGNOR` 无该标记，只能说目录使用待确认。两者均完整保留，进入“公共/测试目录 · 使用待确认”区域，`resource_usage` 保存原始 Location 字段与证据层级，绝不写 `asset_unused=true`。这类目录不列为普通剧情自动流程，`dialogue_mode=unknown`；原声可用性与是否实际使用分开记录。

官方字幕含 `♪` 时，`performance_tags.singing_subtitle_marker` 为 true，证据列出对应语言、TxtRes、ID与原标记。这个标记只表明字幕的音乐符号，不能替代实际听辨、唱段识别或声学情绪。

真实112份字幕共107220词条，按 language + ID 的全量审计暂未发现跨文件重复 ID 或不同正文冲突（各语言均0），统计保存在 `classification.text_index_audit`。代码仍保留所有同ID来源，绝不 last-win。回归覆盖了相同ID在COMON/PSBL正文冲突的情况：准确源区优先；无法唯一时返回待配与全部候选文件。每条字幕证据同时保留源区解析口径、内部 VoiceID 或单声音源 basename 绑定；验收会重算匹配，而不是只检查某份字幕中存在相同正文。

已深查 `Location.SlotChapterID_Array`、`StoryJump`、Story/StoryResident、StoryFlag、TalkSequence/State/Group、PlannerEvent 等151份 metadata。它们能确认共享地图跨章、对白ID及章节名，但现有显式字段尚不能把共享地图每句语音绑定到特定剧情 slot。StoryFlag中名字含某事件不等于显式事件引用，因此没有以名字包含关系强缩章；继续保留候选。

上述是第一阶段151份表的结论，后续专项已扩大到全部1111份DataObject，并以独立章节overlay补充，见下文。未缩小的候选仍保留；这段不能解释为后续没有深入运行时引用。

## 人物默认名与主配角（2026-11-04）

本作 `TalkSpeaker` 实物只有占位行 `aaa`，无法用它初始化人物。默认名改为对全量官方TxtRes的非空ACTOR计票：至少3条、同名占比至少90%才填默认中文/日文名。`speakers.note` 保存样本ID、各标签计数与冲突/变装别名；逐句 `line_meta.actor_*` 原标签继续保留。源名字缺失时不能用第一条空ACTOR永久锁死该code。`BA_*` 中末尾无数字的 `..._tif` 等真实命名同样识别speaker code。

主配角只在上述官方英文ACTOR也达到阈值，且与本作实际 `Character/Player/VO_PC*`、命名 `NonPlayer/VO_NP*` 或命名敌方 `VO_EB*` 的标签明确一致时填 `cast_members`。Player映射主角，明确命名NPC/敌方角色映射配角；通用杂兵 `VO_EN*` 不因此成为配角。英文名与内部标签无法互证的角色继续保留在其它类别，不把熟悉剧情当成导入证据。银行中文名通过同一资产标签与官方ACTOR互证取得，不手填Rebirth人物表。

导入只补 `speakers` 的空名，保护现有非空人名、人工来源及备注；`cast_members` 已有行完全不覆盖。无TTS、LLM或模型调用。

## 共享地图进一步只读探查

在独立 `work/metadata-probes` 又解析了030-SLUM7、080-SLU5B的18份DataObject：StateCondition、StateTrigger、StateChange、Action/ActionGroup、EnvironmentSet/ObjectEnvironmentSet、PlannerLevelSet/ObjectPlannerLevelSet。找到172条Action对具体EV的显式引用，但其中只有EV_SLU5B_1490的3个Action有直接StartStateCondition，其条件是一个故事flag，不能等同当前章限制。其它事件需沿对象状态、触发器和加载图追踪，尚无已验证的“此事件唯一归某章”的闭合链路。故事flag归属章和当前实际播放章不同概念，不能仅据名字内的Chapter数字或引用过某个flag缩章，因此本轮保持共享候选。独立探查不改变主151份metadata和全量提取程序。

## 2026-11-04 全表解码与章节专项复核

上游Data Editor的 `readFName()` 丢弃了UE的FName实例编号，会把不同 `_100`、`_110`、`_120` 行错误解成同一名字。本工程的只读适配器 `remake_dataobject.cjs` 按实际UE规则保留编号：number非零时后缀为 `number-1`。格式与本机retoc的 `name_map.rs` 互证。原始151份和后续1111份均重新解码，1111份0失败、0重复行名；旧有损缓存单独保留，`metadata-probes` 的旧探查输出不再用于规则。对已有7966条规则逐条比较，修复后0条删除、0条改章，另找到464条新证据；不能因为旧结论未变而继续使用错误decoder。

`refine_catalog.py` 是独立章节/人物overlay，`build_catalog` 按 JP恢复→缺源/广播补证→章节overlay 顺序回放。规则及每次应用记录保存在 `work/chapter-refinement/`。CAS更新只改自己仍拥有的region及自身extra键；人工区域、人工人物、正文、音频、ASR、机器译文与锁定选择不覆盖。

本轮已真实应用9183条共享地图细分规则。确定单章现为8790条原始单章加9183条专项，共17973条（含本篇与INTERmission）。另8539条角色通用/战斗银行是 `chapter_not_applicable`，不算分章失败；418条公共/测试目录使用仍待确认。剩余8250条候选中，场景过场49条/9事件、地图对话6785、PlannerEvent对话1287、战斗对话129。原始 `chapter_candidates` 与分类证据全部保留。

证据层级必须分开：

* `high-confidence-scene-inference`：本地官方英语正文与分章剧本的独特长句，或同一个实际Cut事件的多个不同短句共同命中；NextPE/NextCutScene显式连通仅在独立锚点同章且无冲突时扩展。另37个具体场景经短句组合与剧情攻略/官方访谈审阅，不能把这组人工审阅规则泛化成低阈值全库自动匹配。
* 实际 `_Character.uasset` 动画引用：`probe_chapter_assets.py` 只读626个源资产、覆盖313个共享地图过场，记录源SHA和导入的实际角色动画名。特定非人boss结合本作Enemy Blueprint及分章攻略定位；仅出现Reno、Sephiroth等跨章人物不足以分章，也不按资产数字编号猜剧情先后。
* 另有17个经明确审阅的有限PlannerLevelSet场景组：严格比对实际LevelList，至少两个不同成员事件的独立对白锚点同章，全组不得有章冲突，才补同组短呼声。例：第14章Leslie/Abzu返程组与第18章Sephiroth战斗相位组。加载在一起本身不证明同章，未推广到所有LevelSet/整张地图。
* 对两段原始 `.emov` 用CPU只读解帧核看：`MV_SLUM7_4670` 的4/20/40秒为七号街支柱崩塌及Wedge与猫，归12章；`MV_SBIL0_7710` 的10秒为Whisper白色异空间，结合原句归18章。`chapter_refinement_movies.json` 保存完整电影SHA、帧时间/路径/SHA；电影、帧、音轨均未改动，不把嵌入Opus音轨当成新台词导入。
* `known-current-chapter-flag-and-conservative-reference-union`：实际 `Chapter.RaiseStoryFlag_Array/DropStoryFlag_Array` 证实当前章Start flag互斥；章号采用官方显示章而不是flag后缀。`chapter_logic_masks.py` 对完整1111表的175508节点做三值求值和所有引用路径允许章的并集，只排除能确定false的章节。未知flag、缺常量、不支持的混合逻辑/内部括号、未建模入口和环都按unknown处理；否定先作用每条定义，再求并集。现22条能缩为单章（14条魏斯介绍原已归17，8条为新增）；所有9183条既有归章也纳入冲突审计，不能只审剩余SHARED。

上面运行时分析是DataObject范围内的保守引用覆盖，未声称完整Blueprint/C++二进制排他证明，规则统一 `runtime_exclusivity_proven:false`。一条未约束路径不能证明同一资产真实跨章播放；同样，网页某章未列出台词不能证明它在其它章不播放。若以后取得真实第二章播放引用，应撤销与之冲突的网页单章推断。当前没有把未知可能性伪装成已证实跨章复用。

边界反例：博客把 `EV_UNDG6_0010` 的神罗董事会放在Chapter10标题前，但另一完整剧本及实际第10章游玩记录明确它是第10章开场。13条以复核后的10章归类，保留博客9章边界冲突。相反，Cloud/Tifa“second thoughts”对白在3、4章文字重复，但本机是不同VoiceID，不能据文字相同误报同一语音复用。

主要公开资料（仅作本地资源的定位证据，来源URL与短锚点随规则保存）：

* [全章英语剧本](https://game-scripts-wiki.blogspot.com/2020/04/final-fantasy-vii-remake-transcript.html)：解析18章、5989个speech turn，缓存SHA与每个命中turn记录。
* [Square Enix第4章制作访谈](https://www.square-enix-games.com/en_GB/news/final-fantasy-vii-remake-revisited-chapter-4)及[第14章访谈](https://www.square-enix-games.com/de_DE/news/final-fantasy-vii-remake-revisited-chapter-14)：Whisper袭击Jessie、三种决意分支等明确剧情。
* [PowerPyx分章攻略](https://www.powerpyx.com/final-fantasy-7-vii-remake-chapter-17-deliverance-from-chaos-walkthrough/)及各规则中具体章/任务链接：特殊boss、Drum、叶子之家、营救Johnny等场景互证。
* [独立Steam版日英文本dump](https://vgtextdump.neocities.org/ff7r/)：作者明确按area分组，3/4/12、8/9/10/13/14、16/17/18仍混在一起。可以核对正文，不能把页面标题当成额外单章证据。

人物采用本作PC/NP Blueprint、同VoiceID官方ACTOR与PlannerEventChara的明确模型关系互证。Player主角前缀实物为PC；借Cloud模型占位的Old Snapper不能因此归主角。保留每句原始ACTOR、别名计数与冲突证据，默认名仅填空、不覆盖人工。专名与通称及翻译输入保护见 [NAME-GLOSSARY.md](NAME-GLOSSARY.md)。

全量验收另对照独立SAB头普查 `indexes/voice-materials.jsonl`：55351个JP/US源中52719为真实音频、2632为引用包；真实material目标为69406个（JP34612、EN34794）。`validate_catalog --complete` 要求每个真实 `(source_path, material_index)` 恰被目录音源或有PCM证据的明确别名覆盖，排除3574个零Dummy，拒绝只凭源文件总数宣称全部声音已处理。
