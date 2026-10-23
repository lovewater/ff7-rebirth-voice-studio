-- 唯一声音且模型确认字幕完整时进入环境音支路；缺文/多块/切口失败仍降级。
BEGIN;
INSERT INTO prompt_templates(key,name,"desc",prompt,role,enable,category,placeholders,source_path,seed_hash)
SELECT key,name,"desc" || ' 补充分支：只有一块声音且missing_text_blocks=0时按环境音处理，由程序独立验证声学切口。',
 prompt || E'\n补充分支（优先于前述unknown/fallback措辞）：只有一块候选声音，且官方字幕所有文字已由ASR按顺序完整覆盖时，missing_text_blocks必须为0，kind返回ambient，matched_jp/matched_zh为空。这里的ambient是工作流中“不对应缺失字幕的独立声音”分类，不是声学听辨结论，原因里说明字幕完整、不能凭空补词。程序将独立验证不侵入正文的能量谷切口；切口不可靠仍fallback。若确有缺失普通正文则speech且missing_text_blocks>0；有缺文但不是唯一对应拟声仍fallback。不要一边确认全文完整，一边把它当漏识别正文处理。',
 role,true,category,placeholders,source_path,'complete-text-ambient-v1'
FROM prompt_templates WHERE key='missing-fragment.system' AND enable=true ORDER BY updated_at DESC,id DESC LIMIT 1
ON CONFLICT(seed_hash) DO NOTHING;
COMMIT;
