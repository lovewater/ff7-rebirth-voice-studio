// Remake-only prompt clarification. The existing nonempty/empty JSON guards stay unchanged.
const {hash}=require('./policy.cjs');
const NONEMPTY_SOURCE_RULE=[
 '【源语正文与空字符串必须区分】',
 'current 是本次已保存的待译源语文字，不是识别状态或音频元数据。字面文字“空”“空。”等都属于实际存在的非空正文，必须按指定源语言忠实译出，translation 必须是非空字符串；不能把“空”这个词当成空文本、无字幕、静音或无需翻译的标记。',
 '只有 current 实际没有任何源文本、为真正的空字符串时，才允许返回 {"translation":""}。不要根据原文字义、短句、拟声、无上下文或怀疑ASR误识而擅自清空译文，也不要推测音频是否无声。',
 '只翻 current 已有文字，不编造正文、不改ASR原文、不翻译上下文；仍只输出唯一 translation 字段的完整JSON。',
].join('\n');
function patchedSystem(template){return template.includes('【源语正文与空字符串必须区分】')?template:NONEMPTY_SOURCE_RULE+'\n\n'+template;}
async function appendNonemptySourceSystem(sql){
 const [old]=await sql`SELECT * FROM prompt_templates WHERE key='translation.independent.system' AND enable=true ORDER BY updated_at DESC,id DESC LIMIT 1`;
 if(!old||old.role!=='system')throw Error('translation-system-prompt-missing');
 const prompt=patchedSystem(old.prompt),seed='remake-translation-literal-nonempty-source-v1-'+hash(prompt);
 const inserted=await sql`INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,category,placeholders,source_path,seed_hash)
 VALUES('translation.independent.system',${old.name+' · 字面非空正文'},'Remake字面“空”等词不是空文本/静音元数据；非空源必须忠实非空翻译，真正空字符串才可空译',${prompt},true,'system',${old.category},${sql.json(old.placeholders)},'studio-ff7-remake/scripts/preprocess/nonempty-source-prompt.cjs',${seed}) ON CONFLICT(seed_hash) DO NOTHING RETURNING id`;
 return {previous_id:String(old.id),new_id:inserted[0]?String(inserted[0].id):null,seed_hash:seed};
}
module.exports={NONEMPTY_SOURCE_RULE,patchedSystem,appendNonemptySourceSystem};
