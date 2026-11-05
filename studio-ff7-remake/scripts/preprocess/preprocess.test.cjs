const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const policy=require('./policy.cjs'),{createClients}=require('./clients.cjs'),{createStore}=require('./store.cjs');
const {loadConfig,createPipeline,classificationMessages}=require('../preprocess-dialogue.cjs');
const {hash,parseAsr,parseIndependentTranslation,parseDecisions,lockDecision,contextFor}=policy;
const source={stem:'v1',speaker:'cloud',text_jp:null,text_en:'Hello',text_zh:null,translate_zh_jp:null,translate_zh_en:null,extra:{audio_extraction:{eligible_for_generation:true,channels:1}},dialogue_mode:'scene',dialogue_evidence:{events:[{event:'a'}]}};
const acoustic={decoded:true,channels:1,frames:16000,peak:.5,active_s:.5,exact_zero:false};
const decision={stem:'v1',kind:'onomatopoeia',speech_text_jp:'',speech_text_zh:'',speech_text_en:'',directly_reusable:true,reason:'非语言笑声可以复用'};
const emptyGlossary={revision:null,entries:[]};
function tagged(fn){const sql=(strings,...values)=>typeof strings==='string'?strings:fn(strings.join(''),values);sql.json=x=>x;sql.begin=fn=>fn(sql);sql.unsafe=async()=>{};return sql;}
function memoryStore(initial){let row=structuredClone(initial);const events=[],locks=[],completions=[];const store={line:async()=>structuredClone(row),event:async(stem,stage,input_hash,evidence)=>{const result={...evidence,input_hash,event_id:String(events.length+1)};events.push({stem,stage,result});return result;},saveAsr:async(job,snapshot,result,sha)=>{if(!row.text_jp?.trim())row.text_jp=result.text;return store.event(job.stem,'asr',sha,{...result,source_sha256:sha});},saveTranslation:async(job,snapshot,lang,translation,inputHash,output)=>{row['translate_zh_'+lang]=translation.text||null;return store.event(job.stem,'translate_'+lang,inputHash,{...translation,model:output.model});},complete:async(job,phase)=>completions.push(phase),lockOriginal:async(...args)=>{locks.push(args);return{state:'locked'};}};return{store,events,locks,completions,get:()=>row,set:x=>{row=x;}};}
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remake-preprocess-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'jp'));return dir;}
const modelResponse=(translation='你好')=>({content:JSON.stringify({translation}),logId:1,model:'local27b'});
const latestSql=()=>tagged(async()=>[{key:'translation.independent.system',role:'system',prompt:'根据单一源翻译，仅JSON'},{key:'translation.independent.input',role:'user',prompt:'{{sourceLanguage}} {{current}} {{before}} {{after}}'}]);
test('empty ASR is distinct from failed service and never accepts another language',()=>{
 assert.equal(parseAsr({success:true,results:[{text:'',language:'Japanese'}]}).state,'empty');
 for(const value of [{success:false,results:[]},{success:true,results:[]},{success:true,results:[{text:'hi',language:'English'}]},{results:[{text:'あ'}]}])assert.throws(()=>parseAsr(value));
});
test('strict translations allow an exact empty result only for blank ASR, never invented text or prose',()=>{
 assert.deepEqual(parseIndependentTranslation('{"translation":""}',''),{text:'',state:'untranslatable_empty'});
 for(const [json,src]of [['{"translation":"声音"}',''],['{"translation":""}','あ'],['```json\n{"translation":"好"}\n```','yes'],['{"translation":"好","reason":"x"}','yes']])assert.throws(()=>parseIndependentTranslation(json,src));
 assert.equal(parseIndependentTranslation('{"translation":"好"}','yes').text,'好');
});
test('context never crosses performance boundary and only includes same-language source',()=>{
 const row=(text,event='a')=>({text_jp:text,text_en:'EN'+text,text_zh:'secret',dialogue_mode:'scene',dialogue_evidence:{events:[{event}]}});
 const rows=[row('one','b'),row('two'),row('three'),row('four'),row('five','b')];
 assert.deepEqual(contextFor(rows,2,'jp'),{before:[{text:'two'}],after:[{text:'four'}]});
 assert.ok(!JSON.stringify(contextFor(rows,2,'jp')).includes('EN'));assert.ok(!JSON.stringify(contextFor(rows,2,'en')).includes('secret'));
});
test('Remake identity, real database role, and audio marker are mandatory; no Rebirth fallback',async t=>{
 const dir=await temp(t),env={FF7_GAME_ID:'remake',DATABASE_URL:'postgres://ff7remake@db/studio_ff7_remake',REMAKE_PREPROCESS_DATA_ROOT:dir};
 await fs.writeFile(path.join(dir,'.ff7-game.json'),JSON.stringify({game_id:'remake',database:'studio_ff7_remake'}));
 assert.equal(loadConfig(env).dataRoot,dir);
 for(const changed of [{FF7_GAME_ID:'rebirth'},{FF7_GAME_ID:undefined},{DATABASE_URL:'postgres://ff7rb@db/studio'},{DATABASE_URL:env.DATABASE_URL+'?user=ff7rb'}])assert.throws(()=>loadConfig({...env,...changed}));
 await fs.writeFile(path.join(dir,'.ff7-game.json'),JSON.stringify({game_id:'rebirth',database:'studio'}));assert.throws(()=>loadConfig(env));
});
test('classification is strict per stem and requires deletion-only original speech text',()=>{
 const items=[{stem:'v1',text_jp:'あはは',text_zh:'',text_en:''}];
 assert.equal(parseDecisions(JSON.stringify({decisions:[decision]}),items)[0].kind,'onomatopoeia');
 for(const changed of [{...decision,stem:'foreign'},{...decision,speech_text_jp:'架空正文'},{...decision,extra:true}])assert.throws(()=>parseDecisions(JSON.stringify({decisions:[changed]}),items));
 assert.throws(()=>parseDecisions(JSON.stringify({decisions:[decision,decision]}),items));
});
test('pure nonlexical audio may lock; empty ASR, semantic words, body, preview, multichannel, decoder failures cannot',()=>{
 const base={line:source,asr:{text:'あはは',state:'recognized'},acoustic,decision};assert.equal(lockDecision(base).allow,true);
 for(const patch of [{asr:{text:'',state:'empty'}},{asr:{text:'よっしゃ',state:'recognized'}},{decision:{...decision,speech_text_en:'Hello'}},{decision:{...decision,kind:'unknown'}},{line:{...source,extra:{audio_extraction:{preview_only:true}}}},{acoustic:{...acoustic,channels:6}},{acoustic:{decoded:false}},{acoustic:{...acoustic,peak:1e-15,active_s:0}}])assert.equal(lockDecision({...base,...patch}).allow,false,JSON.stringify(patch));
 assert.equal(lockDecision({...base,asr:{text:'',state:'empty'},acoustic:{...acoustic,peak:0,active_s:0,exact_zero:true}}).workflow,'remake-preprocess-silent-original');
});
test('four line pipeline checkpoints ASR before immediate JP translation; empty ASR translation terminates, resume skips successful stages',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'jp/v1.mp3'),'source');
 const m=memoryStore(source),order=[],job={stem:'v1',origin:{text_jp:null,original_japanese_subtitle_missing:true},checkpoints:{}};
 const clients={asr:async()=>{order.push('asr');return{text:'',state:'empty'};},chat:async({task,messages})=>{order.push(task);const text=messages.map(x=>x.content).join();assert.ok(!text.includes('secret'));return modelResponse(task.endsWith('jp')?'':'你好');}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},clients,store:m.store,rows:[source],glossary:emptyGlossary,reusePolicy:'policy',analyze:async()=>{order.push('acoustic');return{...acoustic,source_sha256:hash('source')};}});
 await pipeline.processLine(job);assert.deepEqual(order,['asr','independent-translation-jp','independent-translation-en','acoustic']);assert.equal(job.checkpoints.translate_jp.state,'untranslatable_empty');assert.equal(m.get().text_zh,null);
 order.length=0;await pipeline.processLine(job);assert.deepEqual(order,[]);assert.deepEqual(m.completions,['classify','classify']);
});
test('nonzero blank ASR cannot be auto-locked even when model falsely calls it pure onomatopoeia',async t=>{
 const dir=await temp(t),m=memoryStore({...source,text_jp:'',text_en:null});await fs.writeFile(path.join(dir,'jp/v1.mp3'),'source');const job={stem:'v1',origin:{original_japanese_subtitle_missing:true},checkpoints:{asr:{text:'',state:'empty',source_sha256:hash('source')},acoustic:{...acoustic,source_sha256:hash('source')}}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},store:m.store,clients:{chat:async()=>({content:JSON.stringify({decisions:[decision]}),model:'local27b',logId:1})},rows:[],glossary:emptyGlossary,reusePolicy:'policy'});
 await pipeline.classifyBatch([job]);assert.equal(m.locks.length,0);assert.equal(m.events.at(-1).result.reason,'empty-or-failed-asr');
});
test('classification result checkpoint survives restart without repeating model request',async t=>{
 const dir=await temp(t),line={...source,text_jp:'あはは',text_en:null},m=memoryStore(line);await fs.writeFile(path.join(dir,'jp/v1.mp3'),'source');const asr={text:'あはは',state:'recognized',source_sha256:hash('source')},a={...acoustic,source_sha256:hash('source')},item={stem:'v1',text_jp:'あはは',text_zh:'',text_en:'',original_japanese_subtitle_missing:true,asr_state:'recognized',acoustic:a,referential_translations:{from_japanese:null,from_english:null}};
 const job={stem:'v1',origin:{original_japanese_subtitle_missing:true},checkpoints:{asr,acoustic:a,classification:{input_hash:hash(item),decision,event_id:'1'}}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},store:m.store,clients:{chat:async()=>{throw Error('successful classification must not repeat');}},rows:[],glossary:emptyGlossary,reusePolicy:'policy'});
 await pipeline.classifyBatch([job]);assert.equal(m.locks.length,1);
});
test('actual clients always send Japanese ASR and only explicit local 27B with no-thinking; separate semaphores overlap and each cap4',async t=>{
 const dir=await temp(t),file=path.join(dir,'jp/v1.mp3');await fs.writeFile(file,'audio');let asrActive=0,llmActive=0,maxAsr=0,maxLlm=0,overlap=false;const calls=[];
 const sql=tagged(async()=>[{id:1}]);
 const clients=createClients({config:{asrUrl:'http://asr.local:8001/asr',llmUrl:'http://llm.local:8000/v1',llmModel:'qwen27b-local',timeoutMs:1000},sql,fetchImpl:async(url,opts)=>{const body=JSON.parse(opts.body);calls.push({url,body});const isAsr=url.includes('asr.local');if(isAsr){asrActive++;maxAsr=Math.max(maxAsr,asrActive);}else{llmActive++;maxLlm=Math.max(maxLlm,llmActive);}if(asrActive&&llmActive)overlap=true;await new Promise(r=>setTimeout(r,5));if(isAsr)asrActive--;else llmActive--;return{ok:true,status:200,json:async()=>({success:true,results:[{text:'あ',language:'Japanese'}]}),text:async()=>JSON.stringify({model:'qwen27b-local',choices:[{message:{content:'{"translation":"啊"}'},finish_reason:'stop'}]})};}});
 await Promise.all(Array.from({length:12},(_,i)=>clients.asr('v'+i,file)).concat(Array.from({length:12},()=>clients.chat({messages:[{role:'user',content:'x'}],task:'test'}))));
 assert.equal(maxAsr,4);assert.equal(maxLlm,4);assert.equal(overlap,true);
 for(const call of calls)if(call.url.includes('asr.local'))assert.equal(call.body.language,'Japanese');else{assert.equal(call.body.model,'qwen27b-local');assert.deepEqual(call.body.chat_template_kwargs,{enable_thinking:false});assert.ok(!call.url.includes('tts'));}
});
test('actual store ASR/translation mutations are CAS guarded and merge only their extra namespace',async()=>{
 const statements=[];const sql=tagged(async(text,values)=>{statements.push({text,values});if(text.includes('SELECT l.id'))return[source];if(text.includes('RETURNING id'))return[{id:1}];if(text.includes('UPDATE lines'))return[{stem:'v1'}];return[];});const store=createStore(sql);
 await store.saveAsr({stem:'v1',origin:{text_jp:null,text_en:'Hello'}},source,{text:'あ',state:'recognized'},'sha');
 await store.saveTranslation({stem:'v1'},source,'jp',{text:'啊',state:'translated'},'hash',{model:'local',logId:2});
 const updates=statements.filter(x=>x.text.includes('UPDATE lines'));assert.ok(updates.every(x=>x.text.includes('IS NOT DISTINCT FROM')&&x.text.includes('NULLIF(btrim')));assert.ok(updates.every(x=>!x.text.includes('text_zh=')));
 assert.ok(statements.filter(x=>x.text.includes('UPDATE line_meta')).every(x=>x.text.includes("'{remake_preprocess}'")&&x.text.includes("extra->'remake_preprocess'")));
});
test('actual original JP locking preserves any manual locked/abnormal selection and writes no replacement',async()=>{
 const queries=[];const sql=tagged(async(text)=>{queries.push(text);if(text.includes('SELECT l.id'))return[source];if(text.includes('SELECT id FROM line_tts_versions'))return[{id:123}];return[];});const store=createStore(sql);
 assert.deepEqual(await store.lockOriginal({stem:'v1'},source,Buffer.from('same'),'sha',{},{} ,'/unused'),{state:'kept_manual_selection',version_id:'123'});
 assert.ok(!queries.some(x=>x.includes('INSERT INTO line_tts_versions')));assert.ok(!queries.some(x=>/UPDATE line_tts_versions/.test(x)));
});
test('classification prompt cannot claim that the text model heard the audio',()=>{const text=classificationMessages([], 'shared reuse policy')[0].content;assert.match(text,/不能声称听到了音频/);assert.match(text,/ASR为空只能unknown/);assert.match(text,/shared reuse policy/);});

