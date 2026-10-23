-- 语气词归类修正：独立情绪且可对应中文时保留日文原声，不能因出现在字幕里就归正文。
-- 只追加最新启用模板版本，不改已生成音频、人工字幕和锁定；后续调用即时读取，无需重启。
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
SELECT key,name,"desc" || E'\n独立情绪发声优先保留原声；字幕对应不是归入正文的理由，ねえ等明确例外仍保留。',
 prompt || $emotion_rule$
分类优先规则（工程上的保留原声，与语法词性无关）：
onomatopoeia 是“独立情绪/非正文发声，保留原日文演出”的工程标签，不限于语言学上的拟声词。叹词、感叹词、语气词即使有字幕、具有感叹语义、位于句首或能与中文字幕逐字对应，也不能据此归为speech。
先判断一个完整ASR文字段是否仅为独立的情绪发声，再判断能否与中文对应。对于独立成段、无普通词句内容，且中文有兼容发声的感叹（例如日文「あ／ああ／あ～」与中文“啊／啊～”，「おお」与“哦”，「うん」与“嗯”），优先归入onomatopoeia，原声保留；从中日正文及中文TTS稿删除对应语气词和关联标点，最终字幕由程序恢复。
反例纠正：官方「あ～ 完全にだましにきてる」、中文“啊～根本就是在骗人”，若ASR已分成「ああ」和「完全に騙しに来てる」，前段应归onomatopoeia，后段归speech。中日「あ～／啊～」对应正是保留原声的依据，不是将它当正文重新TTS的理由。
仍不可拆开完整ASR段；语气和正文混在同一个不可拆ASR段时不得猜切。正常词句、呼叫人名、明确招呼/征询的「ねえ／ねぇ／ねー」以及词内「わからねえ」等继续按正文处理，不能因含有某个假名就当拟声。已有独立情绪应答可保留的规则仍有效。
返回前检查：若将独立啊/哦/嗯类段归speech，不能仅以“属于字幕的一部分”“能与中文对应”“是句首叹词”作为理由，必须有它实际承载普通正文内容或符合明确排除项的证据。
$emotion_rule$,role,true,category,placeholders,source_path,'onomatopoeia-independent-emotion-v1'
FROM prompt_templates
WHERE key='onomatopoeia-plan.system' AND enable
 AND NOT EXISTS(SELECT 1 FROM prompt_templates WHERE seed_hash='onomatopoeia-independent-emotion-v1')
ORDER BY updated_at DESC,id DESC LIMIT 1;
