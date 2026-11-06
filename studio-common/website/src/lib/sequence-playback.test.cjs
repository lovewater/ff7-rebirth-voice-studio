/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),{execFileSync}=require('node:child_process');
const container=process.env.FF7_TEST_POSTGRES_CONTAINER;
const fixture=`WITH lines(id,stem,region,kind,speaker,text_jp,text_zh,subtitle_italic) AS (VALUES
 (1,'a','r','scene','cld','JP','原文',false),(2,'b','r','scene','cld','JP','原文',false),
 (3,'c','r','scene','cld','JP','原文',false),(4,'d','r','scene','cld','JP','原文',false),
 (5,'e','r','scene','cld','JP','原文',false),(6,'f','r','scene','cld','JP','原文',false)),
 speakers(code,name_zh) AS (VALUES ('cld','克劳德')),
 line_tts_versions(id,stem,status,review_state,parent_tts_id,subtitle_text,audio_path,voice_gpu_key,conversion_meta) AS (VALUES
 (1,'a','ready','locked',NULL::int,'锁定稿','a.wav','generated','{}'::jsonb),
 (100,'a','ready','candidate',NULL,'较新改稿','new.wav','generated','{}'),
 (9,'b','ready','candidate',NULL,'要读的改稿','b.wav','generated','{}'),
 (1000,'b','ready','candidate',9,NULL,'b-new.wav','generated','{}'),
 (10,'c','ready','candidate',NULL,NULL,'old.wav','generated','{}'),
 (1001,'c','ready','candidate',10,'原文','latest.wav','generated','{}'),
 (1002,'c','ready','candidate',NULL,'日文不应入选','jp.wav','jp-lock','{}'),
 (1003,'c','ready','candidate',NULL,'日文不应入选','jp.wav','audio-edit','{"pipeline":"jp-lock"}'),
 (1004,'c','failed','candidate',NULL,'失败不应入选','fail.wav','generated','{}'),
 (1005,'c','ready','candidate',NULL,'空音频不应入选','','generated','{}'),
 (1006,'c','ready','candidate',NULL,'空白不应入选','  ','generated','{}'),
 (20,'d','ready','candidate',NULL,NULL,'jp.wav','jp-lock','{}'),
 (21,'e','ready','locked',NULL,NULL,'jp.wav','jp-lock','{}'),
 (22,'f','ready','candidate',NULL,'  ','f.wav','generated','{}'))`;
function literal(x){if(Array.isArray(x))return 'ARRAY['+x.map(literal).join(',')+']';if(typeof x==='boolean')return x?'true':'false';if(typeof x==='number')return String(x);if(x==null)return 'NULL';return "'"+String(x).replaceAll("'","''")+"'";}
function route(original){
 const sql=async(parts,...values)=>{
  const query=parts.reduce((q,part,i)=>q+part+(i<values.length?literal(values[i]):''),'');
  const text=`${fixture} SELECT COALESCE(json_agg(row_to_json(result)), '[]') FROM (${query}) result`;
  const out=execFileSync('docker',['exec','-e','PGOPTIONS=-c default_transaction_read_only=on',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U',process.env.FF7_TEST_POSTGRES_ROLE||'postgres','-d',process.env.FF7_TEST_POSTGRES_DB||'postgres','-c',text],{encoding:'utf8'});return JSON.parse(out);
 };
 const subtitle=new Module(__filename);subtitle._compile(ts.transpileModule(fs.readFileSync(__dirname+'/tts-subtitle-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);
 const m=new Module(__filename);m.require=id=>({'@/lib/db':{sql},'@/lib/game-profile':{gameProfile:()=>({sourceOriginalChineseAudio:original})},'@/lib/tts-subtitle-display':subtitle.exports,'next/server':{NextResponse:{json:body=>body}}})[id]||require(id);
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/../app/api/lines/[stem]/sequence/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return m.exports.GET;
}
test('sequence route uses locked > modified > newest Chinese with numeric IDs and excludes JP/failed/empty candidates (read-only PostgreSQL)',{skip:!container},async()=>{
 const {items}=await route(false)(null,{params:Promise.resolve({stem:'c'})});assert.equal(items.length,6);
 assert.deepEqual(items.map(x=>[x.stem,x.lockedTtsId,x.playbackTtsId,x.modifiedSubtitle]),[
  ['a','1','1','锁定稿'],['b',null,'9','要读的改稿'],['c',null,'1001',null],['d',null,null,null],['e','21','21',null],['f',null,'22',null]
 ]);
});
test('Rebirth sequence keeps original Chinese fallback and existing subtitle selection (read-only PostgreSQL)',{skip:!container},async()=>{
 const {items}=await route(true)(null,{params:Promise.resolve({stem:'c'})});assert.equal(items[0].playbackTtsId,'1');assert.equal(items[1].playbackTtsId,null);assert.equal(items[1].modifiedSubtitle,'要读的改稿');
});
