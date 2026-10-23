-- 最终候选择优增加前后文连贯性；保留原有硬门槛及历史提示词版本。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON (key) * FROM prompt_templates
 WHERE key='rhythm-pick.system' AND enable
 ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 同时考虑前后文连贯性，邻句优先锁定中文，本句仍从原中文开始。',
 prompt||E'\n'||$continuity$上下文连贯性也是最终择优维度：结合 context.before/after 的前后句，比较候选能否自然接话、回答问题，称谓、指代、文字语气和信息衔接是否一致。邻句中文有锁定稿时以锁定稿为主，originalTextZh 仅供核对；本句原始中文仍是 context.originalChinese，不继承本句旧锁定稿。上下文只能帮助理解，不能补造剧情、改变本句原意或放宽读音、时长、分段等已执行的门槛。只在给定候选中综合节奏与上下文连贯性择优，不为几毫秒优势牺牲接话自然度；缺少上下文时明确按现有证据判断。reason 简要说明选择的节奏依据和上下文依据（或上下文不足）。不得从文字臆测实际声线、情绪表现或其他未提供的声学听感。$continuity$,
 true,role,placeholders,source_path,'final-pick-context-v1:'||key,category
FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
