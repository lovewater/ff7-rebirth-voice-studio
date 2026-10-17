-- 只回填历史日志中明确列出的产物，不按编号相邻或时间接近猜测。
-- 手工设置过层级的最终音频不覆盖；没有最终产物的旧工作流保持原样。
WITH event_ids AS (
  SELECT e.run_id, entry.value AS tts_id
  FROM line_auto_run_events e
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(e.payload->'ids') = 'array' THEN e.payload->'ids' ELSE '[]'::jsonb END
  ) entry
  WHERE e.step = 'tts'
  UNION
  SELECT e.run_id, entry.value
  FROM line_auto_run_events e
  CROSS JOIN LATERAL (VALUES (e.payload->>'sourceId'), (e.payload->>'splicedId')) entry(value)
  WHERE e.step = 'splice'
), members AS (
  SELECT run_id, tts_id::bigint AS tts_id FROM event_ids WHERE tts_id ~ '^[1-9][0-9]{0,17}$'
  UNION
  SELECT id, selected_tts_id FROM line_auto_runs WHERE selected_tts_id IS NOT NULL
), eligible AS (
  SELECT r.id, r.stem, r.selected_tts_id
  FROM line_auto_runs r
  JOIN line_tts_versions final ON final.id = r.selected_tts_id AND final.stem = r.stem
  WHERE r.status <> 'running' AND final.status = 'ready' AND final.parent_tts_id IS NULL
    AND (final.auto_run_id IS NULL OR final.auto_run_id = r.id)
    AND NOT EXISTS (
      SELECT 1 FROM members m JOIN members other ON other.tts_id = m.tts_id AND other.run_id <> m.run_id
      WHERE m.run_id = r.id
    )
    -- 同一候选曾被别的工作流引用时不抢归属，已手工分组的记录也不移动。
    AND NOT EXISTS (
      SELECT 1 FROM members m JOIN line_tts_versions t ON t.id = m.tts_id AND t.stem = r.stem
      WHERE m.run_id = r.id AND (
        (t.auto_run_id IS NOT NULL AND t.auto_run_id <> r.id)
        OR (t.parent_tts_id IS NOT NULL AND t.parent_tts_id <> r.selected_tts_id)
      )
    )
)
UPDATE line_tts_versions t
SET auto_run_id = r.id,
    parent_tts_id = CASE WHEN t.id = r.selected_tts_id THEN NULL ELSE r.selected_tts_id END
FROM members m JOIN eligible r ON r.id = m.run_id
WHERE t.id = m.tts_id AND t.stem = r.stem
  AND (t.auto_run_id IS NULL OR t.auto_run_id = r.id)
  AND (t.parent_tts_id IS NULL OR t.parent_tts_id = r.selected_tts_id);
