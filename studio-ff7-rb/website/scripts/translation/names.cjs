// 人名表来自官方TxtRes；仅匹配本句英文，不将整表或上下文名字塞进模型。
const fs=require('node:fs'),path=require('node:path');
const normalize=x=>String(x).normalize('NFKC').replace(/[’‘]/g,"'");
const escape=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function loadNames(stateDir){const file=path.join(stateDir,'name-glossary.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{revision:null,entries:[]};}
function compileNames(catalog){return {...catalog,entries:catalog.entries.filter(r=>r.matchable).map(r=>({...r,patterns:r.english_aliases.flatMap(alias=>[alias,alias.toUpperCase()]).map(alias=>new RegExp('(?<![\\p{L}\\p{N}_])'+escape(normalize(alias)).replace(/\s+/g,'\\s+')+'(?![\\p{L}\\p{N}_])','gu'))}))};}
function currentEnglishNames(text,catalog){
 const source=normalize(text||''),hits=[];
 for(const entry of catalog.entries)for(const pattern of entry.patterns){pattern.lastIndex=0;for(const match of source.matchAll(pattern))hits.push({start:match.index,end:match.index+match[0].length,entry});}
 // 长名称优先占用范围：Billy Bob不能再命中Billy，Bill不能命中Billy。
 hits.sort((a,b)=>(b.end-b.start)-(a.end-a.start)||a.start-b.start);
 const accepted=[];
 for(const h of hits)if(!accepted.some(x=>h.start<x.end&&h.end>x.start))accepted.push(h);
 return [...new Map(accepted.sort((a,b)=>a.start-b.start).map(h=>[h.entry.english,h.entry])).values()];
}
const promptNames=entries=>entries.map(({english,japanese,chinese})=>({english,japanese,chinese}));
/** 只验证当前源句确实出现且本句英文也命中的名字。日文没说该名字时不允许强塞。
 * 不让上下句名字变成额外朗读要求；NFKC兼容MAI/全角字符，保留官方名字的中点等。
 */
function validateNames(translation,source,lang,entries){
 const output=normalize(translation).replace(/\s/g,'');
 for(const r of entries){
  const mentioned=lang==='en'||(r.japanese&&normalize(source).includes(normalize(r.japanese)));
  if(mentioned&&!output.includes(normalize(r.chinese).replace(/\s/g,''))){const e=new Error('译文未使用本句官方人名');e.code='translation-name-mismatch';throw e;}
 }
}
module.exports={loadNames,compileNames,currentEnglishNames,promptNames,validateNames};
