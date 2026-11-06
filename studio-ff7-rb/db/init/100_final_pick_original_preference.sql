-- 同等条件优先合格原文；保留既有模板版本和所有硬门槛。
BEGIN;
WITH active AS (
 SELECT * FROM prompt_templates WHERE key='rhythm-pick.system' AND enable
 ORDER BY updated_at DESC,id DESC LIMIT 1
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 同等条件优先本句原文，改稿需有明确实质改善。',
 prompt||E'\n'||$original$【同等条件优先原文】本句原文指 context.originalChinese。仅在给定且已通过前置验收的候选中比较：当读音可靠性、语义准确性、中文自然度、上下文衔接、实际语速与分段节奏等条件相近，没有明确且实质性的改进时，优先选择正文沿用本句原文的候选；比较正文时可忽略标点和空白，不把同义替换算作原文。不要为几毫秒、比值更接近1、同义换说法或更贴近英文措辞而放弃准确自然的原文。若改稿在上述维度有明确实质优势，可以选择改稿，并在 reason 说明原文存在的问题和改稿的具体改善；原文候选不存在时照常从给定池择优，不选回已淘汰项，不新增候选，不放宽任何验收门槛。$original$,true,role,placeholders,source_path,'final-pick-original-preference-v1',category FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
