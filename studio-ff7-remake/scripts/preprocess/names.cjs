// Remake-only Japanese name lookup. Shared Rebirth English-only policy remains untouched.
const path=require('node:path');
const shared=require(path.resolve(__dirname,'../../../studio-common/website/scripts/translation/names.cjs'));
const normalize=value=>String(value??'').normalize('NFKC').replace(/[’‘]/g,"'");
function japaneseAliases(entry){
 const aliases=[entry.japanese];
 for(const alias of entry.japanese_aliases??[]){
  if(typeof alias==='string'&&entry.japanese_aliases_verified===true)aliases.push(alias);
  else if(alias&&typeof alias==='object'&&alias.verified===true&&alias.evidence)aliases.push(alias.text??alias.value);
 }
 return [...new Set(aliases.filter(value=>typeof value==='string'&&value.trim()).map(normalize))];
}
function key(entry){return `${entry.english}\0${entry.chinese}`;}
const katakana=char=>!!char&&/^[\p{Script=Katakana}]$/u.test(char);
function japaneseNameBoundary(source,start,end){
 let left=start-1;while(left>=0&&source[left]==='ー')left--;
 if(katakana(source[left]))return false;
 let right=end;while(source[right]==='ー')right++;
 if(!katakana(source[right]))return true;
 let finish=right;while(katakana(source[finish])||source[finish]==='ー')finish++;
 // Permit explicit vocative suffixes, never a longer Katakana word containing the name.
 return ['サン','クン','チャン','サマ','センセイ','ドノ'].includes(source.slice(right,finish));
}
function currentJapaneseNames(text,catalog){
 const source=normalize(text),hits=[];
 for(const entry of catalog.entries){if(!entry.matchable)continue;for(const alias of japaneseAliases(entry)){
  for(let start=source.indexOf(alias);start!==-1;start=source.indexOf(alias,start+1))if(japaneseNameBoundary(source,start,start+alias.length))hits.push({start,end:start+alias.length,entry});
 }}
 hits.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||a.start-b.start);const accepted=[];
 for(const hit of hits)if(!accepted.some(other=>hit.start<other.end&&hit.end>other.start))accepted.push(hit);
 return [...new Map(accepted.sort((a,b)=>a.start-b.start).map(hit=>[key(hit.entry),hit.entry])).values()];
}
function currentNames(japanese,english,catalog){return [...new Map([...currentJapaneseNames(japanese,catalog),...shared.currentEnglishNames(english,catalog)].map(entry=>[key(entry),entry])).values()];}
function requiredNames(source,language,entries){return language==='jp'?currentJapaneseNames(source,{entries}):shared.currentEnglishNames(source,{entries});}
function promptNames(entries,source,language){
 const actual=new Set(requiredNames(source,language,entries).map(key));
 return entries.map(entry=>{const englishAliases=[...new Set((entry.english_aliases??[]).filter(alias=>typeof alias==='string'&&normalize(alias)!==normalize(entry.english)))];return {...shared.promptNames([entry])[0],...(englishAliases.length?{verified_english_aliases:englishAliases}:{}),...(japaneseAliases(entry).length>1?{verified_japanese_aliases:japaneseAliases(entry).slice(1)}:{}),matched_in_current_source:actual.has(key(entry))};});
}
function nameGlossaryText(entries,source,language){
 const payload=promptNames(entries,source,language),actual=requiredNames(source,language,entries),lines=[];
 for(const entry of actual){
  const spellings=[];
  if(language==='en')for(const pattern of entry.patterns??[]){pattern.lastIndex=0;for(const match of normalize(source).matchAll(pattern))spellings.push(match[0]);}
  else for(const alias of japaneseAliases(entry))if(normalize(source).includes(alias))spellings.push(alias);
  for(const spelling of new Set(spellings))lines.push(`${JSON.stringify(spelling)} → ${JSON.stringify(entry.chinese)}`);
 }
 return JSON.stringify(payload)+'\n【当前待译原文已命中的官方姓名强制映射】\n'+(lines.length?lines.join('\n')+'\n这些映射是人物姓名的唯一官方译法。姓名即使组成杯赛、地点或机构等复合名称，也使用上述官方译法，不能重新音译。只翻原文实际出现的姓名，不增加其他名字。':'当前待译原文没有命中的姓名；其他来源命中的词表条目只供辨认，不能强行加入当前译文。');
}
function validateNames(translation,source,language,entries){
 const output=normalize(translation).replace(/\s/g,'');
 for(const entry of requiredNames(source,language,entries))if(!output.includes(normalize(entry.chinese).replace(/\s/g,''))){const error=Error('译文未使用当前源文命中的官方人名');error.code='translation-name-mismatch';throw error;}
}
module.exports={...shared,currentJapaneseNames,currentNames,requiredNames,promptNames,validateNames,japaneseAliases,nameGlossaryText};
