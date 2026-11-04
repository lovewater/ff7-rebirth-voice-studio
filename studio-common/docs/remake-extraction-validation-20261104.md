# Remake 原声提取与目录验收（2026-11-04）

已完成用户授权的只读日英原声提取、官方字幕与章节/类型归类，并导入独立新站 http://192.0.2.10:8767 。Rebirth 8765 连续运行。

## 完整产物

| 项目 | 实测结果 |
|---|---:|
| JP/US源资产状态覆盖 | 55351 / 55351 |
| 真实音频资产 | 52719 |
| 纯引用包（保留索引） | 2632 |
| 日文MP3 | 34612 |
| 英文MP3 | 34794 |
| 严格Dummy空槽（仅保留证据） | 3574 |
| 完整多声道FLAC | 199 |
| 配对后的台词目录 / 数据库行 | 35180 / 35180 |
| 缺失源 / 校验问题 | 0 / 0 |

69,406 是JP与EN的实际声音文件合计，日英按可靠来源/VoiceID配成同一条目录，所以不等于网站台词行数。英文独有或无法可靠配对的声音独立保留，不按材料槽位猜配对。所有原始语音语言共110732份索引，DE/FR已索引但本轮没有解码。

官方CN/JP/US字幕112份JSON、107220词条；主metadata151份解析零错误，另18份章节触发探查保存独立证据。没有原始中文配音：官方中文字幕作为初稿，所有cn音频指标NULL。

## 章节与类型

章标题来自本作Chapter/官方字幕，包含本篇18章与INTERmission两章。确定单章8790条，跨章候选17433条，通用声库不按章8539条，目录使用待确认418条，缺章节证据0条。

共享地图保留Chapter.LocationResidentID和TruthLocationID的候选；进一步读取StateCondition/Action/LevelSet后，仍缺可靠的对象触发与加载链路，不能仅用故事flag所属章推断每句的实际播放章。具体缺口见本作worker/CATALOG.md。

| 类型（路径/VoiceID证据） | 目录数 |
|---|---:|
| 广播 | 84 |
| 角色战斗语音 | 5453 |
| 战斗对白 | 963 |
| 角色动作语音 | 196 |
| 角色通用语音 | 2890 |
| 地图对白 | 10497 |
| 事件对白 | 4741 |
| 场景对白 | 9938 |
| 目录使用待确认 | 418 |

角色默认名使用本作官方ACTOR至少3条且90%一致的证据，保留别名冲突；主配角由本作人物资产及英文ACTOR互证，不覆盖人工姓名/归类。

## 验证

- 25份PAK索引经解密SHA1核对；961697条完整资源索引独立重建无增减。110702份JP/US原始uasset/uexp全部校验长度、块边界与压缩payload SHA1。
- 69406个真实音频material逐项覆盖；全部MP3重新核对文件SHA256，来源声道、采样率和真实材料索引与独立头部普查一致。
- 199份FLAC全部再次解码，PCM SHA256、帧数、声道与采样率逐一等于源PCM。多声道混音MP3仅供预览，保留完整FLAC，生成参考及直接锁日文接口有保护。
- catalog 13项、资源适配器6项、真实音频5项专项测试通过；生产构建与TypeScript通过。网站全套732项中683通过、49项既有失败，对照基线无新增失败，未把既有测试故障写成全绿。
- 最终8个实际页面/API均200；原中文音频404；普通与银行英文Range返回206，字节与明确配对文件一致。不同JP/EN材料索引配对实际测到3条；英文独有的JP请求404。
- 浏览器日/英音频均实际触发playing及ended，无播放错误；桌面与390px手机页面留有截图。
- 新站TTS版本/自动运行/LLM访问计数均0。Rebirth六个原容器ID、镜像及StartedAt不变，8765首页200。

证据均在本作work：`voice-extraction-audit.json`、`raw-input-validation-summary.json`、`validation/lossless-pcm-audit.json`、`validation/catalog-complete.json`、`validation/final-http-checks.json`及`validation/no-original-cn/`。

## 工具与边界

GitHub来源：[Remake Data Editor作者工作流](https://github.com/jordanbtucker/ff7r-data-editor/wiki/Getting-Started)、[repak](https://github.com/trumank/repak)、[AudioMog](https://github.com/Yoraiz0r/AudioMog)。工具源版本、隔离修补及可重建命令见[提取说明](../../studio-ff7-remake/worker/AUDIO-EXTRACTION.md)，[分类说明](../../studio-ff7-remake/worker/CATALOG.md)。共享工具二进制与只读游戏文件未改写。

只读CLI提取已开放；网站旧IoStore单条提取接口仍保持禁止（API的extractionReady指该旧接口），播放直接使用已导入MP3。封包入口仍禁用，尚未做原样写回、最小补丁及Win11游戏试听。

每日按游戏分离备份数据库及生成tts/embedded/marker。JP/EN原声、无损与raw缓存沿用可从游戏重建的排除策略，不能把它们说成已进入每日生成音频快照。既有Rebirth首次全媒体NAS归档另由独立systemd跟踪，不以本次资源验收代替备份完成。未启动TTS/ASR/LLM/GPU服务，未提交或推送。
