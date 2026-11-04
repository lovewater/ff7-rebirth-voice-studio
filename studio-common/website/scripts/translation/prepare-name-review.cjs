#!/usr/bin/env node
// --apply才改断点队列；同名表版本只准备一次。旧译文保持可读，重译成功时由worker替换。
const {base,load}=require('./load-production.cjs'),{sql}=load(base+'/src/lib/db.ts');
const {loadNames,compileNames,currentEnglishNames}=require('./names.cjs'),path=require('node:path'),fs=require('node:fs');
const stateDir=path.resolve(process.env.TRANSLATION_STATE_DIR||base+'/data/translation-background');
(async()=>{const catalog=compileNames(loadNames(stateDir));if(!catalog.revision)throw Error('先生成官方人名表');
 const rows=await sql`SELECT stem,text_en FROM lines WHERE nullif(btrim(text_en),'') IS NOT NULL ORDER BY id`;
 const selected=rows.map(r=>({...r,names:currentEnglishNames(r.text_en,catalog)})).filter(r=>r.names.length);
 fs.writeFileSync(path.join(stateDir,'name-review-manifest.json'),JSON.stringify({revision:catalog.revision,selected:selected.map(r=>({stem:r.stem,names:r.names.map(n=>({english:n.english,chinese:n.chinese}))}))},null,2));
 const summary={revision:catalog.revision,officialTerms:catalog.entries.length,matchedLines:selected.length,queued:[]};
 if(process.argv.includes('--apply')){
  const stems=selected.map(r=>r.stem),priority=['NIBLE_QST_01_0800_1700_00_grb','NIBLE_QST_01_0100_0200_00_cld'];
  for(const lang of ['jp','en']){const dst=sql(lang==='jp'?'translate_zh_jp':'translate_zh_en');
   const updates=await sql`UPDATE line_translation_jobs j SET status='pending',attempts=0,next_attempt_at=now(),claimed_at=NULL,completed_at=NULL,error=NULL,updated_at=now(),
     previous_translation=l.${dst},name_review_target=${catalog.revision},name_review_priority=CASE WHEN l.stem=ANY(${priority}) THEN 100 ELSE 0 END
     FROM lines l WHERE l.stem=j.stem AND j.source_language=${lang} AND j.stem=ANY(${stems})
     AND j.name_review_target IS DISTINCT FROM ${catalog.revision} RETURNING j.stem`;
   summary.queued.push({lang,count:updates.length});
  }
 }
 console.log(JSON.stringify(summary,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>sql.end({timeout:3}));
