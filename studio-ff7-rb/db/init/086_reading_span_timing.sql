-- 对时计入段内停顿；净语速计算及既有阈值不变。追加模板版本，保留历史。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable AND key IN (
 'rewrite.normal.system','rewrite.short.system','rewrite.slow.system','rewrite.slow.duration-system',
 'rewrite.duration.system','rewrite.normal-speed.system','rewrite.measured-history.system','two-parts.repair-system','fallback-rewrite.system'
 ) ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 对时使用段内含停顿的朗读跨度，段间留白单独对齐。',prompt||E'\n'||$policy$【对时口径：以本轮程序测量为准】
对时的朗读跨度从该段首个发声到末个发声，包含段内自然停顿；文件首尾补空白不计入朗读跨度。两段/三段台词分别检查各段，段间留白单独对齐日文，不能用加长段间空白掩盖某段偏短，也不能让一段偏长与另一段偏短相互抵消。
referenceSeconds/candidateSeconds及朗读跨度反馈采用上述口径；netSeconds/netRate仍是原来的净语速测量，只用于语速及原有语速豁免，不要求中文与日文扣停顿后的净发声等长。看到旧日志“净发声偏短”时，不把这个旧指标继续当作新稿必须扩写的依据。
先保留校字正确、语速正常、分段对应且能完成对齐和最终装配的可用稿。自然停顿属于表达，不要仅因扣除停顿后显得短就增字。只有本轮校字、对应分段、朗读跨度或最终总长仍不合适时才据实改稿，优先自然节奏及允许范围内的对齐处理，必要时调整表达。遵守本轮输出协议和禁止改字约束；净语速算法、阈值、拍数比定义及斜体只检查总长上限的规则保持不变。$policy$,
true,role,placeholders,source_path,'reading-span-timing-v2:'||key,category FROM active ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
