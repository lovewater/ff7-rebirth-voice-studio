-- 候选实测中文净语速4.5～6.0（含边界）时忽略比；不把豁免继承给尚未TTS的新稿。
INSERT INTO prompt_templates (key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash) VALUES
('rewrite.normal-speed.system','正常中文净语速改稿：规则','已校字候选中文净语速4.5～6.0音节/秒，拍数比不再参与该候选淘汰。仅因其他实际问题改稿，一稿后立即TTS重测。','你是《最终幻想7 重生》中文配音台词编辑。程序已实测并绑定某条候选的中文正文净语速在4.5～6.0音节/秒（含边界），该候选忽略拍数比，不设比值合格带，不追求接近1，不得仅因比偏离而增删文字。
所有测量只属于measuredCandidate.candidateId及script，禁止把旧音频的时长和合格状态归给新台词。新稿尚未TTS，净语速未知，下一轮必须重新测量，不能声称新稿也自动获得豁免。
当前仍需改稿时，只解决实际校字、分段、逐段时长或最终拼装问题。优先自然断句、保留合理停顿，必要时才小幅改字；不堆赘词、不逐字插停顿、不恢复已因其他原因退回的失败长稿。保留原始日中英字幕中心意思、对象、否定、数量和人物语气；已保留的情绪原声不得写回正文。字幕用自然简体中文，不使用啰或囉。
只输出JSON：situation、problem、plan、text、risk。只给一份完整新稿；遵守本轮两端/三段分片协议，改后立即由程序合成实测。','system',true,'台词改写','[]'::jsonb,'rewrite-prompt.ts','normal-speed-system-20261020-v1'),
('rewrite.normal-speed.context','正常中文净语速改稿：上下文','input_json包含原始三语、当前稿、绑定具体音频ID的净语速/时长、上下文和分段提示。例如measuredCandidate={candidateId:"123",rate:5.5,netSeconds:4.9,script:"原稿",referenceSeconds:4.8,candidateSeconds:4.9}；只有该候选获豁免。','{{input_json}}','user',true,'台词改写','[{"name":"input_json","description":"原始三语、当前稿、具体候选测量及前后文，测量不可套给新稿","example":"{\"measuredCandidate\":{\"candidateId\":\"123\",\"rate\":5.5,\"netSeconds\":4.9}}"}]'::jsonb,'rewrite-prompt.ts','normal-speed-context-20261020-v1')
ON CONFLICT DO NOTHING;

INSERT INTO prompt_groups(key,name,"desc",category) VALUES ('rewrite.normal-speed','中文净语速正常时改稿','已有候选净语速4.5～6.0时忽略比，仅针对其他实测问题改一稿后立即TTS重测。','台词改写') ON CONFLICT(key) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES ('rewrite.normal-speed','rewrite.normal-speed.system',0),('rewrite.normal-speed','rewrite.normal-speed.context',10) ON CONFLICT DO NOTHING;

-- 共用的分段修复/普通改稿也必须知道程序新增豁免，避免提示词仍把比当无条件硬门槛。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category)
SELECT p.key,p.name,p."desc" || ' 中文正文实测净语速4.5～6.0音节/秒时，程序忽略拍数比。',
 p.prompt || E'\n程序新增规则：每条已实测中文正文候选的净语速在4.5～6.0音节/秒（含边界）时，该候选忽略拍数比，不因比偏离而淘汰、改字或按接近1择优；保留实际比仅作诊断。校字、分段、实际时长和最终组装要求不变。净语速扣除情绪原声及连续长静音，不能用整句总长稀释。速度未知或区间外不自动豁免，新台词必须重新TTS测量，禁止拿旧音频的实测速度/时长宣称新稿已合格。需要改稿时以真实失败项为依据，优先自然断句节奏，不为凑比恢复冗长旧稿。',
 true,p.role,p.placeholders,p.source_path,'normal-speed-shared-rule-20261020-v1',p.category
FROM (SELECT * FROM prompt_templates WHERE key='rewrite.chinese-speed-limit' AND enable ORDER BY updated_at DESC,id DESC LIMIT 1) p
ON CONFLICT(seed_hash) DO NOTHING;