test('preview-only missing-subtitle audio still receives Japanese ASR and immediate independent translation',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'jp/v1.mp3'),'preview');const row={...source,text_en:null,extra:{audio_extraction:{channels:6,preview_only:true,eligible_for_generation:false}}},m=memoryStore(row),calls=[];
 const job={stem:'v1',origin:{text_jp:null,original_japanese_subtitle_missing:true},checkpoints:{}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},clients:{asr:async()=>{calls.push('asr');return{text:'あ',state:'recognized'};},chat:async()=>{calls.push('translate');return modelResponse('啊');}},store:m.store,rows:[row],glossary:emptyGlossary,analyze:async()=>({...acoustic,channels:6})});
 await pipeline.processLine(job);assert.deepEqual(calls,['asr','translate']);assert.equal(m.locks.length,0);assert.equal(m.get().translate_zh_jp,'啊');
});
test('missing JP waits for recovery and reloads; confirmed absence is audited without using EN as Japanese',async()=>{
 const row={...source,text_en:null,extra:{audio_extraction:{missing_jp:true,eligible_for_generation:false}}},m=memoryStore(row);let waited=0,asrCalls=0;m.store.waitSource=async()=>waited++;
 const job={stem:'v1',origin:{text_jp:null,original_japanese_subtitle_missing:true},checkpoints:{}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:'/unused'},clients:{asr:async()=>asrCalls++},store:m.store,rows:[row],glossary:emptyGlossary});
 await pipeline.processLine(job);assert.equal(waited,1);assert.equal(asrCalls,0);assert.equal(m.completions.length,0);
 m.set({...row,extra:{audio_extraction:{missing_jp:true,jp_source_absent:true},jp_source_absence:{audit:'verified-empty-cue'}}});await pipeline.processLine(job);assert.equal(asrCalls,0);assert.equal(m.events.at(-1).result.state,'confirmed_no_independent_jp_source_for_row');assert.deepEqual(m.completions,[null]);
});
test('long-source translation increases output budget and terminally checkpoints a maximum-budget truncation',async()=>{
 const long='これは実際の長い字幕です。'.repeat(400),row={...source,text_jp:long,text_en:null},m=memoryStore(row),budgets=[];
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:'/unused'},clients:{chat:async req=>{budgets.push(req.maxTokens);throw Error('llm-truncated');}},store:m.store,rows:[row],glossary:emptyGlossary});
 const job={stem:'v1',origin:{original_japanese_subtitle_missing:false},checkpoints:{},attempts:0};await pipeline.processLine(job);assert.deepEqual(budgets,[8192]);assert.equal(job.checkpoints.translate_jp.state,'needs_review_output_limit');assert.equal(m.get().translate_zh_jp,null);
 await pipeline.processLine(job);assert.deepEqual(budgets,[8192]);
});
test('manual review revision changes including lock-then-unlock block automatic original locking',async()=>{
 const statements=[],sql=tagged(async text=>{statements.push(text);if(text.includes('SELECT l.id'))return[source];if(text.includes('SELECT revision'))return[{revision:2}];return[];});
 const result=await createStore(sql).lockOriginal({stem:'v1',origin:{manual_review_revision:0}},source,Buffer.from('source'),'sha',{},{} ,'/unused');assert.equal(result.state,'kept_manual_review_change');assert.ok(!statements.some(x=>x.includes('INSERT INTO line_tts_versions')));
});

