-- 用户调整净语速豁免带为4.5～7.0（含两端）；新增提示词版本，保留历史。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON (key) * FROM prompt_templates
 WHERE key IN ('rewrite.normal-speed.system','rewrite.chinese-speed-limit') AND enable
 ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,replace("desc",'4.5～6.0','4.5～7.0'),replace(prompt,'4.5～6.0','4.5～7.0'),
 true,role,placeholders,source_path,'normal-speed-band-4.5-7-v1:'||key,category
FROM active WHERE prompt LIKE '%4.5～6.0%'
ON CONFLICT(seed_hash) DO NOTHING;
UPDATE prompt_groups SET "desc"=replace("desc",'4.5～6.0','4.5～7.0') WHERE key='rewrite.normal-speed';
COMMIT;
