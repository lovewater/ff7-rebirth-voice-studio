# FF7 Rebirth 中文配音修订工程

给后续 agent / 自己续工用。本仓库在 Linux 上拆包、改音、打差量模组；游戏在 Win11 上试听。

## 这是什么

在别人已经做好的 **FF7 Rebirth 1.005 简体中文语音包** 上做增删改查，不是从零翻 14 万条。

现成包占用 **日语语音槽**。Win11 安装：`zzz_cn_voice_*_P` 放进 `End/Content/Paks/~mods`，游戏语音选日语。

修订写回游戏已经在播的 **`zzz_cn_voice_*_P`**。`~mods` 里同优先级的包，同一个 chunk 先挂上的那份生效，所以再叠 `aa_` 或 `zzzz_` 都盖不住老中文包。安装时用同名文件覆盖对应的 `zzz_cn_voice_*`，并删掉以前叠上去的 `aa_` / `zzzz_`。没被这次改到的包不要动。

## 目录

| 路径 | 职责 | Git |
|---|---|---|
| `programs/` | 解包/组包 CLI（AudioMog、retoc、vgmstream、VGAudio） | 跟仓库走，`bin/` `vendor/` 已 gitignore |
| `studio-ff7-rb/` | 修订台 compose + db + worker | 统一仓库中的目录 |
| `studio-ff7-rb/website/` | Next.js `:8765` | 统一仓库中的目录 |
| `studio-ff7-rb/db/` | `init/` 建表；`data/` gitignore | |
| `studio-ff7-rb/worker/` | 抽取、字幕、时长 | |
| `game/` | 只读游戏 + 中文包 | 不进 git |
| `gpu/` | 推理代码。TTS 在 5080；inference-host 上的 TTS 镜像和权重已清掉 | 统一仓库中的目录，权重单独准备 |
| `work/` | 缓存、catalog、`PROGRESS.md` | 不进 git |
| `tmps/` | 参考截图 | |

游戏：`game/FINAL FANTASY VII REBIRTH/`（约 160G，UE4.26 IoStore）。

中文包：`game/sound-part/FF7Rebirth_CN_Voice_v1.3_for1.005_20260830.zip`
已解压只读副本：`work/ref-cn-voice/`（`zzz_cn_voice_{a-g,vo,vo_full}_P`）。

## 工具怎么跑

```bash
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_ROOT="$HOME/.dotnet"
programs/ff7sound status
```

- `retoc` / `repak`：Linux ELF，在 `programs/bin/`
- AudioMog / VGAudio：.NET 8，`dotnet programs/bin/audiomog/AudioMog.dll`
- 游戏音频：SQEXSEAD（uasset 里的 sab/hca），**不是 Wwise**
- 引擎版本打包：`--version UE4_26`
- 中文包是 patch 容器，必须和游戏 `Paks` 一起 list / to-legacy，单独对 `zzz_*.utoc` list 会失败

## 拍数的「比」

界面上的「比」只有一个定义，列表、详情、专题、改写反馈都用它。不要把未归一的「日文拍 ÷ 中文拍」当成「比」。

**比 =（日文拍数 ÷ 中文拍数）÷ 1.20。**

- **1.00 是标准。** 此时中文拍数正好是日文拍数的 1/1.20，也就是日文拍约为中文拍的 1.20 倍。
- **大于 1：中文偏短。** 放进同一段演出时间，语速容易被拖慢。
- **小于 1：中文偏长。** 同样的时间里字偏多，听起来啰嗦、偏快。
- 日文拍 = 摩拉 + 句中标点 × 1.5。中文拍 = 汉字数 + 句中标点 × 1.5。整句末尾标点不计；字幕换行不是句末，也不算拍。句中标点可以用来把「比」调进目标区间。
- 日文去掉标点和空白后，正文 ≤5 字不计算「比」，不要为了凑比值把短句写长。
- 代码里 `normalizedRatio` 才是「比」。`ratio` 只是归一之前的日文拍 ÷ 中文拍。报警用的是「比」偏离 1.00：超过 10% 警告，超过 15% 异常。

## 管理台方针

- 工作对象 = 中文包约 2.7 万条，不管游戏里多出来的 SE/BGM
- 音频：`website/data/{jp,cn,ours}/`，已全量抽 JP/CN MP3；不进 git / Docker
- Postgres + Next.js + worker；pgAdmin **8766**（环境变量 `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD`）
- Next **禁止**直接 spawn AudioMog；一律走 worker
- 正式 TTS 只在 `INFERENCE_HOST`（RTX 5080，官方 IndexTTS 2.0）。inference-host（`INFERENCE_HOST`）现有三张卡：GPU0 11GB、GPU1/GPU2 各 22GB 且两张 22GB 之间有 NVLink。这台机器不再做 TTS，TTS 镜像和权重已删。开机只自动起 ASR `:8001`。不使用emotion。`gpu/` 只同步代码，权重不要下到 VM
- Win11 只拷 `_P.pak/.utoc/.ucas`；Linux 用 `studio-ff7-rb/worker/build_mod.py` 打差量包