test('actual LLM client rejects any returned reasoning despite an explicit no-think request',async()=>{
 const sql=tagged(async()=>[{id:1}]);
 for(const response of [{model:'local',usage:{completion_tokens_details:{reasoning_tokens:1}},choices:[{message:{content:'{"translation":"好"}'}}]},{model:'local',choices:[{message:{content:'{"translation":"好"}',reasoning_content:'hidden thought'}}]}]){
  const clients=createClients({config:{asrUrl:'http://asr.local',llmUrl:'http://llm.local/v1',llmModel:'local',timeoutMs:1000},sql,fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(response)})});
  await assert.rejects(clients.chat({messages:[],task:'test'}),/llm-thinking-disabled-violation/);
 }
});

test('read-only Cut context fallback uses JP or missing-JP EN paths, preserves explicit evidence, and stops at area/event boundaries',()=>{
 const {contextualize}=policy;
 const row=(text,area='area',event='event',lang='jp')=>contextualize({text_jp:text,text_en:'EN'+text,dialogue_mode:'scene',dialogue_evidence:null,extra:{audio_extraction:{missing_jp:lang==='en'},audio_sources:{[lang]:{path:`End/Content/Sound/${lang}/Cut/${area}/${event}/${text}.uasset`}}}});
 const rows=[row('a'),row('b'),row('c'),row('d'),row('e','area','other')];
 assert.deepEqual(contextFor(rows,2,'jp'),{before:[{text:'a'},{text:'b'}],after:[{text:'d'}]});
 assert.deepEqual(contextFor([row('a','areaA','same'),row('b','areaB','same')],0,'jp'),{before:[],after:[]});
 assert.deepEqual(contextFor([row('a'),row('b','area','event','en')],1,'en'),{before:[{text:'ENa'}],after:[]});
 const explicit={events:[{event:'manual'}]},input={dialogue_evidence:explicit,extra:{audio_sources:{jp:{path:'/Cut/a/b/file'}}}};
 assert.equal(contextualize(input),input);assert.equal(contextualize(input).dialogue_evidence,explicit);
 assert.equal(contextualize({dialogue_evidence:null,extra:{audio_sources:{jp:{path:'/Field/chapter/file'}}}}).dialogue_evidence,null);
 const original={dialogue_evidence:null,extra:{audio_sources:{jp:{path:'/Cut/a/b/file'}}}};contextualize(original);assert.equal(original.dialogue_evidence,null);
});
test('real store line projection supplies Cut evidence without updating authoritative metadata',async()=>{
 const statements=[],raw={...source,dialogue_evidence:null,extra:{audio_sources:{jp:{path:'Game/Cut/mako1/scene1/voice.uasset'}}}};
 const sql=tagged(async text=>{statements.push(text);return[raw];});const value=await createStore(sql).line('v1');
 assert.deepEqual(value.dialogue_evidence,{voice_asset:'Game/Cut/mako1/scene1/voice.uasset'});assert.equal(raw.dialogue_evidence,null);assert.equal(statements.length,1);assert.match(statements[0],/m.extra/);assert.ok(!statements.some(x=>x.includes('UPDATE')));
});
const candidateSha=hash('candidate-bytes');
const candidateManifest={version:'jp-whole-cue-pairing-v1',scope:'jp-materials-present-in-other-rows-without-unique-subclip-pairing',proof:{game_resource_missing:false,whole_cue_name:'broadcast'},jp_candidate_stems:['jp1'],jp_candidate_paths:['jp/jp1.mp3'],jp_candidates:[{stem:'jp1',audio_path:'jp/jp1.mp3',mp3_sha256:candidateSha}]};
const candidateExtra={audio_extraction:{missing_jp:true,jp_pairing_unresolved:true},jp_pairing_unresolved:candidateManifest};
function readyCandidate(){return{stem:'jp1',text_jp:'放送です',translate_zh_jp:'这是广播',origin:{original_japanese_subtitle_missing:true,text_jp:null},checkpoints:{asr:{language:'Japanese',state:'recognized',text:'放送です',source_sha256:candidateSha,event_id:'1'},translate_jp:{state:'translated',input_hash:hash('放送です'),event_id:'2'}},extra:{audio_extraction:{missing_jp:false}}};}
test('unresolved JP pairing requires explicit proof and every audited JP candidate translation, not merely existing files or ASR queued',()=>{
 const {pairingManifest,japaneseCandidateState}=policy;
 assert.deepEqual(pairingManifest(candidateExtra).stems,['jp1']);
 for(const extra of [{}, {...candidateExtra,audio_extraction:{missing_jp:true}},{...candidateExtra,jp_pairing_unresolved:{...candidateManifest,proof:{game_resource_missing:true}}},{...candidateExtra,jp_pairing_unresolved:{...candidateManifest,jp_candidate_stems:[]}}])assert.equal(pairingManifest(extra),null);
 const good=readyCandidate();assert.equal(japaneseCandidateState(good,candidateSha).ready,true);
 for(const candidate of [{...good,checkpoints:{}},{...good,translate_zh_jp:null},{...good,text_jp:'人工新正文'},{...good,checkpoints:{...good.checkpoints,asr:{...good.checkpoints.asr,language:'English'}}},{...good,extra:{audio_extraction:{missing_jp:true}}}])assert.equal(japaneseCandidateState(candidate,candidateSha).ready,false);
 assert.equal(japaneseCandidateState(good,'different-sha').ready,false);
 const official={...good,origin:{original_japanese_subtitle_missing:false,text_jp:'放送です'},checkpoints:{}};assert.equal(japaneseCandidateState(official,candidateSha).route,'official-japanese-translated');
 const empty={...good,text_jp:' ',translate_zh_jp:null,checkpoints:{asr:{language:'Japanese',state:'empty',text:' ',source_sha256:candidateSha},translate_jp:{state:'untranslatable_empty',input_hash:hash(' ')}}};assert.equal(japaneseCandidateState(empty,candidateSha).route,'japanese-asr-empty-translation-audited');
});
test('real unresolved-pairing completion waits for all candidates then audits cross-row provenance without creating JP text/audio or locks',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'jp/jp1.mp3'),'candidate-bytes');const owner={...source,stem:'en-only',text_en:'Broadcast.',extra:candidateExtra};let candidate={...readyCandidate(),translate_zh_jp:null},queries=[];
 const sql=tagged(async(text)=>{queries.push(text);if(text.includes('SELECT l.stem,l.text_jp'))return[candidate];if(text.includes('SELECT extra FROM line_meta'))return[{extra:candidateExtra}];if(text.includes('SELECT l.id'))return[owner];if(text.includes('RETURNING id'))return[{id:1}];return[];});const store=createStore(sql),job={stem:'en-only'};
 assert.equal((await store.finishUnresolvedPairing(job,owner,dir)).completed,false);assert.ok(!queries.some(x=>x.includes('INSERT INTO remake_preprocess_events')));
 candidate=readyCandidate();queries=[];assert.equal((await store.finishUnresolvedPairing(job,owner,dir)).state,'jp-already-processed-in-other-rows-pairing-unresolved');
 assert.ok(queries.some(x=>x.includes('FOR SHARE')));assert.ok(queries.some(x=>x.includes("status='done'")));assert.ok(!queries.some(x=>/UPDATE lines|line_tts_versions/.test(x)));
});

