-- 日文纯正文8～11字的自动修订比值带为0.75～1.10；<8仍豁免。
-- 改稿工具与自动候选使用同一规则。用新启用版本保留旧提示词，避免覆盖历史。
-- 普通长句仍用原有区间；程序传入动态上下限，不把所有句子一律放宽。
WITH latest AS (
  SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable=true
    AND (key LIKE 'rewrite.normal.%' OR key='rewrite.manual-selection')
    ORDER BY key,updated_at DESC,id DESC
), changed AS (
  SELECT *,regexp_replace(prompt,'0[.]9[[:space:]]*(到|–|—|-)[[:space:]]*1[.]1','{{beat_min}}–{{beat_max}}','g') AS new_prompt
  FROM latest
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,category,placeholders,source_path,seed_hash)
SELECT key,name,"desc" || E'\n日文正文8～11字改稿合格带0.75～1.10，普通长句维持原区间；上下限由本句规则替换。',
  new_prompt,true,role,category,
  placeholders || '[{"name":"beat_min","description":"本句改稿比值下限：日文纯正文8～11字为0.75，其余普通句为0.9。","example":0.75},{"name":"beat_max","description":"本句改稿比值上限，1.10，边界包含。","example":1.1}]'::jsonb,
  source_path,NULL
FROM changed WHERE new_prompt<>prompt;
