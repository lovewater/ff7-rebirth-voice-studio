# Remake 只读语音提取

真实源：`/srv/ff7-sound/game/FINAL FANTASY VII REMAKE/End/Content/Paks`。25 个 PAK，V4 IndexEncryption；不是 Rebirth 的 IoStore。原游戏只读，工具输出都放本作 work 和 website/data。

公开 AES 来自工具作者文档 https://github.com/jordanbtucker/ff7r-data-editor/wiki/Getting-Started 的 UE Viewer 步骤，保存于本机 `.private/pak-aes.txt`（600），`pak_v4.py` 也接受 `FF7_REMAKE_AES_KEY`；不把该本机配置当源码发布。

## 工具

`python3 studio-ff7-remake/worker/prepare_audio_tools.py` 在 `work/tools` 编译本作专用 repak 与 AudioBatch，不覆盖共享二进制。

本机工具源版本：repak `355b5f62f51959c7cc6dd5a51708646ef483065d`、AudioMog `102ffc1c5a6ca532bc1f7e19d001079ff5106926`。实用二进制与DLL的大小/SHA256记录在 `work/tools/validated-toolchain.json`，本次两处修补的完整diff为 `work/tools/repak-remake-legacy-compression.patch`，可重建逻辑已保存在上述脚本。

repak 0.2.3 的两处旧压缩表误把旧 custom/Oodle flag4 当作连续索引越界；本作隔离副本插入保留槽。`pak_v4.py` 是独立只读实现：索引 SHA1、数据/压缩块 SHA1、解压长度和边界严格验证。真实样本与修补的 native repak 输出逐字节相同。

AudioMog 的终端批量参数会重用 extractor 内字典，从第二个文件开始重复 material index。AudioBatch 使用同一官方应用 DLL，但每个文件新建 service，支持本作52503份SAB2.1剧情/普通对话资产和216份SAB2.0角色库，按实际内部结构导出全部 material（版本预期告警不是改文件或强转版本）。它另存 materials.json，检查真实 material 与 WAV 覆盖；Dummy+零大小/零声道/零采样率是明确空槽，保留元数据而不造音频。

## 已抽原始资源及全量转换

从现有只读游戏重建的完整命令如下。首次先将上述公开AES配置到私密文件，再构建工具；本作工具只生成本作work缓存。

```bash
python3 studio-ff7-remake/worker/prepare_audio_tools.py
python3 studio-ff7-remake/worker/prepare_voice_sources.py --export
python3 studio-ff7-remake/worker/verify_raw_voice.py
python3 studio-ff7-remake/worker/probe_voice_materials.py
python3 studio-ff7-remake/worker/adapter.py extract --workers 4
python3 studio-ff7-remake/worker/audit_voice_extraction.py --hashes
```

`prepare_voice_sources.py` 默认只建立完整索引，只有显式 `--export` 才用隔离的repak导出JP/US的uasset/uexp。它逐个验证25份PAK的解密索引SHA1；本次独立重建与先前native repak列表961697项逐项一致，语音110732项也没有遗漏/新增，证据在 `work/indexes-reproduction-check/comparison.json`。

`work/indexes/pak-files.jsonl` 有全部 961697 资源索引；voice-assets.jsonl 保留 JP/US/FR/DE 所有 Voice uexp。当前目标 JP27573 + US27778 =55351 个源资源，含引用包；原始 JP/US 配对资源已全部解到 `work/raw-voice`（3.1GB）。不提取 SE/BGM 为配音，不生成中文音频。

```bash
python3 studio-ff7-remake/worker/extract_voice.py --workers 4
```

断点文件 `work/audio-manifests/{sha256(asset_path)}.json`；每处理一批更新 `work/voice-extraction.jsonl` 和 `work/extraction-progress.json`。错误有明确状态和日志，批次异常不会静默漏掉源资源。确认上一个任务已结束再重跑；pack 继续禁用。

完整身份是 pak/path/language/material index。若任一语言存在同名多路径，跨 JP/US 去掉语言目录统一确定 path hash，输出 `source_stem__asset<hash12>`；多 material 再加 `__clip<真实index四位>`。单 material 普通资源维持源名。原始 source_stem 始终保留，用于字幕匹配；不可按 basename 覆盖，也不可假设语言银行 index 顺序一致。每条保存实际 users 与 TrackUsers 原文。

