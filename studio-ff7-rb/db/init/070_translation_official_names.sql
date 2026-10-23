-- 人名修订复用断点队列。旧译文保留，只有重新翻译成功才原子替换；重复准备同版本不重跑。
ALTER TABLE line_translation_jobs ADD COLUMN IF NOT EXISTS name_reference_revision text;
ALTER TABLE line_translation_jobs ADD COLUMN IF NOT EXISTS name_review_target text;
ALTER TABLE line_translation_jobs ADD COLUMN IF NOT EXISTS previous_translation text;
ALTER TABLE line_translation_jobs ADD COLUMN IF NOT EXISTS name_review_priority integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN line_translation_jobs.name_reference_revision IS '最近成功翻译实际使用的官方人名表版本hash';
COMMENT ON COLUMN line_translation_jobs.name_review_target IS '本次待重译人名表版本；准备脚本幂等检查点，不因cron重启重复排队';
COMMENT ON COLUMN line_translation_jobs.previous_translation IS '人名重译前的独立译文备份；不读取或改动原中文/人工改稿/锁定';
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
VALUES ('translation.name-glossary','独立翻译：本句官方人名',
'只包含当前句英文实际命中的人名；按官方同ID名称/角色标签对照，最长名称优先匹配。日英翻译各自仍只看各自源文，不加入另一语言的整句或上下句名字。',
'这是当前句英文实际出现的人名对照，来自游戏官方多语言数据；只包含本句命中项，不是全游戏名字表：
{{name_glossary}}
当当前待译原文出现对应人名时，必须逐字使用chinese给出的官方中文名，不得自行音译、意译或换成其他名字。english与japanese是同一角色在不同语言里的名字，可能完全不像。仅翻译当前原文实际表达的内容：日文原句没有说出这个名字时不要因为表里有名字而补进译文；上下文用于理解，不是额外要翻译的台词。保留原文中明确出现的姓名，不以代词省略来回避官方名字。最终仍只返回完整JSON，唯一字段translation。',
'user',true,'独立翻译','[{"name":"name_glossary","description":"仅当前句英文最长优先、按词边界命中的官方人名数组；不包含上下句或全表。","example":"[{\"english\":\"Billy\",\"japanese\":\"グリングリン\",\"chinese\":\"格林葛林\"}]"}]'::jsonb,
'scripts/translation/names.cjs','translation-name-glossary-v1') ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES('translation.independent','translation.name-glossary',3) ON CONFLICT DO NOTHING;
