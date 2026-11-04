/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS 独立脚本及测试加载器 */
// 只读扫描原中文字幕、双语译文及历史朗读稿/字幕；不改历史音频或锁定状态。
// 用法：node scripts/audit-liao-pronunciation.cjs > /工程/work/liao-audit.json
const {base,load}=require('./translation/load-production.cjs');
const {sql}=load(base+'/src/lib/db.ts');
const {applyTtsPronunciation}=load(base+'/src/lib/tts-pronunciation.ts');
const dictionary=require('../src/lib/pronunciation/liao3.json');
(async()=>{
 try {
  const rows=await sql`
   select stem,'original' as source,text_zh as text from lines where text_zh like '%了%'
   union all select stem,'jp-translation',translate_zh_jp from lines where translate_zh_jp like '%了%'
   union all select stem,'en-translation',translate_zh_en from lines where translate_zh_en like '%了%'
   union all select stem,'tts',tts_text from line_tts_versions where tts_text like '%了%'
   union all select stem,'spoken',spoken_text from line_tts_versions where spoken_text like '%了%'
   union all select stem,'subtitle',subtitle_text from line_tts_versions where subtitle_text like '%了%'`;
  const changed=rows.map(row=>({...row,mapped:applyTtsPronunciation(row.text)})).filter(r=>r.text!==r.mapped);
  const words=dictionary.rules.map(rule=>{
   const matches=changed.filter(row=>row.text.includes(rule.word)&&row.mapped.includes(rule.replacement));
   return {...rule,stems:new Set(matches.map(r=>r.stem)).size,originalStems:new Set(matches.filter(r=>r.source==='original').map(r=>r.stem)).size,examples:matches.slice(0,3)};
  });
  console.log(JSON.stringify({scannedTextRows:rows.length,changedTextRows:changed.length,affectedStems:new Set(changed.map(r=>r.stem)).size,words,changed},null,2));
 } finally {await sql.end();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
