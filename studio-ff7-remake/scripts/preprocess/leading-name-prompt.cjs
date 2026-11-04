#!/usr/bin/env node
// Remake-only prompt patch. Runtime reads latest enabled input per request, so no worker restart.
const {hash}=require('./policy.cjs');
const LEADING_NAME_RULE=[
 '【当前条的正文边界】',
 'current 中的换行只是字幕显示换行，不是说话人分隔符。行首单独出现的人名、称呼、呼语也属于当前条要翻译的台词正文，不是说话人标签，不能省略。',
 '例如当前原文先呼唤一个人名、换行后再说请求时，译文也必须保留这句呼唤和后续请求，不能只翻译请求；使用本句给定的官方人名对照。不要因为上下文已经能猜出对象就删掉原文已有的人名。',
 '只翻 current 的完整正文；before/after 仅帮助理解，不翻译、不搬入当前译文，也不从另一源语言补写当前原文没有的内容。',
].join('\n');
function patchedInput(template){return template.includes('【当前条的正文边界】')?template:LEADING_NAME_RULE+'\n\n'+template;}
async function appendLeadingNameInput(sql){
 const [old]=await sql`SELECT * FROM prompt_templates WHERE key='translation.independent.input' AND enable=true ORDER BY updated_at DESC,id DESC LIMIT 1`;
 if(!old||old.role!=='user')throw Error('translation-input-prompt-missing');
 const prompt=patchedInput(old.prompt),seed='remake-translation-current-leading-name-v1-'+hash(prompt);
 const inserted=await sql`INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,category,placeholders,source_path,seed_hash)
 VALUES('translation.independent.input',${old.name+' · 保留行首呼语'},'Remake当前条换行仅为显示排版；行首名字/呼语属于正文，不当作说话人标签省掉；不翻上下文',${prompt},true,'user',${old.category},${sql.json(old.placeholders)},'studio-ff7-remake/scripts/preprocess/leading-name-prompt.cjs',${seed})
 ON CONFLICT(seed_hash) DO NOTHING RETURNING id`;
 return {previous_id:String(old.id),new_id:inserted[0]?String(inserted[0].id):null,seed_hash:seed};
}
module.exports={LEADING_NAME_RULE,patchedInput,appendLeadingNameInput};
