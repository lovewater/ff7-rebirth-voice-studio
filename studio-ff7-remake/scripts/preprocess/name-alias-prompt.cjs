// Only Remake prompt maintenance; the shared Rebirth glossary/policy is unchanged.
const {hash}=require('./policy.cjs');
const ENGLISH_ALIAS_RULE=[
 '【英文别名与人物身份】',
 'verified_english_aliases 是本作已审核的英文别名/简称；它们与同一条 english 标准名指向同一人物，必须统一使用该条 chinese 官方中文名，不把别名当作陌生人重新音译。',
 '当前待译原文命中已验证别名且 matched_in_current_source=true 时，同样必须保留并使用该官方中文名；false 项仍只供辨认，不得补写原文未出现的人物。',
 '当前原文已命中的官方姓名强制映射是唯一译法；姓名出现在杯赛/地点/机构等复合名称内也不得重新音译，但不能把未命中的人名补进当前句。',
].join('\n');
function patchedNamePrompt(template){if(template.includes('【英文别名与人物身份】'))return template;if(!template.includes('{{name_glossary}}'))throw Error('name-glossary-placeholder-missing');return template.replace('{{name_glossary}}',ENGLISH_ALIAS_RULE+'\n{{name_glossary}}');}
async function appendEnglishAliasPrompt(sql){
 const [old]=await sql`SELECT * FROM prompt_templates WHERE key='translation.name-glossary' AND enable=true ORDER BY updated_at DESC,id DESC LIMIT 1`;
 if(!old||old.role!=='user')throw Error('name-prompt-missing');
 const prompt=patchedNamePrompt(old.prompt),seed='remake-translation-verified-english-alias-v1-'+hash(prompt);
 const rows=await sql`INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,category,placeholders,source_path,seed_hash)
 VALUES('translation.name-glossary',${old.name+' · 已验证英文别名'},'Remake已审核英文alias与标准英文名同一人物，使用同一官方中文名；不补原文未出现的人物',${prompt},true,'user',${old.category},${sql.json(old.placeholders)},'studio-ff7-remake/scripts/preprocess/name-alias-prompt.cjs',${seed}) ON CONFLICT(seed_hash) DO NOTHING RETURNING id`;
 return {previous_id:String(old.id),new_id:rows[0]?String(rows[0].id):null,seed_hash:seed};
}
module.exports={ENGLISH_ALIAS_RULE,patchedNamePrompt,appendEnglishAliasPrompt};
