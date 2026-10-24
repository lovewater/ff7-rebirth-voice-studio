-- 最终择优解释跨度比，展示净语速/归一拍数比和用户指定的综合描述；不改硬门槛。
BEGIN;
WITH active AS (SELECT * FROM prompt_templates WHERE key='rhythm-pick.system' AND enable ORDER BY updated_at DESC,id DESC LIMIT 1)
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT key,name,"desc"||' 解释跨度比并显示净语速、拍数比及综合语速描述。',
replace(prompt,'这些候选字和语速都已经过关。','这些候选已通过程序要求的前置检查；通过不代表净语速或拍数比都处在正常区间。')||E'\n'||$metrics$【最终择优的数值解释与语速描述】
paceRatio=中文朗读跨度÷日文参考朗读跨度。单句跨度取首末发声，包含段内自然停顿；多段取对应各段朗读跨度之和，不含首尾及段间留白。1表示跨度相同，1.10表示中文长10%，0.90表示中文短10%。它不是音节/秒，也不是拍数“比”；接近1不代表吐字速度正常，不能据此臆测听感或压过中文表达自然度。
每条候选的netSpeech提供实测净语速rate（音节/秒）、本轮正常区间normalRange、净发声秒数和音节数，以及偏快/正常/偏慢状态。beat.normalizedRatio是已归一的拍数“比”=(日文拍÷中文拍)÷1.20；大于1中文偏短、同槽可能偏慢，小于1中文偏长、同槽可能偏快。beat.normalRange使用该句现有判断区间，beat.exempt/exemption说明是否单独豁免；豁免不等于数值正常，缺失比不能补作1。
speedDescription由程序结合两项同一候选测量给出：两项同向不合适为“速度有些过快/速度有些过慢”；仅一项不合适为“速度有些稍快/速度有些稍慢”；两项均正常为“语速正常”；两项方向相反为“语速有点奇怪”。比或净语速缺失时speedEvidenceComplete=false，只按已有证据给出稍快/稍慢或“语速数据不足”，不能当成两项都正常。
这些是供给定候选间择优的证据，不是新增硬门槛，不得选回已淘汰的候选。结合中文自然程度、前后文衔接、语速描述和实际提供的分段证据综合选择；不要只选paceRatio最接近1的候选，不臆测未提供的声线或声学听感。$metrics$,true,role,placeholders,source_path,'final-pick-speed-v1',category FROM active
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
