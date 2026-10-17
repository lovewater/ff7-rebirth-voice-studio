-- 短句豁免改为日文正文少于8字符：仅同步提示词门槛文案，其余字数、时长规则不变。
-- Python计拍和网站策略随代码同步部署；版本号升级会使旧拍数缓存失效并自动重算。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT p.key,p.name,
       replace(replace(p."desc",'少于6字','少于8字'),'少于六个字符','少于八个字符'),
       replace(replace(p.prompt,'少于6字','少于8字'),'少于六个字符','少于八个字符'),
       true,p.role,p.placeholders,p.source_path,p.key||'-short-under-eight-20261017-v1',p.category
FROM (
 SELECT DISTINCT ON(key) * FROM prompt_templates
 WHERE enable=true AND key IN ('rewrite.short.system','rewrite.short.context','rewrite.short.followup')
 ORDER BY key,updated_at DESC,id DESC
) p
ON CONFLICT(seed_hash) DO NOTHING;
UPDATE prompt_groups SET "desc"=replace("desc",'不足6字','不足8字'),updated_at=now()
WHERE key='rewrite.short' AND "desc" LIKE '%不足6字%';
COMMIT;
