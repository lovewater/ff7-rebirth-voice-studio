/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const defs=require('./prompt-seed.test.json');
const {renderPrompt,latestEnabledPrompts}=require('./prompt-template.ts');
function load(name,overrides={}){const m=new Module(__filename);m.require=id=>overrides[id]??(id.startsWith('./')?load(id.slice(2),overrides):require(id));m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${name}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,`${__dirname}/${name}.ts`);return m.exports;}
test('latest enabled version wins per key, disabled newer versions do not shadow it, and ties use id',()=>{
 const p=(id,key,enable,day)=>({id,key,enable,updated_at:`2026-10-${day}T00:00:00Z`});
 const map=latestEnabledPrompts([p('1','a',true,'14'),p('2','a',false,'16'),p('3','a',true,'15'),p('4','a',true,'15'),p('5','b',false,'16')]);assert.equal(map.get('a').id,'4');assert.equal(map.has('b'),false);
});
test('render substitutes once, preserves JSON and user braces, and rejects missing placeholders',()=>{
 assert.equal(renderPrompt('正文{{text}}；数{{n}}',{text:'{{n}}',n:3}),'正文{{n}}；数3');assert.equal(renderPrompt('{{data}}',{data:{a:'日文'}}),'{"a":"日文"}');assert.throws(()=>renderPrompt('{{missing}}',{}),/缺少占位符/);
});
test('all initial templates have documented placeholders with usable rendered examples',()=>{
 assert.equal(defs.length,32);assert.equal(new Set(defs.map(d=>d.key)).size,32);
 for(const d of defs){assert.ok(d.name&&d.desc&&d.prompt);const values=Object.fromEntries(d.placeholders.map(p=>{assert.ok(p.description);return[p.name,p.example];}));assert.equal(typeof renderPrompt(d.prompt,values),'string');assert.ok(!d.placeholders.some(p=>/^value_/.test(p.name)));}
});
const sample={speaker:'贝格',show:'交易成功',textJp:'どうだおまえら これがショーバイだ！',textEn:'An honest deal!',original:'怎么样啊，这才是做生意！',current:'怎么样啊，这才是做生意！',beats:{jp:{units:15},cn:{units:11.5}},before:[],after:[],previous:[],segmentationHint:'日文2段'};
function parity(messages){for(const m of messages){if(!m.promptKey)continue;const d=defs.find(d=>d.key===m.promptKey);assert.ok(d,m.promptKey);assert.equal(renderPrompt(d.prompt,m.promptValues),m.content,m.promptKey);}}
test('database templates reproduce current ordinary, short, slow and duration rewrite messages without changing their rules',()=>{
 const api=load('rewrite-prompt',{'./beats':require('./beats.ts')});
 const previous=[{raw:'{"text":"旧稿"}',units:11.5,spokenUnits:11.5}];
 for(const input of [{},{attempt:5},{shortLine:{min:3,max:5,target:4}},{slowLine:{jpMora:15,target:15,speechSeconds:6,moraPerSecond:2.5}},{slowLine:{jpMora:15,target:15,speechSeconds:6,moraPerSecond:2.5,max:20}},{durationLine:{target:13,currentCharacters:10,referenceSeconds:3.77,candidateSeconds:2.989}}])parity(api.rewriteMessages({...sample,previous,...input}));
});
test('database templates reproduce classification, review and fallback inputs, including exact JSON payloads',()=>{
 parity(load('spoken-text-review').spokenReviewMessages({spoken:'原稿',asr:'原稿',lexicon:[]}));
 parity(load('spoken-text-review').spokenReviewMessages({spoken:'魔晄',asr:'魔光',lexicon:[{src:'魔晄',dst:'魔光',note:'专名'}]}));
 const stub={'./auto-run-llm':{}};
 parity(load('missing-jp-subtitle',stub).missingJapaneseSubtitleMessages('唔嗝！','行こう。'));
 parity(load('missing-fragment',stub).missingFragmentMessages('わあ！台词','哇！台词',{text:'台词',words:[],utterances:[]},[{startMs:0,endMs:200}]));
 parity(load('fallback-feedback').fallbackRewriteMessages('醒了！','目が覚めました。',{span:1.38,net:1.38},[{round:1,text:'醒了！',timing:{span:.5,net:.5}}]).messages);
});
test('actual request resolver reads enabled DB text, strips binding metadata and fails explicitly when no active version exists',async()=>{
 let rows=defs.map((d,i)=>({...d,id:String(i+1),updated_at:new Date('2026-10-16')})),queries=[];
 const sql=async(parts,...params)=>{queries.push(parts.join('?'));const keys=params[0];return [...latestEnabledPrompts(rows.filter(r=>keys.includes(r.key))).values()];};
 const api=load('prompt-store',{'./db':{sql},'./prompt-template':require('./prompt-template.ts')});
 const original=load('spoken-text-review').spokenReviewMessages({spoken:'哼！',asr:'哼！',lexicon:[]});
 rows.push({...rows.find(r=>r.key==='text-review.system'),id:'999',prompt:'数据库新版本：{{lexicon}}',updated_at:new Date('2026-10-17')});
 const actual=await api.resolvePromptMessages(original);assert.equal(actual[0].content,'数据库新版本：（空）');assert.deepEqual(Object.keys(actual[0]).sort(),['content','role']);assert.match(queries[0],/enable = true/);assert.match(queries[0],/updated_at DESC, id DESC/);
 rows=rows.map(r=>({...r,enable:false}));await assert.rejects(api.resolvePromptMessages(original),/未配置启用版本/);
});

test('runtime-only classification, quote, layout and rhythm message bindings render identically before any model call',async()=>{
 const stop=new Error('capture-only'),captured=[];
 const llm={parseJsonObject:JSON.parse,rewriteChat:async messages=>{parity(messages);captured.push(...messages.map(m=>m.promptKey));throw stop;}};
 await assert.rejects(load('auto-run-onomatopoeia',{'./auto-run-llm':llm}).planOnomatopoeia({textJp:'ふん',textZh:'哼！',textEn:'Hmph!',durationMs:1000,jpAsr:{text:'ふん',words:[{text:'ふん',start:0,end:500}],utterances:[]},subtitleClauses:[{text:'ふん',startMs:0,endMs:500}]}),e=>e===stop);
 await assert.rejects(load('subtitle-quotes',{'./auto-run-llm':llm}).addSubtitleQuotes('『オトリ作戦』','诱饵作战'),e=>e===stop);
 await assert.rejects(load('auto-run-subtitle-format',{'./auto-run-llm':llm}).createAutoRunSubtitleFormatter()('这是一条没有标点而且长度超过十五个字必须按语义断行的字幕'),e=>e===stop);
 for(const key of ['onomatopoeia-plan.system','onomatopoeia-plan.input','subtitle-quotes.system','subtitle-quotes.input','subtitle-layout.system','subtitle-layout.input'])assert.ok(captured.includes(key));
});
