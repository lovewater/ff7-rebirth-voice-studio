-- 扩展现有三段场景演出协议到四段；保留用户当前提示词内容及所有历史版本。
-- 使用运行时相同的最新启用版本排序，不覆盖已编辑的其他规则；可重复执行。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable
 ORDER BY key,updated_at DESC,id DESC
), expanded AS (
 SELECT *,replace(replace(replace(replace(replace(replace(replace(prompt,'1、2或3','1、2、3或4'),'2或3个分组','2、3或4个分组'),'（2或3）','（2、3或4）'),'三段仍用此规则','三段和四段仍用此规则'),'两段/三段台词','两段/三段/四段台词'),'三段对话恰好三行','三段对话恰好三行，四段对话恰好四行'),'两组则matches只有两个布尔值。','两组则matches只有两个布尔值；四组时matches必须有四个布尔值。') AS expanded_prompt FROM active
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 支持四段：每段独立验收。',expanded_prompt,
 true,role,placeholders,source_path,'four-parts-v1:'||key,category
FROM expanded WHERE expanded_prompt<>prompt
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
