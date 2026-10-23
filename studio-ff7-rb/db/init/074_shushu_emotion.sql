-- 已撤回模型独立分支，仅保留纯情绪整句的程序规则；混合句不追加提示词。
UPDATE prompt_templates SET enable=false,updated_at=now() WHERE key='onomatopoeia-plan.shushu' AND enable;