每个 MP3 都做 ffprobe 与实际 native 解码，记录真实 sample 数和成品时长。小于等于1ms的编码采样舍入独立记录，不用容器填充冒充源时长。完整源 PCM SHA、采样率、声道等都保存。

超过2声道的资源保存完整 lossless FLAC，并把所有声道混合为 stereo MP3 **仅供预览**；manifest标 `special_handling=multichannel-preview-only`、`eligible_for_generation=false`。FLAC实际解码 PCM SHA 必须与源 WAV 所有声道完整相同；不能取首声道冒充源音。这里并未实现其声道替换/封包。

Build/EndAssetPack 只引用包、无SAB/MAB音频流时标记 reference-only，保留来源 SHA，不作为新台词/失败或伪造空音频。实际银行 material 不会只取第一个；重复来源仍需要按 users/PCM SHA 在工作目录 catalog 整理别名。

独立只读材料普查 `python3 studio-ff7-remake/worker/probe_voice_materials.py` 按 AudioMog 头部/section 结构遍历全部原始资源，不做音频解码。实物目标为52719音频资产、2632纯引用包；72980材质槽中，69406个HCA音频、3574个严格零Dummy空槽，没有全空音频资产。源声道为69127 mono、80 stereo、49四声道、150六声道。它与已产生的AudioMog材料sidecar逐字段比对，详细记录见 `work/indexes/voice-materials{,-summary}.jsonl/json`。

全量结束后执行 `python3 studio-ff7-remake/worker/audit_voice_extraction.py --hashes`，从源索引独立核查逐源状态、真实材料索引覆盖与header声道/采样率、每个MP3大小/SHA、输出路径唯一性、多声道无损文件及预览用途限制；结果写 `work/voice-extraction-audit.json`。只有缺失0、问题0且目标完整才为complete。源资源校验另见 `work/raw-input-validation-summary.json`，全部110702个uasset/uexp文件经原始entry长度/块边界/压缩SHA1验证，无错误。

真实音频回归：`python3 -m unittest discover -s studio-ff7-remake/worker -p test_audio_extraction.py -v`。本次样本证明 Reno 银行156槽=139音频+17零Dummy、四条6声道无损完整、同名多目录不会覆盖、独立Pak读取一致、引用包不伪造声音。

提取授权不代表音频回写或 Win11 游戏测试完成；封包仍未验证。JP/US全量是否完成以 progress.complete 和逐源状态为准，不能把已有样本当全量成功。

每日NAS快照沿用既定范围，只归档生成音频tts/embedded和数据库；jp/en及jp-lossless/en-lossless是可从只读原游戏按上述命令重建的原声缓存，不在每日生成音频快照内。不要把提取完成说成这些原声已备份到NAS。

## 2026-11-04 全量完成记录

本次4 CPU独立提取完成，55,351源全部有最终记录：52,719真实音频资产、2,632纯EndAssetPack引用包，错误0。全部72,980材质槽已交叉检查：69,406真实音频（JP34,612 / EN34,794）和3,574严格零Dummy空槽，没有漏掉银行子clip。完整原始提取耗时3,911.7秒。

最终 `audit_voice_extraction.py --hashes` 实际读回全部69,406个MP3的SHA256，与逐源manifest相同，正式目录未引用MP3/FLAC均为0，缺失0、问题0、complete=true；证据 `work/voice-extraction-audit.json`。最终独立header普查与52,719份AudioMog材料sidecar逐字段一致，0错误。全部199条4/6声道FLAC另经独立完整解码，与源所有声道PCM SHA/frames/channels/sample-rate相同，证据 `work/validation/lossless-pcm-audit.json`。5项真实音频回归及6项适配器边界回归通过。

早期47条未加源路径hash的同名试听样本均与正式成品SHA相同、数据库无引用，已移入 `work/retired-basename-previews-20261104/jp/`（不删除，不计入正式产物）；证据 `work/orphan-preview-audit.json`。这些只是本轮实验旧名文件，不是丢失的语音。原始音频与字幕导入完成仍不代表封包/Win11验证完成，pack保持禁用。

2026-11-04 后续缺JP专项另恢复171个字节一致的JP播放别名，原始JP34612、原始全部material69406不变；当前正式MP3数为69577（含171注册别名），审计明确区分，不把别名当新素材或孤立文件。细节见 [JP-RECOVERY.md](JP-RECOVERY.md)。
