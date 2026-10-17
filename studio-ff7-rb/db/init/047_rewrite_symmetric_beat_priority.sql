-- 对称明确增字与减字的义务；只调整措辞，不变更分流、TTS或验收规则。
-- 新增启用版本并保留旧版；同key关联和占位符沿用，下一调用即时生效。
BEGIN;
WITH changes(key, old_text, new_text) AS (VALUES
('rewrite.normal.system', $old$1. 中文实测时长已在容差内，但比仍越界：本轮重点解决比。比过高时必须尝试增加自然、有意义的正文字符来降低比；比过低时精简冗余来提高比。保全原意，优先进入0.9到1.1，区间内不追求更接近1.00。不能仅以“当前时长合适”“增加文字可能超时”为理由反复返回相同正文，也不能只改换行、空格或堆标点假装改写。新稿尚未合成，不得断言加字一定会超时；请给出自然新稿，由下一轮TTS验证。$old$, $new$1. 中文实测时长已在容差内，但比仍越界：本轮重点解决比。时长合格但比偏高时，必须先尝试自然增字，补全或适度展开本句已有语义，让比降低；时长合格但比偏低时，必须先尝试自然减字，精简冗余和重复表达，让比提高。两种情况都必须保留完整原意、必要信息和人物口吻，优先进入0.9到1.1，区间内不追求更接近1.00。不能仅以“当前时长合适”“增字可能超时”或“减字可能太短”为理由反复返回相同正文，也不能只改换行、空格或堆标点假装改写。新稿尚未合成，不能断言增字必然超时或减字必然过短；必须先给出自然改稿，再由下一轮TTS验证实际时长。$new$),
('rewrite.normal.feedback', $old$若实际时长已合格而比仍越界，继续实质改正文：比高则增加自然正文字符，比低则精简冗余，先调入合格带再TTS验证。不要仅以“旧稿时长合适”或“加字可能超时”为由原样返回，也不要只换行、换空格或堆标点。通常加字使比降低、音频变长，减字使比提高、音频变短；新稿的实际长度必须下一轮合成才能确认。$old$, $new$时长合格但比偏高时，必须先尝试自然增字，补全或适度展开本句已有语义，让比降低；时长合格但比偏低时，必须先尝试自然减字，精简冗余和重复表达，让比提高。两种情况都必须保留完整原意、必要信息和人物口吻，先给出实质改稿，再由下一轮TTS验证。不要仅以“旧稿时长合适”“增字可能超时”或“减字可能太短”为由原样返回，也不要只改换行、空格或堆标点。通常增字使比降低、音频变长，减字使比提高、音频变短；是否超时或过短必须以新稿合成后的实测为准。$new$)
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT old.key,old.name,old."desc",replace(old.prompt,c.old_text,c.new_text),
       true,old.role,old.placeholders,old.source_path,
       c.key || '-symmetric-beat-priority-20261017-v1',old.category
FROM changes c
JOIN LATERAL (
 SELECT * FROM prompt_templates WHERE key=c.key AND enable=true
 ORDER BY updated_at DESC,id DESC LIMIT 1
) old ON true
WHERE position(c.old_text in old.prompt)>0
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