## 续工入口

未完成事项、已验证命令、已知坑：`work/PROGRESS.md`（没有就先读本文件再读 `studio-ff7-rb/`）。

管理台已经能播 JP/CN，逐条页可以锁定替换语音。封包见下面「锁和打 MOD」。

## 禁止提交音频

**永远不要 `git add` wav / uasset / ucas / utoc / pak / hca。**
`website/data/` 是本机缓存，已经 gitignore。提交前执行：

```
cd studio-ff7-rb/website && git add -A --dry-run
```

若出现 `.wav` `.uasset` 立刻停。`work/` `game/` 同样不进 git。

## 锁和打 MOD

列表页 `https://inference.example.invalid` 上，一条台词的「锁」是 `line_tts_versions.is_used`。同一条 stem 最多锁一个已经生成好的音频（改过的 TTS、音频编辑，或「锁日文原声」）。没锁的句子继续用现成中文包里的源中文。锁上的句子如果 `subtitle_text` 和 `lines.text_zh` 不一样，游戏字幕也要换成这句。

每句剧情语音是自己的 `.uasset`，chunk id 跟原中文包相同。修订会重写受影响的同名 `zzz_cn_voice_*` 包；包内其他章节的 chunk 原样保留。原来的九个中文包必须齐全，受影响的包用新版覆盖。战斗语音库是整份 `VO_*.uasset`，不在章节区域里。

原中文包里没有、但已经锁定的语音，打进 `zzz_cn_voice_add_P`。它用游戏原来的 chunk id，这些 id 不在九个 `zzz_cn_voice_*` 里，所以能盖住日文原声。多句共用一条过场语音时，按 `line_meta.extra` 的 `slice_start_s`、`slice_end_s`、`voice_channel` 只替换那一声道上的切片，其他声道保持游戏原文件。没锁的切片仍是日文。`aa_cn_voice_edit_P` 仍然只放字幕。

字幕在游戏自己的 `TxtRes` 里，不在中文语音包里。改一句字幕会把**整份** TxtRes 打进补丁，只换这几句的文本，同一文件里其他句子保持原样。

第 N 章 = 区域名里写着「第N章」的过场，再加上它和下一个章节标记之间的地图。第 1 章是 `C1910`。第 2 章是 `C1920`、`KALMT`、`C2010`、`GRASE`、`GRASA`。章节标记之后的世界情报、小游戏、战斗语音不算进最后一章。

只打选中的章节能省时间和空间。全量中文包大约 869MB。2026-09-23 的第 1–2 章包是 3034 句语音（其中 984 句锁定重编码，2050 句原样拷源中文）加 3 份字幕，ucas 约 105MB，整次制作大约两分半。

```bash
export PATH="$HOME/.dotnet:$PATH"
export DOTNET_ROOT="$HOME/.dotnet"
# 默认全部章节。做完会 rsync 到 /srv/backups/ff7-backup/mod/日期/版本
python3 studio-ff7-rb/worker/build_mod.py
python3 studio-ff7-rb/worker/build_mod.py --chapters 1,2
python3 studio-ff7-rb/worker/build_mod.py --chapters 1,2 --no-rsync
```

版本号是当天上海时区的 `0` 到 `4`，取备份盘上还没有的最小号。包先在本机 `work/mod-build/` 写完并逐条回读校验，再 `rsync -avP`。同步成功后，本机只留刚打的那一天，更早的 `work/mod-build/日期/` 删掉；`cache`、`tmp`、`validation-input` 留下。旧版本到 `/srv/backups/ff7-backup/mod/日期/版本` 找，不要删共享盘上的历史包。`--no-rsync` 不删本地旧包。语音产物为同名 `zzz_cn_voice_*`；`aa_cn_voice_edit_P` 只装修改后的字幕。Win11 上先删除旧 `aa_` / `zzzz_`，再将本次 `End` 合并进游戏根目录（包括本次新字幕包），语音仍选日语。不要把旧包留在 `Paks` 的任何子目录里。

语音容器沿用原作者的头、ID、目录、未修改压缩块；新字幕容器使用空 UE4.26 头。早期 aa_/zzzz_ 语音叠包方案已弃用。

2026-09-25 修复：AudioMog 改 SAB 长度时不一定更新 Zen ExportMap 的 CookedSerialSize；旧版 2591 条锁定缓存中有 257 条大小不一致。`repair_audio_exports` 从源资产头重算，缓存命中也修复。禁止仅凭音频能解码判断游戏资产可用；导出需严格 Oodle 回读、字节比对和完整 Zen export 大小检查。Linux 校验不代表已通过 Win11 游戏启动测试。
