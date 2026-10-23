-- 台词改写统一禁用“啰”：覆盖普通/手动、短句、慢表达、实测偏短、整体fallback、两/三段整理。
-- 仅新增提示词版本，不机械替换已生成台词，不修改校字/断行/独立翻译等非创作任务。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT p.key,p.name,p."desc" || E'\n改写台词禁用“啰／囉”，由模型按语境改成自然语气表达。',
 p.prompt || E'\n\n' || $rule$改写后的台词不得出现“啰”（包括繁体“囉”）；原文有这个字时，请结合上下文和人物语气改用“啦”“了”或其他自然表达，不要机械替换，也不要为补语气词改变原意。$rule$,
 true,p.role,p.placeholders,p.source_path,p.key||'-no-luo-20261019-v1',p.category
FROM (
 SELECT DISTINCT ON(key) * FROM prompt_templates
 WHERE enable AND key IN ('rewrite.normal.system','rewrite.short.system','rewrite.slow.system','rewrite.duration.system','fallback-rewrite.system','two-parts.repair-system')
 ORDER BY key,updated_at DESC,id DESC
) p
ON CONFLICT(seed_hash) DO NOTHING;
