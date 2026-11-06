-- 用户2026-11-05要求日文分段入口420ms；中文分隔/片间留白仍250ms。
-- 新增当前模板版本，历史提示词/旧run保持原样。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates
 WHERE enable AND key IN ('two-parts.repair-system','two-parts.rhythm-context')
 ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,replace("desc",'450ms','420ms'),replace(prompt,'450ms','420ms'),
 true,role,placeholders,source_path,'jp-gap-420-v1:'||key,category FROM active
WHERE prompt LIKE '%450ms%'
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
