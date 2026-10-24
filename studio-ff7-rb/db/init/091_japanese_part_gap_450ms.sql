-- 日文分段入口从500ms调整为450ms；中文250ms及其他时长门槛不变。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates
 WHERE enable AND key IN ('two-parts.repair-system','two-parts.rhythm-context')
 ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 日文分段入口450ms。',replace(prompt,'500ms','450ms'),
true,role,placeholders,source_path,'jp-gap-450-v1:'||key,category FROM active
WHERE prompt LIKE '%500ms%'
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
