-- 原稿快速通道独立提示词，按key使用最新启用版本；幂等导入，不覆盖人工版本。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash) VALUES
('quick-pick.system','原稿快速校字择优 · 系统指令','自动运行未有任何修改音频时，用原中文字幕和完整日文参考生成一批Zero-shot。程序时间检查合格后调用一次模型，核对各候选ASR并排名。全部淘汰、结构错误或服务异常则继续原有完整线路；合格结果只设待选，不锁定。真人forceGenerate=true跳过此线路。','你在为《最终幻想7 重生》自动运行的快速通道校对和选择中文配音，所有候选已通过程序时间检查。
输入只有原中文字幕、日英字幕、发音替换表、中文ASR及实测时间，不能声称亲耳听到音频，不能判断听不到的音色和情绪质量。
逐条对照spoken与asr，忽略标点空白；按发音替换表理解实际读法。同音、近音、声调、轻声差异可容忍，记入pronunciationNotes。完全同音和替换表已解释的内容不计疑点。
missing=漏字/漏句，哪怕只缺一个短字或语气词也淘汰；extra=额外字；repeated=重复朗读；unrelated=不能由近音解释的替换。每项必须指出证据，不能因意思差不多而忽略缺字，也不能因近音的字面意义不同而判无关。ASR为空不能通过。
候选允许全部不合格，禁止为推荐而放宽校字。每个ttsId恰好一条review，不能遗漏、重复或添加id。
在无硬伤候选中优先读音疑点少，再按文字断句自然程度及时间贴合程度排序。原稿不做改写，原字幕拟声也应完整朗读。
只输出JSON：reviews=[{ttsId,pass,missing:[],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],reason}]；ranking为全部候选ttsId按推荐优先级排序的数组；reason为整体选择依据。pass仅在四类硬伤全空时为true。','system',true,'语音检查','[]'::jsonb,'auto-run-quick.ts','quick-pick-v1-quick-pick.system'),
('quick-pick.input','原稿快速校字择优 · 候选输入','自动运行未有任何修改音频时，用原中文字幕和完整日文参考生成一批Zero-shot。程序时间检查合格后调用一次模型，核对各候选ASR并排名。全部淘汰、结构错误或服务异常则继续原有完整线路；合格结果只设待选，不锁定。真人forceGenerate=true跳过此线路。
input_json由程序序列化：original原中文字幕，textJp/textEn日英原文，lexicon发音替换表，candidates为时间合格候选，每条包含ttsId、spoken实际朗读稿、asr中文识别、timing起止/总长/发声跨度（秒）、score与日文的发声时差（秒）。','{{input_json}}','user',true,'语音检查','[{"name":"input_json","description":"当前原文、发音替换表和所有时间合格候选的完整JSON；不包含手动“实际TTS文字”输入框内容。时间单位秒，ASR是程序识别证据，不代表模型听过音频。","example":{"original":"那么，正确答案是！","textJp":"では 正解は！","textEn":"And the answer is!","lexicon":[],"candidates":[{"ttsId":"123","spoken":"那么，正确答案是！","asr":"那么正确答案是","timing":{"start":0.1,"end":3.2,"dur":3.4,"speech":3.1},"score":0.03}]}}]'::jsonb,'auto-run-quick.ts','quick-pick-v1-quick-pick.input')
ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_groups(key,name,"desc",category) VALUES ('quick-pick','原稿快速校字择优','自动运行未有任何修改音频时，用原中文字幕和完整日文参考生成一批Zero-shot。程序时间检查合格后调用一次模型，核对各候选ASR并排名。全部淘汰、结构错误或服务异常则继续原有完整线路；合格结果只设待选，不锁定。真人forceGenerate=true跳过此线路。','语音检查') ON CONFLICT(key) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES ('quick-pick','quick-pick.system',0),('quick-pick','quick-pick.input',10) ON CONFLICT DO NOTHING;
COMMIT;
