-- 日文正文8字以内取消中文字数上下限，保留当前版本的自然中文/用字规则。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
SELECT key,name,'日文正文8字以内使用；不设中文字数上下限或目标，校字及实测时长仍独立检查。',
replace(replace(replace(replace(replace(prompt,'当前日文正文少于八个字符','当前日文正文不超过八个字符'),'中文正文必须 {{min}}–{{max}} 个字符（标点、空格、换行不算）。请根据额外提供的实际发声时长决定怎样改写。','中文正文不设字数上下限或目标，不按日文字数推算中文长度。'),'中文实测偏短且未达上限时，应增加当前正文的字符数、补全自然表达；若已经达到上限，优先保住核心含义，允许自然标点停顿匹配慢表达，不强制增字。实测偏长时才简化。上限是容量，不要求凑满。','优先保留自然准确的原表达；实测偏短可调整自然断句和停顿，只有语义确有不足才补全，不能为凑字增加语气词、重复内容或新信息。实测偏长时才自然精简。'),'字数上限只算实际朗读文字，所有标点、空格、换行均不计。鼓励','鼓励'),'继续给一条忠实、自然的说法；限制 {{min}}–{{max}} 字，按实际发声时长反馈增字或减字。不按拍数评分。','继续给一条忠实、自然的说法；不设字数上下限或目标，不为凑字扩写。按实测时长调整自然表达，不按拍数评分。'),role,true,category,
COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements(placeholders) p WHERE p->>'name' NOT IN ('min','max')),'[]'::jsonb),
source_path,'short-no-character-limits-v1-' || key
FROM (SELECT DISTINCT ON(key) * FROM prompt_templates
 WHERE key IN ('rewrite.short.system','rewrite.short.followup') AND enable=true
 ORDER BY key,updated_at DESC,id DESC) active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
