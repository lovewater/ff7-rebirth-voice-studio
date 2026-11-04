# 缺失日文专项（2026-11-04）

原始JP语音34612个material已经全部提取，已声明JP来源的文件缺失为0。网站的568个JP播放404全部来自EN-only目录行，不代表原始提取漏掉568个音频。

本次保留原行stem/ID，恢复171个可确证的JP试听别名，原始JP material数仍为34612。全部别名直接复制既有真实JP MP3，原字节SHA相同，不重编码、不合成；新增的是来源关联和播放路径，未虚增源素材数量。

| 方法 | 行数 | 证据 |
|---|---:|---|
| 全局完整VoiceID唯一，或多个来源PCM完全相同 | 50 | 仅完整事件/对白ID，裸atk/damage不能跨角色银行匹配 |
| 同银行JP用户集合唯一包含EN用户集合 | 97 | SecuritySoldier的JP多了_copy别名，不要求材料槽位相同 |
| 同VoiceID多JP变体，以完整PCM/声道/采样率/帧数消歧 | 3 | 陆行鸟实际共用音频，不按编号选变体 |
| 完整SAB序列的具名SoundEntry→KeyOn→Track→material | 21 | 如同名bt241_01_051_ee01_0对应EN material51、JP173 |

AudioMog上游对具名SoundEntry只读每个序列首命令。21个角色声音首命令是Interval，后续KeyOn被漏记为users；广播首命令是LoopStart，也有此问题。独立SoundProbe只读取完整控制序列，不修改原始提取器、官方DLL或游戏。源音频之前已完整解码，缺的是关联信息。

余下397行分别处理：

- 355行在当前安装的完整JP文件路径、material.users、全部26259份JP SAB的33746个具名SoundEntry三层中均没有对应独立资源。`audio_extraction.jp_source_absent=true`，`jp_source_absence.scope=no-corresponding-independent-jp-resource-in-installed-game`，每条有索引和声音图SHA。明确保留`whole_scene_japanese_absence_claimed=false`：这不证明整个演出没有日文，未来可能从整场或多声道原声中找到切片。
- 42行是广播逐片关联未定，日文资源并不缺失。5个银行各6–10个材料仅共享一个整段广播cue，没有唯一逐片ID。`audio_extraction.jp_pairing_unresolved=true`且`jp_source_absent=false`；`jp_pairing_unresolved`逐行列出真实JP candidate_stems/paths/material/SHA。42个不同JP候选已有独立JP目录行并可正常处理，禁止按slot猜配或伪造这些EN-only行的日文ASR。

171恢复的清单是`work/jp-recovery.json`；355限定缺独立资源为`work/jp-source-absence.json`；42广播关联为`work/jp-pairing-unresolved.json`。文件先原子落盘并读回SHA，之后才CAS修改本作line_meta的音源、音源证据和实际JP时长，保留章节、人物、正文、ASR及人工选择。原有5个锁定版本未修改。本次没有调用TTS、ASR或LLM；后续推理由独立授权流程负责。

## 重查与验证

`prepare_audio_tools.py`现也构建独立SoundProbe。提取任务运行时不要重建它正在使用的解码DLL。重新核查可输出新目录，避免覆盖已应用证据：

```bash
python3 studio-ff7-remake/worker/probe_jp_sequences.py --output-dir studio-ff7-remake/work/missing-jp-recheck
python3 studio-ff7-remake/worker/probe_jp_sequences.py --all-jp --output-dir studio-ff7-remake/work/missing-jp-recheck-all
python3 studio-ff7-remake/worker/jp_recovery.py --apply
python3 studio-ff7-remake/worker/audit_jp_recovery.py
python3 studio-ff7-remake/worker/validate_catalog.py --db --complete
python3 studio-ff7-remake/worker/audit_voice_extraction.py --hashes
python3 -m unittest discover -s studio-ff7-remake/worker -p test_jp_recovery.py -v
```

已完成独立全JP重查：26259源、33746具名cue、0解析错。最终审计：171个恢复路径的HTTP均200，响应SHA与真实JP源逐条相同；原始69406个material加171合法MP3别名，共69577个MP3，199个FLAC，缺失/孤立/问题均0。断点重跑实际验证updated=0、already_applied=171。

原始目录重建依次重放JP恢复、限定缺源、广播关联和章节refinement overlay，不用整块extra覆盖并行的运行结果。源索引变化会拒绝重用旧缺源结论，须重新核查。JP恢复审计把别名单独计数，不会虚增material或误当孤立实验文件。

完整序列新找到的21个战斗cue在官方CN/JP/US TxtRes中没有字幕；另1条原users为空的普通对话，三语字幕已按单声音源basename正确绑定。结果只保存在`work/missing-jp-audit/*text-report.json`，本次没有写任何正文或ASR字段。


## 2026-11-05 追加：忽略无法确定日文配对的英文孤立条目

用户明确要求将an_town8_AnnounceA__clip0000__en等条目忽略。42条无确定JP配对的孤立EN行已通过processing-state接口设为skipped；原因注明对应JP已在独立条目存在、逐片配对未定，不误报为日文素材不存在。独立JP条目继续正常制作，现有版本/选择不删除。列表及统计沿用统一active过滤，不新增另一套忽略状态。
