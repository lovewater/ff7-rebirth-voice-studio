-- 所有创作台词的系统提示统一补充中文本地化要求：普通/手动、短句、慢表达、
-- 实测偏短和整句降级都适用；不改校字、断行、拟声分类、补引号等非改写任务。
-- 新增版本而不覆盖旧版，保留全部原有约束和占位符，下一次请求即时生效。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT p.key,p.name,
       p."desc" || E'\n中文本地化：结合语境改写日式礼貌套语和直译句式，保留原意、人物关系、口吻和情绪。',
       p.prompt || E'\n\n' || $style$【自然中文与场景表达】
台词应尽量符合中国大陆中文的表达习惯，让人在这个具体场景中自然说出口，不要照搬日语的句式、礼貌套语或收尾方式。忠实原意不等于逐字保留原译文。
遇到“拜托了”“请多指教”“承蒙关照”等带日语习惯的表达，先结合说话人、关系、语气、前后文及日英原文，判断这句话在此处究竟是在请求帮忙、托付事情、打招呼、道谢、表达期待还是开始合作，再改成中文在该场景下通常会说的话。即使原稿语法正确、字数或时长已经合格，明显的日式直译仍应自然化。
例如托付任务时可按语境表达为“这事就交给你了”“那就麻烦你了”；请求帮助时说清需要对方帮什么，但前提是原文或上下文已经明确；初次见面、加入队伍或开始合作时，应选符合人物关系的招呼或回应，不要不分场合一律用“请多指教”。这些只是方向示例，不能固定套用，也不能为套例子增加原文没有的任务、承诺、身份、关系或情节。
这些词并非一律禁用：在中文语境中确实自然，或人物正在恳求、郑重委托、刻意客套时，可以保留。目标是保留这句话的交际作用和情绪，而不是抹掉请求、感谢或礼貌。不能把真诚求助写成命令，也不能把紧张、悲伤的表达改成轻松玩笑。
表达自然化后，仍遵守本线路原有的时长、拍数比、短句/慢速豁免、拟声去除和分段要求。需要增减字时优先重新组织自然中文，不能靠堆日式套话、无意义语气词或生硬标点凑数。$style$,
       true,p.role,p.placeholders,p.source_path,p.key||'-natural-chinese-20261017-v1',p.category
FROM (
 SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable=true AND key IN (
  'rewrite.normal.system','rewrite.short.system','rewrite.slow.system',
  'rewrite.duration.system','fallback-rewrite.system'
 ) ORDER BY key,updated_at DESC,id DESC
) p
ON CONFLICT(seed_hash) DO NOTHING;
