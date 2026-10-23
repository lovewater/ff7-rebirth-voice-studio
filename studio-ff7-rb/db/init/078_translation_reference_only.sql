-- 独立译文帮助理解原文，不作为必须沿用的措辞；保留旧版本供提示词库追溯。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,'日英原文与独立中文译文成对提供；译文仅供理解参考，不能覆盖原文、场景与自然中文表达。',
$prompt$以下是本句原始外语台词及其独立中文参考译文。括号前为原文，括号内为对应中文译文：
{{references}}
日文译文和英文译文都仅作参考，不是标准答案，也不是必须沿用的台词或用词。它们可能直译、生硬或有误；请根据原始日文、英文、原游戏中文字幕及上下文独立理解中心意思，再用符合场景、人物口吻和中文习惯的自然表达改写。不要被参考译文的具体词语带偏，不为贴合译文而替换原中文字幕中已经准确、自然的说法。参考译文与原文或场景冲突时，舍弃参考译文的说法；只有自然、准确且符合场景时才可借鉴。不得新增事实或遗漏否定、条件、称谓。
参考译文不是额外必须朗读的内容，已经剔除并保留原声的情绪词不要加回TTS正文。计时与分片仍依据当前任务提供的实际音频/ASR证据，不从参考译文伪造时长。按当前任务既有JSON协议输出。$prompt$,
true,role,placeholders,source_path,'translation-reference-only-v2',category
FROM (SELECT DISTINCT ON(key) * FROM prompt_templates WHERE key='rewrite.translation-reference' AND enable ORDER BY key,updated_at DESC,id DESC) current_prompt
ON CONFLICT(seed_hash) DO NOTHING;

INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc",
replace(prompt,'各自独立中文译文仅供参考，有自然贴切的表达可以直接采用，不必另造翻译腔。',
'日文译文和英文译文都仅供理解参考，不是标准答案或必须沿用的措辞，可能直译、生硬或有误。请独立理解原文与场景，优先保留原中文字幕中准确自然的说法，不被参考译文的词语带偏；只有自然、准确且符合人物口吻时才借鉴。'),
true,role,placeholders,source_path,'measured-history-reference-only-v2',category
FROM (SELECT DISTINCT ON(key) * FROM prompt_templates WHERE key='rewrite.measured-history.system' AND enable ORDER BY key,updated_at DESC,id DESC) current_prompt
ON CONFLICT(seed_hash) DO NOTHING;
