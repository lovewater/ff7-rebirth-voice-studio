# Remake / Rebirth：公共流程与游戏资源适配（2026-11-03）

结论：校对、合成、核字、对时、人工锁定的业务流程可以复用，游戏资源的读取和写回不能只换路径。
这份核查阅读了本机源码及上游工具作者文档。后续游戏已到齐，2026-11-03 用户授权只读提取并分类；本机已验证 Remake PAK、SAB 音频、字幕和章节 metadata 的提取。音频写回和封包仍未验证。

## 已确认的区别

| 层 | Rebirth 当前已验证实现 | Remake PC Intergrade 的公开依据 | 处理方式 |
|---|---|---|---|
| 引擎配置 | 本工程 UE4.26 / IoStore | FModel 的兼容表归入 UE4.18，使用 `GAME_FinalFantasy7Remake` 自定义版本 | 两套游戏配置，不把裸 UE 版本当作已验证的通用解码参数 |
| 外层资源 | `.utoc/.ucas` 与 `.pak`；按 chunk ID 读取，Zen 资产 | 作者文档及本机25份加密PAK V4实物，分离的 `.uasset`、`.uexp` | Rebirth 用 IoStore 适配器；Remake 用专属 legacy pak 读取器 |
| 字幕资产 | 本工程的 Zen/TxtRes 读取与写回 | ff7r-text-tool 源码把 `VER_FF7R` 与 `VER_FF7R2` 分开；前者另读/另写配套 `.uexp`，后者解析 ZenPackageSummary | 工具二进制可共用，资产入口、头与测试样本按游戏区分 |
| 音频容器 | 本机已验证 SQEXSEAD / HCA 与 AudioMog | 本机确认SAB2.1剧情资产及SAB2.0角色库、HCA流、Dummy空槽及纯引用包 | AudioMog每文件独立实例解码，真实材料索引全部保留；写回仍须单独验证 |
| 最终补丁 | 现有中文包同名 `zzz_cn_voice_*` 三件套及单独字幕补丁 | Data Editor 作者文档将 Remake 修改后的资源重新封为 `.pak` | Remake 不继承 RB 的 IoStore 三件套、9 个中文包、chunk 覆盖优先级或增量基线 |

注意：Rebirth 也有 `.pak` 文件，因此不能仅看“存在 pak”就判为 legacy；要记录 `.utoc/.ucas`、pak 信息、资产头和对应文件。
公开兼容表是工具作者在收录时的验证，不能替代本机实际版本验证。

## 这次已落地的公共边界

`studio-common/worker/` 保存一份真实的 CPU 源码：

- `mora_core.py`、`mora_weights.py`：拍数与读音计算。
- `speech_activity.py`：安全路径、真实波形静音和净发声时长。
- `mora_server.py`：拍数 / 音频指标 HTTP 服务。
- `speech_metrics_batch.py`：同一游戏数据库中的指标队列及缓存。
- 对应四组旧回归、配置隔离回归及 Remake 只读提取开放/未验证封包拒绝回归。
- `requirements-mora*.txt`、`Dockerfile.mora`：构建仅引用本上下文内的真实文件。

Rebirth 原 `worker/` 的这些路径保留兼容软链接，其余游戏脚本原位保留。
现网容器运行镜像内代码，本次移动源码不需要停止或重建 Rebirth 容器。
每款游戏分别启动 CPU 服务实例，分别传数据库和音频根，不能把 Rebirth 的数据库维护线程当作全局共享服务。

`game_runtime.py` 在任何数据库扫描前校验游戏身份。
Remake 必须显式指定 `FF7_GAME_ID=remake`、`studio_ff7_remake` 数据库、`ff7remake` 账号、绝对 `AUDIO_DATA_ROOT`，
且根目录 `.ff7-game.json` 必须声明同一游戏和数据库，缺项或误绑 Rebirth 数据立即拒绝启动。
`GET /health` 返回游戏 ID，不显示凭据。
Rebirth 无游戏标记时保留旧默认行为；`GOLDE` 指标优先级只属于 Rebirth 配置，不施加到 Remake。

## 继续留在 Rebirth 适配层的代码

- `index_jp_voice.py`、`index_en_voice.py`、`extract_one.py`：IoStore 枚举 / chunk ID 提取。
- `catalog_cn.py`、`cn_iostore.py`、`extract_cn*.py`：原作者中文包容器与索引。
- `extract_txtres.py`：当前 Zen/TxtRes 解析及语言目录。
- `fill_regions.py`、`regions.py`、`fill_speakers.py`、分类脚本中的游戏章节 / stem / 人物映射。
- `build_mod.py`：Zen ExportMap 修复、源容器头 / ID / Oodle 块复用、同名中文语音包覆盖、切片声道布局和 Rebirth 安装说明。
- `mod_incremental.py`、`battle_bank.py`：包含可复用的哈希 / 清单 / SAB 原语，但当前策略标签和经验证结构仍绑定 Rebirth；本次不冒充 Remake 已验证实现。