test('real translation pipeline sends Japanese-only direct names and refuses wrong official spelling before any field write',async()=>{
 const names=require('./names.cjs'),glossary=names.compileNames({revision:'jp-test',entries:[{english:'Cloud',japanese:'クラウド',chinese:'克劳德',english_aliases:['Cloud'],matchable:true}]});
 const row={...source,text_jp:'クラウドさん、行きましょう。',text_en:null},m=memoryStore(row);let captured;
 const sql=tagged(async()=>[{key:'translation.independent.system',role:'system',prompt:'按当前源文翻译'},{key:'translation.independent.input',role:'user',prompt:'{{sourceLanguage}} {{current}}'},{key:'translation.name-glossary',role:'user',prompt:'{{name_glossary}}'}]);
 const pipeline=createPipeline({sql,config:{},clients:{chat:async req=>{captured=req;return modelResponse('克劳迪先生，走吧。');}},store:m.store,rows:[row],glossary});
 await assert.rejects(pipeline.translate({stem:'v1',checkpoints:{}},'jp'),{code:'translation-name-mismatch'});
 assert.ok(captured.messages.some(x=>x.content.includes('克劳德')&&x.content.includes('"matched_in_current_source":true')));assert.equal(m.get().translate_zh_jp,null);
});

test('name-review replacement CAS preserves the old visible translation when manual selection changes during model request',async()=>{
 const before={...source,text_jp:'クラウドは？',translate_zh_jp:'克劳迪？'},old={state:'translated',text:'克劳迪？'},queries=[];
 const sql=tagged(async(text)=>{queries.push(text);if(text.includes('SELECT l.id'))return[before];if(text.includes('SELECT revision'))return[{revision:1}];if(text.includes('SELECT id FROM line_tts_versions'))return[];if(text.includes('RETURNING id'))return[{id:1}];return[];});
 const result=await createStore(sql).saveTranslation({stem:'v1',checkpoints:{translate_jp:old}},before,'jp',{state:'translated',text:'克劳德？'},hash(before.text_jp),{model:'local27b',logId:2},{state:'pending',expected_old_text:'克劳迪？',manual_review_revision:'0'});
 assert.equal(result,old);assert.ok(!queries.some(x=>x.includes('UPDATE lines')));assert.ok(queries.some(x=>x.includes('INSERT INTO remake_preprocess_events')));
});

