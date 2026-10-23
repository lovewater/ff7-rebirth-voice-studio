-- 独立日译中、英译中仅作为改稿参考；不改拍数、ASR定位和TTS正文。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
VALUES ('rewrite.translation-reference','改稿参考：日英原文与独立中文译文',
'正常五稿、手动改稿、整体降级改稿、两/三段断句改稿共用。references按“参考日文/英文：原文（独立中文译文）”配对；译文来自lines.translate_zh_jp/en。无译文不注入，不影响校字与计时。',
'以下是本句原始外语台词及其独立中文参考译文。括号前为原文，括号内为对应中文译文：
{{references}}
请主动参考其中自然、贴切的中文表达。尤其英文参考译文有合适的口语、比喻或人物口吻时，可以直接采用，不必为了改写而另造一个更生硬的说法。结合原日文、英文、游戏原中文字幕与上下文保全中心意思；参考译文也可能有误，不新增事实或遗漏否定、条件、称谓。参考译文不是额外必须朗读的内容，已经剔除并保留原声的情绪词不要加回TTS正文。计时与分片仍依据当前任务提供的实际音频/ASR证据，不从参考译文伪造时长。按当前任务既有JSON协议输出。',
'user',true,'台词改写','[{"name":"references","description":"日文与英文原文，分别紧跟括号包住的独立中文译文；仅有原文时不编造译文。","example":"参考日文：ありがとう（谢谢）\n参考英文：Much obliged.（多谢了。）"}]'::jsonb,
'rewrite-translation-reference.ts','rewrite-translation-reference-v1') ON CONFLICT(seed_hash) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position)
SELECT key,'rewrite.translation-reference',99 FROM prompt_groups WHERE key IN ('rewrite.duration','rewrite.normal','rewrite.short','rewrite.slow','rewrite.manual','fallback-rewrite','two-parts')
ON CONFLICT DO NOTHING;
COMMIT;
