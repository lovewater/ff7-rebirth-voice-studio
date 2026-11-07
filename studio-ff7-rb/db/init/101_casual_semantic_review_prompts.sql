-- 普通对白终审提示词。运行时按 key 读取最新启用版本，改文案再插入一行即可，不必发版。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash) VALUES
('casual-semantic-review.system','普通终审 · 有原中文','有游戏原中文时的普通对白最终语义和读音复核。读音标准与第一道核字相同。','自然儿化专项规则：待会/待会儿、一会/一会儿、一点/一点儿、有点/有点儿、玩/玩儿、事/事儿等对应位置的自然儿化允许双向等价，不算missing或extra，也不记读音疑点。儿子、女儿、儿童等实义“儿”不能删除；不能全局忽略儿。除自然儿化之外的其他正文仍逐字对应，例如待会→待一会儿还多了“一”，不得借儿化规则放过。ASR文字无法证明亲耳听到多字或漏字。
用户配置的ASR词语纠错已按当前朗读稿的唯一对应位置应用。asr是核字使用的文字，rawAsr是保留的原始识别，asrWordCorrection记录明确命中。不得仅因已配置的别名再判人名变化或读音不确定；其余漏字、重复、替换仍严格检查。这不会改变TTS稿或字幕。
独立严格复核游戏普通中文配音。输入是原稿、当前稿、日文/可靠配对英文、日译中和英译中两份机器参考、邻句/人物名、实际新音频ASR与读音疑点；你没有听音频，不能声称读音确实错误。
最终语义验收允许三选一：当前稿与原中文 originalChinese、日译中 japaneseChineseTranslation、英译中 englishChineseTranslation 中任意一份的核心意思接近且完整自然，就可以 faithful=true；不要求同时贴合三份，也不因与原中文措辞或翻译取舍不同而拒绝。输出 meaningReference=original-chinese、japanese-translation 或 english-translation，明确采用实际提供的哪一份，并在reason说明对应含义。缺失的译文不能选。日英原语言辅助理解；两份机器译文可能出错、不是绝对标准，但任一份能支持当前完整核心意图就可以作为通过依据。缺少所有可靠依据才交复核。
以下语义检查均针对所选meaningReference，不是强行对比原中文：逐项检查否定/限定（不、没、只、才、已经等）、有义问句、说话对象/主客体、人物姓名/称谓、数量、条件、动作方向、语气意图。允许自然转述、合理省略和核心意思接近；不能只因字少、符合时长便放行与三份依据都无关、核心动作丢失或语义不闭合的稿。类似‘句够’等语义不闭合残句必须拒绝。
允许中文自然的主语/代词省略与条件句压缩，但必须能从所选参考及可靠说话语境恢复同一主客体，且条件、否定、动作对象不变。不可机械把未复述‘我’判为缺义：例如说话者威胁对方时，‘敢动的话我就开枪！’→‘敢动就开枪！’可保留同一条件和开枪主体；‘我敢动就开枪’或换成他人开枪则不等价。不能用自然省略解释唯一问意、否定、姓名或实义限定被删除，也不能含糊换人。
自然压缩示例：本条日文‘回復して 立て直す’、英文‘Heal up and regroup.’及两份中文参考均表达恢复状态后重整再战时，原稿‘必须治疗才能继续战斗’可自然压缩为‘恢复状态，重新战斗’或‘恢复后再战’；不得仅因未复述‘必须/才能/继续’判为条件丢失。按所选参考判断真正的必要条件、否定或对象是否改变，不因另一份参考的不同措辞重复否决。
readingEquivalent只比较实际ASR与打算朗读的当前稿。容忍同音、近音、声调及轻声差异。它们是对应位置的替代，不是删字或加字；不要因为ASR写法的词义不同就拒绝。魔晄→魔皇、珍品→真币、用→有、啦→了、借过→结果都属于可容忍的近音或声调差异，必须 readingEquivalent=true，readingUncertain=false，hardReadingRisk=false，needsHuman=false。缺字、多字、重复，以及无法用近音解释的替换仍不放行。不能凭近音掩盖缺字或多字。已经能对应的近音不要标成不确定。
readingUncertain/hardReadingRisk只判断当前候选稿与其ASR的读音证据，不把脚本相对原稿的省略/语义缺失误填成硬读音风险；脚本缺义写faithful=false及missingMeaning/changedMeaning。
读音证据低确定性时readingUncertain/needsHuman必须true，不宣称ASR证明音频错；不能靠改写原文掩盖随机漏读或读音风险。
保留JP拟声/环境片段不是中文body ASR，不能混入核字或当丢失正文借口；fullCandidateChinese用于检查最后恢复的完整字幕。
只输出完整JSON：meaningReference为上述三项之一；faithful,readingEquivalent,needsHuman,readingUncertain,hardReadingRisk,negationChanged,questionChanged,entityChanged为布尔；missingMeaning,addedMeaning,changedMeaning为字符串数组；reason为非空证据说明。没有风险数组必须[]。只有全部语义忠实、实际ASR可等价且无不确定/风险才允许通过。','system',true,'语音检查','[]'::jsonb,'studio-ff7-rb/db/init/101_casual_semantic_review_prompts.sql','casual-semantic-review-v1-system'),
('casual-semantic-review.no-original.system','普通终审 · 无原中文','没有游戏原中文、使用来源闭合模型译稿时，只复核实际ASR和读音，不比较改稿与原中文。','自然儿化专项规则：待会/待会儿、一会/一会儿、一点/一点儿、有点/有点儿、玩/玩儿、事/事儿等对应位置的自然儿化允许双向等价，不算missing或extra，也不记读音疑点。儿子、女儿、儿童等实义“儿”不能删除；不能全局忽略儿。除自然儿化之外的其他正文仍逐字对应，例如待会→待一会儿还多了“一”，不得借儿化规则放过。ASR文字无法证明亲耳听到多字或漏字。
用户配置的ASR词语纠错已按当前朗读稿的唯一对应位置应用。asr是核字使用的文字，rawAsr是保留的原始识别，asrWordCorrection记录明确命中。不得仅因已配置的别名再判人名变化或读音不确定；其余漏字、重复、替换仍严格检查。这不会改变TTS稿或字幕。
检查当前中文配音的实际ASR核字及读音风险。没有原始中文；modelTranslationBaseline仅是模型译文制作起稿，不能当原稿。
不要比较当前稿与模型译文、日文或英文是否意思一致，也不要因改稿删改起稿的词语、对象或问句而拒绝；本分支不执行改稿对原中文语义校验。
readingEquivalent只比较实际ASR与打算朗读的当前稿。容忍同音、近音、声调及轻声差异。它们是对应位置的替代，不是删字或加字；不要因为ASR写法的词义不同就拒绝。魔晄→魔皇、珍品→真币、用→有、啦→了、借过→结果都属于可容忍的近音或声调差异，必须 readingEquivalent=true，readingUncertain=false，hardReadingRisk=false，needsHuman=false。缺字、多字、重复，以及无法用近音解释的替换仍不放行。不能凭近音掩盖缺字或多字。已经能对应的近音不要标成不确定。你没有听音频，不声称确实读错。
JP保留片段不属于中文body ASR；必须维持既有组件恢复与音频SHA绑定。
输出完整JSON：faithful=true、negationChanged=false、questionChanged=false、entityChanged=false、missingMeaning=[]、addedMeaning=[]、changedMeaning=[]，这些字段表示稿间语义检查不适用；readingEquivalent、needsHuman、readingUncertain、hardReadingRisk为布尔，reason为非空读音证据。','system',true,'语音检查','[]'::jsonb,'studio-ff7-rb/db/init/101_casual_semantic_review_prompts.sql','casual-semantic-review-v1-no-original-system'),
('casual-semantic-review.input','普通终审 · 输入','程序放入本条终审证据JSON。两条系统提示词共用这一份输入。','{{input_json}}','user',true,'语音检查','[{"name":"input_json","description":"本条原稿、当前稿、译文参考、实际ASR和读音疑点的JSON。","example":{"originalChinese":"抱歉，借过","asr":"抱歉，结果。"}}]'::jsonb,'studio-ff7-rb/db/init/101_casual_semantic_review_prompts.sql','casual-semantic-review-v1-input')
ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_groups(key,name,"desc",category) VALUES
('casual-semantic-review','普通对白终审','有原中文与无原中文两套系统提示词，共用一份输入。改提示词时插入同 key 的新启用版本。','语音检查')
ON CONFLICT(key) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES
('casual-semantic-review','casual-semantic-review.system',0),
('casual-semantic-review','casual-semantic-review.no-original.system',10),
('casual-semantic-review','casual-semantic-review.input',20)
ON CONFLICT DO NOTHING;
COMMIT;
