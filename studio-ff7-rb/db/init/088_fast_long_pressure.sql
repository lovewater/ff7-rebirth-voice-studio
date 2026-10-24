-- 数值由正常净语速区间常量传入，不在模板里维护第二套范围。
BEGIN;
WITH base AS (
 SELECT * FROM prompt_templates WHERE key='rewrite.chinese-speed-limit' AND enable
 ORDER BY updated_at DESC,id DESC LIMIT 1
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT 'rewrite.fast-long-pressure','偏快与中文偏长的联合改稿','引用正常区间，联合可靠的归一拍数比要求精简。',
$policy$【正常区间与中文长度联合判断】
中文净语速正常区间为{{normal_low}}–{{normal_high}}音节/秒（含两端），数值由程序同源常量提供。既有绝对语速硬上限独立执行；没超过硬上限不代表语速正常。
如果本稿某条已核字音频超过正常区间上限，虽然原硬上限检查通过，但同一稿可靠的归一拍数“比”还低于本句既定下限（中文偏长），两个信号共同说明文字负担偏重：优先精简冗余、缩短朗读稿，保留中心意思、对象、否定和人物语气，再重新TTS并验收。不仅靠放慢、加空白或堆标点把数值做合格；音频偏短时也不要反向继续补字。
比值单独豁免或仅供参考时，仍可用于上述联合判断；正常区间内继续沿用原有比值豁免。只有语速偏快、比值在范围内，或比值偏高（中文偏短），不能套用本条要求减字。低于正常区间下限是偏慢，也不能据此减字。短句没有可计算的比、测量缺失或不可靠时，不从日文拍数重算、猜测或伪造比值触发此条件。
本条只使用本稿本条音频的实际测量，不把旧音频数据套给新稿；校字错误或分片对应不可靠时先修合成/结构，不据虚假语速改字。遵守allowRewrite和scriptPolicy，不能越过禁止改字权限。普通改写沿用既有重试预算；斜体独立流程仍仅在TTS出错或处理后总长超限时重试，不增加斜体的独立语速/比值淘汰条件。$policy$,
true,'user','[{"name":"normal_low","description":"正常区间下限，来自程序常量","example":4.5},{"name":"normal_high","description":"正常区间上限，来自程序常量","example":7}]'::jsonb,
'src/lib/fast-long-pressure.ts','fast-and-long-rewrite-v1',category FROM base
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;

-- 系统模板明确联合例外，避免旧“比仅参考、不得据此缩短”覆盖用户级测量反馈。
BEGIN;
WITH active AS (
 SELECT DISTINCT ON(key) * FROM prompt_templates WHERE enable AND key IN (
 'rewrite.normal.system','rewrite.short.system','rewrite.slow.system','rewrite.slow.duration-system',
 'rewrite.duration.system','rewrite.normal-speed.system','rewrite.measured-history.system','two-parts.repair-system','fallback-rewrite.system'
 ) ORDER BY key,updated_at DESC,id DESC
)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 明确偏快与偏长联合改稿例外。',prompt||E'\n'||$exception$【比值豁免的联合改稿例外】
前述比值豁免或“仅供参考、不据此缩短”是指不按比值单独淘汰或改稿。如果本轮程序已核字且分片对应可靠的同一候选，被明确反馈为fast-and-long（净语速高于所给正常区间上限、原硬上限仍通过，并且可靠的归一拍数比低于该句原有下限、中文偏长），必须把两个证据联合考虑，优先精简冗余、缩短朗读稿后重新TTS与验收；此例外不受前述单独比值豁免的禁止减字表述限制。
正常区间数值引用本轮rewrite.fast-long-pressure消息中的程序值，不另设数值。正常区间内、仅语速偏快但比值正常或偏高、比值缺失及短句不能计算比时，不套用这条联合例外，不伪造测量。若同时音频偏短，先处理过快与过多的文字负担，再用自然节奏解决跨度，不反向继续增字或用长空白稀释语速。仍遵守原意、allowRewrite、固定分片及本轮其他硬检查；所有新稿均重新TTS核字和实测。$exception$,
true,role,placeholders,source_path,'fast-and-long-system-v1:'||key,category FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
