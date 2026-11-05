# 空人物关联专项（2026-11-04）

本次仅处理有真实JP音源、但lines.speaker仍为空的条目。基线为486个JP条目；另外177个无JP条目不在本次补人物范围。

已CAS补空81条，全部复用现有游戏内部speaker码，没有新建“未知人物”、没有猜人名或按音色认人。中文/日文显示名仍沿用原有资料；缺失时不编造。证据分三类：

- 50条：同一cue组及同一内部说话人码，绑定到已在库实际VoiceID的唯一Talker，再经过PlannerEventChara/ObjectActor、CharaSpec、实际Blueprint形成闭合链。
- 28条：同一区域的该说话人码，全部可用具名引用仅对应同一个已验证CharaSpec和Blueprint。跨区域、多个模型或未解析Actor的情况拒绝。
- 3条：完全相同cue位置和完整PCM，再由对应官方ACTOR标签确认资源别名：威吉文件名漏末尾0一条，ed01与uvr1“巨汉强盗”同位置录音两条。不是凭声音相似推断。

只读取最新1111份、保留FName number的v2 DataObject；旧有损解码不作证据。每个引用保留源游戏路径、行tag、规范化行SHA和实际Blueprint，计划在`work/speaker-recovery/plan.json`，应用结果在`applied.json`，实际DB/源文件验证在`audit.json`。

每行使用短事务，同时锁目标lines和line_meta。只填当前空speaker且JP来源/音频SHA未变、没有manual_speaker标记的行，仅合并自有speaker_recovery字段；人物已非空立即保留。已由本专项填入、后来又被清空的行记录kept-cleared-after-recovery，断点重跑不擅自重填。章节、译文、原文、ASR、现有锁定及音频字节均不改，不调用ASR/LLM/TTS，不停PG或主runner。

## 验证与重跑

```bash
python3 -m unittest discover -s studio-ff7-remake/worker -p test_speaker_recovery.py -v
python3 studio-ff7-remake/worker/recover_speakers.py
python3 studio-ff7-remake/worker/recover_speakers.py --apply
python3 studio-ff7-remake/worker/audit_speaker_recovery.py
```

实际首次filled-empty-speaker=81，重跑already-applied=81。未运行主catalog全量import。可用导出的apply_speaker_recovery_overlay重放本地目录快照；它没有数据库副作用，当前未为本专项改冻结的主build入口。并行运行时应继续使用此局部CAS入口。

## 无法确定的条目

余下405个真实JP条目中，350个属于mbn/gtn/gya/ava/gyma等群体或混合来源；其余55个缺乏唯一Actor/模型链或完整可核对别名。对应额外223个资源路径全部只是语言LipSync资产，未提供另一人物归属链。人物仍待确认，不能为消除NOT NULL错误填假角色。2026-11-05迁移096允许经过分类、声学、来源校验的jp-lock原声版本保留NULL人物并锁定；合成版本仍需合法人物。预处理与自动流程均不再仅因匿名拒绝已确认的纯拟声原声。空ASR、正文冲突、未核对的多声道等原有门槛继续保留，不能把模型/数据库故障当成内容判定。

## 恢复说明

原有speaker、角色定义、名字、锁与音频均未修改。需要撤销本次补空时，先按applied.json筛出仍为本计划speaker、speaker_recovery证明完全相同、没有manual_speaker标记、且没有locked/abnormal音频的行，预览清单后才在本作库短事务恢复NULL，并仅删除该行speaker_recovery键。不要清空已有人工角色或已经产生锁定版本的行；这些应逐条核对纠正。保留ever_applied_stems历史，避免下次重跑再次填回已撤销的选择。无需恢复或删除任何音频、译文、章节或ASR结果。
