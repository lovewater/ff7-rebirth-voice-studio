-- 两种独立译文只作为后续对照资料，不替换官方中文字幕，也不参与锁定/打MOD。
ALTER TABLE lines ADD COLUMN IF NOT EXISTS translate_zh_jp text;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS translate_zh_en text;
COMMENT ON COLUMN lines.translate_zh_jp IS '自部署模型仅依据日文原文及同演出日文上下文的独立中文翻译';
COMMENT ON COLUMN lines.translate_zh_en IS '自部署模型仅依据英文原文及同演出英文上下文的独立中文翻译';
CREATE TABLE IF NOT EXISTS line_translation_jobs (
 stem text NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
 source_language text NOT NULL CHECK(source_language IN ('jp','en')),
 source_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','retry')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 error text,
 model text,
 PRIMARY KEY(stem,source_language)
);
CREATE INDEX IF NOT EXISTS line_translation_jobs_dispatch ON line_translation_jobs(status,next_attempt_at);
COMMENT ON TABLE line_translation_jobs IS '日英独立翻译断点队列：逐条成功即落库；崩溃后回收running；失败指数退避，不调用收费模型';
INSERT INTO prompt_groups(key,name,"desc",category) VALUES
('translation.independent','日英独立中文翻译','只使用对应源语言的官方文本及同演出前后各两条，不读官方中文或另一语言。','独立翻译') ON CONFLICT DO NOTHING;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,category,placeholders,source_path,seed_hash) VALUES
('translation.independent.system','独立翻译规则','全量后台日英分开译成自然中文，保留人物口吻、信息和语气；输出只包含当前条译文的JSON。',
'你是《最终幻想VII 重生》（Final Fantasy VII Rebirth）的游戏对白中文翻译。专有名词和断续单词要结合这款游戏的语境理解。根据指定源语言，把当前条台词翻成自然流畅、符合中文语境的简体中文，忠实保留原意、人物口吻和语气。上下文只用于理解指代和场景，绝不翻译上下文，也不能把上下文信息加到当前台词中。不能借用不存在的官方中文字幕或另一语言版本。原文是感叹、拟声或歌词时也忠实翻译；不要扩写，不解释，不输出多个版本。仅输出JSON对象：{"translation":"当前条中文译文"}。','system','独立翻译','[]','db/init/065_independent_translations.sql','translation-independent-system-v2'),
('translation.independent.input','独立翻译输入','source_language为日文或英文；before/after最多各两条同语言台词，只有同演出才提供；current为唯一需要翻译的台词。',
'源语言：{{sourceLanguage}}
同演出前文：{{before}}
仅翻译当前条：{{current}}
同演出后文：{{after}}',
'user','独立翻译','[{"name":"sourceLanguage","description":"当前源语言名称","example":"日文"},{"name":"before","description":"同一演出前两条同语言台词，非演出为空数组","example":[{"text":"行こう！"}]},{"name":"current","description":"仅此条需要翻译的源文本","example":"待って！"},{"name":"after","description":"同一演出后两条同语言台词，非演出为空数组","example":[]}]',
'db/init/065_independent_translations.sql','translation-independent-input-v1') ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES
('translation.independent','translation.independent.system',0),('translation.independent','translation.independent.input',10) ON CONFLICT DO NOTHING;