test('independent lexical safeguard refuses clear Japanese words even if a model deletes their bodies',()=>{
 for(const text of ['はい','ハイ','はいはい','いいえ','イイエ','いい','イイ','おい','オイ','はーい','おーい'])assert.equal(policy.compatibleVocalization(text),false,text);
 for(const text of ['あはは','ハハハ','ううん','ああ'])assert.equal(policy.compatibleVocalization(text),true,text);
});
test('every classification branch checks source SHA and terminally audits source changes without reusing ASR or touching text',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'jp/v1.mp3'),'changed-source');
 for(const kind of ['speech','unknown','onomatopoeia']){
  const m=memoryStore({...source,text_jp:'あはは'}),exceptions=[];m.store.sourceChanged=async(job,evidence)=>exceptions.push(evidence);
  const job={stem:'v1',origin:{original_japanese_subtitle_missing:true},checkpoints:{asr:{language:'Japanese',state:'recognized',text:'あはは',source_sha256:hash('original')},acoustic:{...acoustic,source_sha256:hash('original')},classification:{decision:{...decision,kind}}}};
  const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},store:m.store,clients:{chat:async()=>{throw Error('must not call model on stale ASR');}},rows:[],glossary:emptyGlossary,reusePolicy:'policy'});
  await pipeline.classifyBatch([job]);assert.equal(exceptions.length,1);assert.equal(m.locks.length,0);assert.equal(m.completions.length,0);assert.equal(m.get().text_jp,'あはは');
 }
});
test('a source change while the model is in flight is checked again before any normal done or lock',async t=>{
 const dir=await temp(t);await fs.writeFile(path.join(dir,'jp/v1.mp3'),'original');const m=memoryStore({...source,text_jp:'あはは',text_en:null}),exceptions=[];m.store.sourceChanged=async(job,evidence)=>exceptions.push(evidence);
 const job={stem:'v1',origin:{original_japanese_subtitle_missing:true},checkpoints:{asr:{language:'Japanese',state:'recognized',text:'あはは',source_sha256:hash('original')},acoustic:{...acoustic,source_sha256:hash('original')}}};
 const pipeline=createPipeline({sql:latestSql(),config:{dataRoot:dir},store:m.store,clients:{chat:async()=>{await fs.writeFile(path.join(dir,'jp/v1.mp3'),'changed');return{content:JSON.stringify({decisions:[decision]}),logId:1,model:'local27b'};}},rows:[],glossary:emptyGlossary,reusePolicy:'policy'});
 await pipeline.classifyBatch([job]);assert.equal(exceptions.length,1);assert.equal(m.completions.length,0);assert.equal(m.locks.length,0);
});
test('actual source-change exception store uses needs_review terminal status and preserves all original fields and historical checkpoints',async()=>{
 const statements=[],sql=tagged(async text=>{statements.push(text);return text.includes('RETURNING id')?[{id:1}]:[];});await createStore(sql).sourceChanged({stem:'v1'},{current_sha256:'changed',expected_asr_sha256:'original'});
 assert.ok(statements.some(x=>x.includes("status='needs_review'")));assert.ok(!statements.some(x=>/UPDATE lines|line_tts_versions|DELETE/.test(x)));
});

