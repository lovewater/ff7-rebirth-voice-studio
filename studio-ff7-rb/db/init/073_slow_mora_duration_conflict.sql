-- 只有程序确认字数方向与整轮实测时长冲突，才改用这组提示词。
-- 默认慢速提示词不动；新system从当前启用版本继承自然中文、禁“啰”等已有规则。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT 'rewrite.slow.duration-system','日文慢表达改稿 · 实测冲突后',
 '进入条件：中文字数>=日文摩拉但整轮净发声仍短于参考超过200ms，或中文字数<=摩拉但整轮仍长于参考超过200ms。等号包含在内；空证据、方向混杂、容差内不触发。仅取消摩拉等字目标，保留原字符上限及校字、时长检查。\n{{duration_instruction}}替换为程序确认的偏短增字或偏长减字说明；其余占位符沿用普通慢表达。',
 replace(replace(replace(p.prompt,
 '请把中文正文补足到接近或等于 {{target}} 个汉字/朗读字符（标点、空格、引号、换行不算字数）。当前字数不足目标时，必须增加正文字符，补全自然表达，不要继续缩短译文。',
 '{{duration_instruction}}'),
 '这里对应的是日文发音拍与中文朗读字符，不要求一个日文字幕字符对应一个汉字，也不要求逐字翻译。目标允许为忠实原意和中文自然作小幅调整。',
 '日文摩拉数只用于说明语速，不再是中文字数的目标或选稿排序依据。'),
 '结合实际音频长度反馈调整表达，字符目标不是音频长度已合格的依据。先在problem说明为何当前稿不足以覆盖慢速演出，在plan说明怎样自然增字。',
 '根据实际时长反馈说明问题和改法，偏短自然增字，偏长自然精简；实际结果必须由下一轮TTS验证。'),
 true,p.role,
 (SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM jsonb_array_elements(p.placeholders) x WHERE x->>'name'<>'target') ||
 '[{"name":"duration_instruction","example":"程序已确认：中文字数已达到或超过日文摩拉数，音频仍明显偏短。取消摩拉等字目标，在原上限内自然增字。","description":"程序检测到冲突后给出的时长改写方向；仅此分支使用"}]'::jsonb,
 p.source_path,'slow-mora-duration-system-20261019-v1',p.category
FROM (SELECT * FROM prompt_templates WHERE key='rewrite.slow.system' AND enable ORDER BY updated_at DESC,id DESC LIMIT 1) p
ON CONFLICT(seed_hash) DO NOTHING;

INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT 'rewrite.slow.duration-followup','日文慢表达改稿 · 实测冲突后续候选',
 '与rewrite.slow.duration-system同组同进入条件。后续候选继续遵循实测方向，不再重复接近日文摩拉数的旧目标。占位符duration_instruction为程序检测后的方向说明。',
 '{{duration_instruction}}',true,p.role,
 '[{"name":"duration_instruction","example":"程序已确认：中文字数已不多于日文摩拉数，音频仍明显偏长。取消摩拉等字目标，自然精简。","description":"程序检测到字数与时长方向冲突后的改写说明"}]'::jsonb,
 p.source_path,'slow-mora-duration-followup-20261019-v1',p.category
FROM (SELECT * FROM prompt_templates WHERE key='rewrite.slow.followup' AND enable ORDER BY updated_at DESC,id DESC LIMIT 1) p
ON CONFLICT(seed_hash) DO NOTHING;
