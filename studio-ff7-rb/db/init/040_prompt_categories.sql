-- 分类用于检索，不参与同key的版本选取；回填分类不能改变旧版本的生效顺序。
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '未分类' CHECK (length(btrim(category))>0);
CREATE INDEX IF NOT EXISTS prompt_templates_category_idx ON prompt_templates (category);
CREATE OR REPLACE FUNCTION prompt_templates_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 只整理分类（或无实际字段变化）时，保留原更新时间，避免误切换同key的生效版本。
  IF (to_jsonb(NEW)-'category') IS NOT DISTINCT FROM (to_jsonb(OLD)-'category') THEN RETURN NEW; END IF;
  NEW.updated_at=clock_timestamp(); RETURN NEW;
END; $$;
UPDATE prompt_templates SET category=CASE
  WHEN key LIKE 'rewrite.%' OR key LIKE 'fallback-rewrite.%' THEN '台词改写'
  WHEN key LIKE 'text-review.%' OR key LIKE 'rhythm-pick.%' THEN '语音检查'
  WHEN key LIKE 'onomatopoeia-plan.%' OR key LIKE 'missing-fragment.%' OR key LIKE 'missing-jp-subtitle.%' THEN '拟声与分流'
  WHEN key LIKE 'subtitle-quotes.%' OR key LIKE 'subtitle-layout.%' THEN '字幕整理'
  ELSE category END
WHERE category='未分类';
COMMENT ON COLUMN prompt_templates.category IS '提示词用途分类，仅用于管理和筛选，不改变key和启用版本规则';
