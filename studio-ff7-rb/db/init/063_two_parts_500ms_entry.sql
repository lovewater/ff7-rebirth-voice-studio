-- 500ms入口取代1秒；只改变日文两段入口，中文250ms分隔及组内240ms留白不变。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
SELECT key,name,"desc",replace(replace(prompt,'1秒','500ms'),'1 秒','500ms'),role,true,category,placeholders,source_path,'two-parts-500ms-v1-'||key
FROM (SELECT DISTINCT ON(key) * FROM prompt_templates
      WHERE key IN ('two-parts.repair-system','two-parts.rhythm-context') AND enable=true
      ORDER BY key,updated_at DESC,id DESC) current_prompts
ON CONFLICT(seed_hash) DO NOTHING;
UPDATE prompt_groups SET "desc"=replace("desc",'入口1秒','入口500ms') WHERE key='two-parts';
COMMIT;
