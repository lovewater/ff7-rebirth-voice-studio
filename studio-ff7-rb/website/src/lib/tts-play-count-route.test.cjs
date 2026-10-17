/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function endpoint(){let count=4,queries=0;const sql=async(strings,...params)=>{queries++;assert.match(strings.join('?'),/play_count = play_count \+ 1/);assert.match(strings.join('?'),/COALESCE\(heard_at, now\(\)\)/);if(params[0]!==123)return [];return [{id:'123',heard_at:'2026-10-01',play_count:++count}];};
const m=new Module(__filename);m.require=id=>id==='@/lib/db'?{sql}:id==='next/server'?{NextResponse:Response}:require(id);
m._compile(ts.transpileModule(readFileSync(`${__dirname}/../app/api/lines/[stem]/tts/[id]/heard/route.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
return {POST:m.exports.POST,queries:()=>queries};}
test('heard endpoint increments every report including previously heard audio and rejects invalid or missing records',async()=>{
const e=endpoint(),send=(id)=>e.POST(new Request('http://local',{method:'POST'}),{params:Promise.resolve({stem:'same',id})});
for(const expected of [5,6]){const r=await send('123');assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,heardAt:'2026-10-01',playCount:expected});}
assert.equal((await send('abc')).status,400);assert.equal(e.queries(),2);assert.equal((await send('999')).status,404);
});
