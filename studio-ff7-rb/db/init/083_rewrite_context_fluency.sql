-- 改稿各分支统一强调对话连贯和中文通顺；保留旧版本、输出协议及声学门槛。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON (key) * FROM prompt_templates
 WHERE enable AND key IN (
  'rewrite.normal.system', 'rewrite.short.system', 'rewrite.slow.system',
  'rewrite.slow.duration-system', 'rewrite.duration.system',
  'rewrite.normal-speed.system', 'rewrite.measured-history.system',
  'two-parts.repair-system', 'fallback-rewrite.system'
 )
 ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 改稿前后逐句核对上下文衔接和中文通顺。',
 prompt||E'\n'||$continuity$【上下文连贯与中文通顺：每轮改稿必须检查】
改写前先通读提供的前后句，确认本句在对话中的作用、说话对象、承接或回答的内容，再组织中文。本句不能只单独看着成立，必须放回对话后也接得上：问答对应，转折、因果和递进关系清楚，称谓、人称、指代、否定、时态及语气一致；承接前文留下的话头，也要让后句的回应有依据。邻句中文有锁定稿时优先参考锁定稿，原稿仅供核对；本句仍以本轮提供的原始中文和日英原意为依据，不继承本句旧锁定稿。
每一稿都必须是自然、通顺、适合人物说出口的中文。检查语序、搭配、主谓宾和修饰关系，避免生硬直译、语病、指代不明、莫名省略、词语堆砌和无意义重复。人物有意打断、口吃或短促接话时保留表演，不强行补成书面完整句；不能用“口语”掩饰病句。不要为了凑字、拍数、分段或时长牺牲中文通顺，也不要只堆标点制造自然感。
提交前把“前句→本句→后句”在文字上连读一遍；若接话突兀、答非所问或句子不顺，先重新组织措辞再输出。只改本句，不改邻句，不添加原文没有的事实、对象、动作、动机或剧情。没有提供上下文时只按已有证据处理，不编造前后句；allowRewrite=false等禁止改字约束仍优先遵守。既有原意、输出JSON协议、校字、语速、时长与声学验收要求全部保留。$continuity$,
 true,role,placeholders,source_path,'rewrite-context-fluency-v1:'||key,category
FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