test('COMMIT communication failure preserves exclusively created audio even if a new SELECT would temporarily see no version',async t=>{
 const dir=await temp(t),bytes=Buffer.from('original-JP-bytes');await fs.writeFile(path.join(dir,'jp/v1.mp3'),bytes);
 let absentSelects=0;
 const sql=tagged(async text=>{
  if(text.includes('SELECT l.id'))return[source];
  if(text.includes('SELECT revision'))return[{revision:0}];
  if(text.includes('SELECT id FROM line_tts_versions')){if(text.includes('WHERE id='))absentSelects++;return[];}
  if(text.includes('INSERT INTO line_tts_versions'))return[{id:100}];
  if(text.includes('INSERT INTO remake_preprocess_events'))return[{id:200}];
  return[];
 });
 sql.begin=async fn=>{await fn(sql);const error=Error('COMMIT communication failed while server outcome is unknown');error.code='CONNECTION_CLOSED';throw error;};
 await assert.rejects(createStore(sql).lockOriginal({stem:'v1',origin:{manual_review_revision:0}},source,bytes,hash(bytes),{workflow:'test-jp-lock',reason:'test'}, {},dir),/COMMIT communication failed/);
 assert.deepEqual(await fs.readFile(path.join(dir,'tts/v1/100.mp3')),bytes);
 // No compensating read/delete: a nonvisible row still cannot establish rollback.
 assert.equal(absentSelects,0);
});

test('anonymous confirmed nonverbal original may lock without inventing speaker; empty or lexical evidence still refuses',()=>{
 const base={line:{...source,speaker:null},asr:{text:'あはは',state:'recognized'},acoustic,decision};
 assert.equal(lockDecision(base).allow,true);
 assert.equal(base.line.speaker,null);
 assert.equal(lockDecision({...base,decision:{...decision,kind:'speech',directly_reusable:false}}).allow,false);
 assert.equal(lockDecision({...base,asr:{text:'',state:'empty'}}).allow,false);
 assert.equal(lockDecision({...base,asr:{text:'どう',state:'recognized'}}).allow,false);
});
