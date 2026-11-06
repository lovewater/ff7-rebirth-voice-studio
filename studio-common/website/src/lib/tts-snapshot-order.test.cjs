/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),{execFileSync}=require('node:child_process');
const filename=__dirname+'/../app/api/lines/tts-snapshot/route.ts';
async function snapshotQuery(){
 let choosingQuery;
 const sql=async(strings,...values)=>{const query=strings.join('?');if(query.includes('SELECT DISTINCT ON (stem)'))choosingQuery=query.replace('ANY(?)',"ANY(ARRAY['latest','marked','root'])");return [];};
 const m=new Module(filename);m.require=id=>id==='@/lib/db'?{sql}:id==='@/lib/line-filters'?{originalCnLockedExpr:()=>'',healthFlagExpr:()=>''}:id==='next/server'?{NextResponse:{json:x=>x}}:require(id);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
 await m.exports.GET({nextUrl:{searchParams:new URLSearchParams({stems:'latest,marked,root'})}});return choosingQuery;
}
const fixture=`WITH line_tts_versions AS (
 SELECT fixture.stem,fixture.id::bigint,fixture.review_state,fixture.parent_tts_id::bigint,
  'ready'::text AS status,NULL::text AS subtitle_text,'正文'::text AS tts_text,
  'audio-edit'::text AS voice_gpu_key,'{}'::jsonb AS conversion_meta,
  NULL::timestamptz AS heard_at,NULL::float AS start_s,NULL::float AS end_s,NULL::float AS dur_s,NULL::float AS speech_s
 FROM (VALUES
  ('latest',9964,'candidate',NULL),('latest',18628,'candidate',NULL),
  ('marked',9964,'locked',NULL),('marked',18628,'candidate',NULL),
  ('root',9964,'candidate',NULL),('root',18628,'candidate',9964)
 ) fixture(stem,id,review_state,parent_tts_id)
)`;
function execute(query){
 const output=execFileSync('docker',['exec','-e','PGOPTIONS=-c default_transaction_read_only=on',process.env.FF7_TEST_POSTGRES_CONTAINER,'psql','-X','-U',process.env.FF7_TEST_POSTGRES_ROLE||'postgres','-d',process.env.FF7_TEST_POSTGRES_DB||'postgres','-At','-v','ON_ERROR_STOP=1','-c',fixture+' SELECT row_to_json(result) FROM ('+query+') result'],{encoding:'utf8'});
 return Object.fromEntries(output.trim().split('\n').map(line=>{const row=JSON.parse(line);return[row.stem,row.id];}));
}
test('snapshot handler explicitly orders the numeric table column',async()=>{assert.match(await snapshotQuery(),/line_tts_versions\.id DESC/);});
test('live snapshot handler sorts numeric IDs across10000 while preserving human marks and root priority (read-only PostgreSQL fixture)',{skip:!process.env.FF7_TEST_POSTGRES_CONTAINER},async()=>{
 const query=await snapshotQuery();assert.ok(query);assert.match(query,/line_tts_versions\.id DESC/);
 assert.deepEqual(execute(query),{latest:'18628',marked:'9964',root:'9964'});
 // The exact prior query demonstrates the real PostgreSQL output-alias regression.
 assert.equal(execute(query.replace('line_tts_versions.id DESC','id DESC')).latest,'9964');
});
