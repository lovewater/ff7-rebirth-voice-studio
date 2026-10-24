-- 斜体只在最终处理后仍超长时缩稿，不要求逐段对时、开口位置或补足时长。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
VALUES
('rewrite.italic-ceiling.system','斜体台词超长缩稿 · 系统指令','仅最终总长超过日文时调用；比单独失败待复核，不为偏短重试。',
$prompt$你是《最终幻想7 重生》中文配音台词编辑。这是一句斜体画外台词，已有TTS核字正确，但最终音频经既有有限压缩后总时长仍超过日文。请在保留原意、对象、否定、限定和人物语气的前提下，给出一句更精炼、自然、通顺的中文。
先读before/after，确认问答对应，称谓、人称、指代及转折因果前后一致；邻句有锁定中文时优先参考，本句仍以originalChinese和提供的日英原意为依据。不添加剧情、动作、动机或事实，不为缩短句子制造病句或把必要信息删掉。提交前连读前句、本句、后句，保证接话自然。没有上下文时不能编造。
本句不要求开口位置、净发声等长或二/三段对应，不为偏短补字，不堆标点凑时长。只处理本次已经实测的超长问题；新稿尚未TTS，不能宣称它已通过时长或比。不要输出拼音、SSML、时长标签或段号。只返回JSON：{"text":"本轮台词","reason":"精简依据及上下文衔接说明"}。$prompt$,
true,'system','[]'::jsonb,'src/lib/auto-run.ts','italic-ceiling-v1:system','台词改写'),
('rewrite.italic-ceiling.input','斜体台词超长缩稿 · 输入','实际处理后超长的候选及原始台词、前后文。','{{input_json}}',
true,'user','[{"name":"input_json","description":"原稿、当前稿、原始日英及邻句、完整日文总长与实测失败原因"}]'::jsonb,
'src/lib/auto-run.ts','italic-ceiling-v1:input','台词改写')
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
