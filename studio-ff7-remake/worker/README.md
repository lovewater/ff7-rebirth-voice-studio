# Remake 游戏资源适配层

公共拍数、音频测量和音频处理服务使用 `../../studio-common/worker/`。本目录负责 Remake 游戏资源索引、只读音频/字幕提取和章节分类；写回及封包仍未启用。

真实游戏位于项目根 `game/FINAL FANTASY VII REMAKE/`。本机已验证25份加密legacy PAK V4、Oodle custom压缩、uasset/uexp配对与SAB2.0/2.1音频。`python3 adapter.py status` 报告 `legacy-pak-v4-read-only`；`extract` 可运行已验证的JP/US提取，`pack` 继续拒绝执行。实际全量完成情况以状态中的 `full_extraction_complete` 和逐源审计为准。

完整工具构建、原始配对导出、断点提取和实际音频回归命令见 [AUDIO-EXTRACTION.md](AUDIO-EXTRACTION.md)，字幕、章节与数据库目录见 [CATALOG.md](CATALOG.md)。55351个JP/US源资源应包含52719份实际音频资产、2632份纯引用包；全部真实音频材料为69406个，另有3574个有证据的零Dummy空槽。不能只取银行首段，不能按相同basename覆盖不同游戏源。

Remake没有原始中文配音，不创建替代CN音频。4/6声道保留全部声道的无损FLAC；混音MP3仅供试听，不用于普通生成。提取过程只写本作work和website/data，不调用GPU、ASR、LLM，也不改游戏文件。

不能把 Rebirth 的IoStore/Zen头、retoc chunk ID、章节或中文语音包覆盖规则套用到本作。写回仍须完成音频与TxtRes原样往返、重读、最小补丁和Win11试听，才可另行启用封包。研究来源见 `../../studio-common/docs/resource-adapters.md`。

字幕封包政策：与Rebirth共用 `subtitle_pack_policy.py`（`original-chinese-subtitles-only-v1`）。本身没有原始中文字幕（`text_zh`为空）的台词，后存的字幕覆盖、制作稿或模型译文一律不进入游戏字幕，音频选择不受影响。将来启用本作封包器时须使用此规则并检查原始资源是否确有字幕；`adapter.py status` 已声明该政策，封包目前仍未启用。
