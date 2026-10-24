-- 双语停顿参考与中文独立断句：仅追加提示词版本，不改变声学门槛。
-- 与website/src/lib/rewrite-punctuation-hint.ts的BILINGUAL_PAUSE_HINT保持一致。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable AND key IN (
 'rewrite.normal.system','rewrite.short.system','rewrite.slow.system','rewrite.slow.duration-system',
 'rewrite.duration.system','rewrite.normal-speed.system','rewrite.measured-history.system',
 'two-parts.repair-system','fallback-rewrite.system','rewrite.italic-ceiling.system'
 ) ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 日英停顿参考与中文自然断句。',prompt||E'\n'||$policy$【日英停顿参考与中文自然断句】
同时参考日文和英文原文的停顿、句式及语气，理解人物在哪里迟疑、转折、强调或完成疑问。音频实测停顿是声学证据；字幕中的标点、空格和换行只是文字线索，不能直接当成实际停顿或可靠分段。未提供某种语言的音频停顿、分段拍数或时长时，不得编造数值或假定各段等长。
日英停顿作用一致时优先保留其情绪转折；位置不同时结合各自语法和上下文判断。中文按自己的口语意群重新组织，不机械复制任一种语言对应词语后的停顿，也不要求每段中文逐词对应同一段日文或英文。
检查停顿两侧能否自然说出口及发音负担是否无意失衡：避免没有明确表演依据地让前段只剩很短的主语，后段堆积几乎全部疑问和谓语内容，造成前段拖长、后段赶读。在本轮允许的调整范围内，可让完整的疑问或语气成分落在停顿前，或选择其他自然语义边界。确有欲言又止的表演依据时可保留短主语后的停顿，不一律禁止。
中文自然、原意和语气准确优先，长度分配只是软参考，不强求各段等长或字数均分，不拆词或固定搭配，不为凑时长增字或堆标点。所有建议服从本轮修改权限和scriptPolicy：allowRewrite=false时只调整标点及允许的分行，正文字符和顺序不变；固定分片数量、逐段等字数及不跨段移动文字的约束仍优先遵守。片内自然停顿不等于新增大分片。保留现有输出协议，仍须通过原有TTS、校字、分段、时长、语速和最终组装验收。$policy$,
true,role,placeholders,source_path,'bilingual-natural-pause-v1:'||key,category FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
