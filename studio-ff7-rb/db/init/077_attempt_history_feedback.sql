-- 历史退回原因由attempt-feedback.ts计算，不让模型从旧波形分数猜失败原因。
INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,placeholders,source_path,seed_hash,category) VALUES
('rewrite.attempt-history','已有尝试、问题及统一建议','程序绑定每份稿件和对应音频，计算退回问题、逐条建议及跨稿冲突裁决。history_text是完整独立段落；不包含缩放计算或需要模型推算方向的比值。','{{history_text}}',true,'user','[{"name":"history_text","description":"由程序统一计算的历史尝试、退回原因、建议改进和综合方向","example":"【已有的尝试和出现的问题】\n1. 台词：示例\n退回原因：第二段音频偏短。\n建议改进：调整第二段的自然停顿，第一段保持。"}]'::jsonb,'attempt-feedback.ts','attempt-history-feedback-v1','台词改写'),
('rewrite.measured-history.system','按实测历史改一稿：规则','有已实测候选时替代旧五稿按比筛选的普通改稿提示。一次只写一稿，随后TTS实测；历史原因与建议由独立段提供。','你是《最终幻想7 重生》的中文配音台词编辑。请结合原始台词、上下文、独立中文译文和“已有的尝试和出现的问题”，提出一个自然、准确的新稿。
原始日文、英文、原游戏中文字幕及上下文始终是中心意思；各自独立中文译文仅供参考，有自然贴切的表达可以直接采用，不必另造翻译腔。保留对象、否定、数量、因果、人物关系和核心信息，不新增剧情。中文表达应符合场景与人物口吻，避免堆砌修饰和无意义语气词；拜托了、请多指教等日式表达应按中文语境自然改写。
历史中的退回原因和建议由程序根据各稿自己的真实音频计算。综合改进方向优先，不能只听最后一次退回原因，在失败长稿和短稿间来回切换。已可用的音频必须保留，不能为修复别的失败稿推翻它。优先用自然断句、停顿和必要的小幅措辞调整，不拆词、逐字堆标点或机械重复语气词。
遵守当前分片协议：两端对话的lines模式恰好两行，三段对话恰好三行，每行对应一个目标音频分片；行内可以有自然标点和轻微停顿。strict/relaxed模式按本轮另附协议执行。最终字幕最多两行的排版限制不约束TTS分片。
每次只提出一个新稿，随后程序TTS实测；不得将旧音频的测量和合格状态套给新稿，也不能声称已预测出精确时长。若历史标注需原稿重试，不为改而改。不得使用啰或囉；表达两时不要输出数字2或２。
只输出JSON：situation、problem、plan、text、risk；text为完整台词，按分片需要换行，不输出Markdown。',true,'system','[]'::jsonb,'rewrite-prompt.ts','measured-history-system-v1','台词改写'),
('rewrite.measured-history.context','按实测历史改一稿：上下文','input_json包含角色、原始三语、当前稿、上下文、日文分段偏好和既有字符上下限；历史问题由另一独立段落提供。','{{input_json}}',true,'user','[{"name":"input_json","description":"原始三语、当前稿、前后文和分片/字符约束，不给新稿伪造音频实测","example":"{\"speaker\":\"仙人\",\"current\":\"当前台词\",\"originalChinese\":\"原游戏中文字幕\"}"}]'::jsonb,'rewrite-prompt.ts','measured-history-context-v1','台词改写') ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_groups(key,name,"desc",category) VALUES ('rewrite.measured-history','按实测历史改稿','具体稿件绑定音频事实，程序计算失败原因和统一方向；一稿后立即TTS，不按旧音频评分捡回失败稿。','台词改写') ON CONFLICT(key) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES ('rewrite.measured-history','rewrite.measured-history.system',0),('rewrite.measured-history','rewrite.measured-history.context',10),('rewrite.measured-history','rewrite.attempt-history',20) ON CONFLICT DO NOTHING;

INSERT INTO prompt_group_members(group_key,prompt_key,position) SELECT key,'rewrite.attempt-history',30 FROM prompt_groups WHERE key IN ('two-parts','three-parts') ON CONFLICT DO NOTHING;