当前 `programs/ff7sound unpack-paks` 和 `pack-mod` 实际只包装 `retoc to-legacy / to-zen`，默认 `UE4_26`。
尽管 CLI 描述写“Remake/Rebirth”，它目前没有按游戏选后端；Remake 不能直接调用这两个命令作为验证后的流程。
公共 `repak` 原二进制不变；本作隔离编译修补旧压缩表的版本，在原始游戏样本中与独立 Python PAK 读取器逐字节一致。索引SHA1、压缩块边界、payload SHA1及解压长度均验证。AudioMog批处理实例复用问题通过逐文件实例解决，未修改游戏头冒充受支持版本。

## 实物提取及仍待完成的写回验证

1. 已只读记录25份PAK及961697条完整资源索引；语音JP/US/DE/FR共110732份，当前选择JP+US的55351份源资产。110702个JP/US配套原始文件已完整提取并校验。
2. 已实测剧情、广播多材料、角色库和4/6声道等真实样本；112份CN/JP/US字幕及151份DataObject已解析。独立音频头普查目标为52719份音频资产、2632份纯引用包、69406个真实音频和3574个Dummy空槽。全量进度与逐文件验收必须读取本作work，不能以样本成功冒充全量完成。
3. 原样回写，不改变音频或文字，封包后重新提取，比对未改字节、文本和音频采样 / 声道 / 长度。
4. 再替换一条人工指定音频和字幕，制作最小补丁，确认游戏语言槽、实际装载优先级及 Win11 试听。
5. 只读提取和目录导入已按用户本次授权开放：`studio-ff7-remake/worker/adapter.py extract` 调用专属工具，不回落 Rebirth；`pack` 继续拒绝，只有前述回写、最小补丁及实机验证通过后才另行开放。

具体可重建命令、工具版本及源码补丁见 `../../studio-ff7-remake/worker/AUDIO-EXTRACTION.md`，字幕/章节/类型证据及最终完整验收见同目录 `CATALOG.md`。章节来自Chapter/LocationResident真实字段；共享地图保留候选章节，不按文件编号猜测。没有原始中文配音，官方CN字幕只是初稿；不复制另一游戏音频或制造CN原音。超过2声道的完整FLAC保留，混音MP3仅供试听，不能作为可替换/克隆的完整源音。

2026-11-04最终结果：55351源状态完整，69406个JP/EN音频全部SHA验证、199份FLAC重新解码与源PCM一致、零遗漏/错误/孤立文件，35180条配对目录已入独立库。章节与类型、线上接口和测试结果见 [全量验收报告](remake-extraction-validation-20261104.md)。

每个资源索引应携带 `game_id`、容器类型、容器名、包内路径和配套文件；`chunk_id` 是 IoStore 可选字段，不是跨游戏强制主键。
发布清单携带游戏 ID、游戏版本、适配器版本及文件列表；不把“三件套”当作公共输出契约。
各游戏的 `work`、增量 state / cache、音频、SQL 数据库、NAS 备份和 MOD 发布目录分别隔离。
当前 RB `build_mod.py` 的 `SMB_ROOT=/srv/backups/ff7-backup/rebirth/mod`、`work/mod-build` 不能直接给 Remake 使用。

## 保留的独立待处理项

本次保留现网实际算法。公共 `mora_core.py` 与网站旧代码仍有 1.33 常数，与根 AGENTS 的 1.20 规定存在冲突。
这是已有口径问题，不在代码搬迁时顺带改变，也未据此重算 Rebirth 数据。

## 原始来源

- [Remake Data Editor 作者：Getting Started](https://github.com/jordanbtucker/ff7r-data-editor/wiki/Getting-Started)：pak、uasset/uexp、提取与重新封包工作流。
- [FModel 兼容表](https://github.com/FModel/Game-Compatibility/blob/master/VERIFIED_WORKING.md)：Remake Intergrade 的引擎及自定义游戏配置；该表同时注明不保证音频播放器 / 模型播放器。
- [ff7r-text-tool 源码](https://github.com/matyamod/ff7r-text-tool/blob/main/core/assets.go)：两个版本的资产头和独立 uexp 读写分支。
- [AudioMog 作者说明](https://github.com/Yoraiz0r/AudioMog)：支持的音频容器、uexp 配套文件和游戏参数差异。
- [retoc 作者说明](https://github.com/trumank/retoc)：IoStore / Zen 与 legacy 转换边界。
- [repak 作者说明](https://github.com/trumank/repak)：legacy pak 的读取、导出、封包和加密参数。
- [Epic 对 Square Enix 的开发者访谈](https://www2.unrealengine.com/developer-interviews/how-square-enix-impressively-optimized-final-fantasy-vii-remake-intergrade-for-next-gen)：原 Remake 基于 UE4.18、Intergrade 合入部分后续引擎功能，不能据“同属 UE4”推断资产格式相同。
