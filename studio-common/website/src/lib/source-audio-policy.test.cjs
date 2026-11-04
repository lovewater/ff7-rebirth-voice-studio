/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
function load(file,mocks={}){const m=new Module(__filename);m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:id==='@/lib/line-processing-state'?load('line-processing-state.ts'):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,__filename);return m.exports;}
const policy=load('source-audio-policy.ts'),profile=load('game-profile.ts');
test('Remake has official Chinese text but no original Chinese audio capability; Rebirth retains it',()=>{assert.equal(profile.gameProfile({FF7_GAME_ID:'remake'}).sourceOriginalChineseAudio,false);assert.equal(profile.gameProfile({}).sourceOriginalChineseAudio,true);assert.equal(profile.projectReadiness(100,{FF7_GAME_ID:'remake'}).sourceOriginalChineseAudio,false);});
test('JP-only sequence never invents a CN URL or silently labels JP as Chinese',()=>{assert.equal(policy.sourceAudioUrl('a','cn',null,false),null);assert.equal(policy.sourceAudioUrl('a','jp',null,false),'/api/audio/jp/a');assert.equal(policy.sourceAudioUrl('a','cn','7',false),'/api/lines/a/tts/7/audio');assert.equal(policy.sourceAudioUrl('a','cn',null,true),'/api/audio/cn/a');});
function renderPlay(original,modified,extraProps={}){const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');const timing=load('timing.ts');const Empty=()=>null;const mocks={'@/app/project-audio':{useOriginalChineseAudio:()=>original},'next/dynamic':{default:()=>Empty},'@/components/audio-play-button':{AudioPlayButton:props=>React.createElement('a',{href:props.src},'play')},'@/lib/tts-play-count':{},'@/components/tts-review-action':{TtsReviewAction:Empty},'@/lib/tts-lock-client':{},'@/lib/timing':timing,'./tts-snapshot':{useTtsSnapshot:()=>undefined,isLockedFlag:()=>false},'./beat-count':{BeatRatio:Empty,beatHealth:x=>x,useBeats:()=>({current:null})},'./net-ratio':{NetRatio:Empty}};mocks['next/dynamic']=()=>Empty;const {PlayCell}=load('../app/lines/play-cell.tsx',mocks),nullTime={start:null,end:null,dur:null,speech:null};return renderToStaticMarkup(React.createElement(PlayCell,{stem:'jp-only',jp:{start:0,end:1,dur:1,speech:1},cn:nullTime,modified,lockReplacesEdit:true,...extraProps}));}
test('actual playback component keeps JP playback and lock without a missing-original-CN placeholder or CN controls',()=>{const html=renderPlay(false,null);assert.match(html,/api\/audio\/jp\/jp-only/);assert.match(html,/锁日文原声/);assert.doesNotMatch(html,/无原中文配音|未生成/);assert.doesNotMatch(html,/api\/audio\/cn|锁原中文/);assert.doesNotMatch(html,/编辑/);});
test('actual playback component keeps a generated candidate accessible without any original CN',()=>{const html=renderPlay(false,{id:'22',reviewState:'candidate',timing:{start:0,end:1,dur:1,speech:1}});assert.match(html,/api\/lines\/jp-only\/tts\/22\/audio/);assert.doesNotMatch(html,/api\/audio\/cn/);});
test('legacy Rebirth playback still renders original Chinese audio',()=>{assert.match(renderPlay(true,null),/api\/audio\/cn\/jp-only/);});

test('multi-channel previews and missing JP cannot be generation references; EN provenance does not disqualify JP',()=>{
 const {audioReferenceIssue}=policy;
 for(const value of [{eligible_for_generation:false},{preview_only:true},{channels:6},{missing_jp:true}])assert.match(audioReferenceIssue({audio_extraction:value}),/仅供试听|缺少日文/);
 for(const value of [null,{}, {slice_start_s:1},{audio_extraction:{channels:1,eligible_for_generation:true}}])assert.equal(audioReferenceIssue(value),null);
 assert.equal(audioReferenceIssue({audio_extraction:{channels:1},audio_sources:{en:{clip:{channels:6}}}}),null);
 assert.match(audioReferenceIssue({audio_sources:{en:{clip:{channels:6,eligible_for_generation:false}}}},'en'),/仅供试听/);
});
test('real clone route refuses preview before request parsing, budgets, writes or inference',async()=>{
 let queries=0,parsed=false;const sql=async parts=>{queries++;assert.match(parts.join(''),/m\.extra/);return[{stem:'mixed',speaker:null,extra:{audio_extraction:{channels:6,preview_only:true,eligible_for_generation:false}}}];};
 const file='../app/api/lines/[stem]/tts/clone/route.ts',m=new Module(__filename);
 m.require=id=>id==='@/lib/line-processing-state'?load('line-processing-state.ts'):id==='@/lib/source-audio-policy'?policy:id==='@/lib/db'?{sql}:id==='next/server'?{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}}:id.startsWith('@/')?{}:require(id);
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,__filename);
 const result=await m.exports.POST({json:async()=>{parsed=true;throw Error('should not parse request');}},{params:Promise.resolve({stem:'mixed'})});
 assert.equal(result.status,409);assert.equal(result.body.code,'REFERENCE_PREVIEW_ONLY');assert.equal(queries,1);assert.equal(parsed,false);
});

test('Remake English pairing uses exact imported clip path including EN-only IDs; absent pairing never guesses same stem',()=>{
 const relative=policy.englishAudioRelativePath;
 assert.equal(relative('bank__clip0001',{english_pairing:{en_audio_path:'en/bank__clip0009.mp3'}},true),'en/bank__clip0009.mp3');
 assert.equal(relative('bank__clip0009__en',{english_pairing:{en_audio_path:'en/bank__clip0009.mp3'}},true),'en/bank__clip0009.mp3');
 for(const extra of [null,{}, {english_pairing:{en_audio_path:null}}, {audio_sources:{en:{clip:{audio_path:'en/guessed.mp3'}}}}])assert.equal(relative('bank__clip0001',extra,true),null);
 for(const value of ['../en/x.mp3','en/../jp/x.mp3','/en/x.mp3','en/../../secret','jp/x.mp3','en/nested/x.mp3','en/x.wav','en/x.mp3?x','en/x\\y.mp3'])assert.equal(relative('x',{english_pairing:{en_audio_path:value}},true),null,value);
 assert.equal(relative('legacy',null,false),'en/legacy.mp3');
 const files=load('source-audio-files.ts',{'./source-audio-policy':policy});
 assert.equal(files.sourceAudioFile('/audio','bank__clip0001','en',{english_pairing:{en_audio_path:'en/bank__clip0009.mp3'}},true),'/audio/en/bank__clip0009.mp3');
 assert.equal(files.sourceAudioFile('/audio','bank__clip0001','en',null,true),null);
});

test('real English audio route serves mapped EN clip, refuses null/missing/unsafe mapping, and keeps Rebirth stem behavior',async()=>{
 let extra,remake=true,queries=0,files=[];
 const sourceFiles=load('source-audio-files.ts',{'./source-audio-policy':policy});
 const mocks={'@/lib/db':{sql:async()=>{queries++;return extra===undefined?[]:[{extra}];}},'@/lib/game-profile':{gameProfile:()=>({id:remake?'remake':'rebirth'})},'@/lib/source-audio-files':sourceFiles,'@/lib/audio-file-response':{audioFileResponse:async(req,file)=>{files.push(file);return{status:200,file};}}};
 const route=load('../app/api/audio/en/[stem]/route.ts',mocks),ctx={params:Promise.resolve({stem:'jp__clip0001'})};
 for(const value of [undefined,null,{}, {english_pairing:{en_audio_path:null}},{english_pairing:{en_audio_path:'en/../jp/wrong.mp3'}}]){extra=value;assert.equal((await route.GET({},ctx)).status,404);}
 assert.equal(files.length,0);
 extra={english_pairing:{en_audio_path:'en/english__clip0014.mp3'}};
 const ok=await route.GET({},ctx);assert.equal(ok.status,200);assert.match(ok.file,/\/data\/en\/english__clip0014\.mp3$/);
 remake=false;const before=queries;assert.match((await route.GET({},ctx)).file,/\/data\/en\/jp__clip0001\.mp3$/);assert.equal(queries,before);
});

test('actual Remake playback shows an English button only for a confirmed pairing',()=>{
 const paired=renderPlay(false,null,{englishPaired:true});assert.match(paired,/api\/audio\/en\/jp-only/);assert.doesNotMatch(paired,/未配对英文/);
 const absent=renderPlay(false,null,{englishPaired:false});assert.doesNotMatch(absent,/api\/audio\/en/);assert.match(absent,/未配对英文音频/);
});

test('real English embedding routes reject unpaired sources before reading files, creating versions or contacting GPU',async()=>{
 const sourceFiles=load('source-audio-files.ts',{'./source-audio-policy':policy});
 for(const draft of [false,true]){
  let queries=0;
  const sql=async parts=>{queries++;const text=parts.join('');if(text.includes('SELECT id FROM voice_banks'))return[{id:1}];assert.match(text,/SELECT/);return[{stem:'jp__clip0001',extra:{audio_extraction:{channels:1,eligible_for_generation:true}},en_dur_s:1}];};
  const mocks={'@/lib/source-audio-policy':policy,'@/lib/source-audio-files':sourceFiles,'@/lib/db':{sql},'@/lib/game-profile':{gameProfile:()=>({id:'remake',sourceOriginalChineseAudio:false})},'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},'@/lib/tts-pronunciation-db':{},'@/lib/pronounce':{},'@/lib/tts-gpu':{gpuJson:()=>{throw Error('GPU must not be called');}}};
  const route=load('../app/api/voices/[speaker]/embed/'+(draft?'draft/':'')+'route.ts',mocks);
  const response=await route.POST({json:async()=>draft?{stems:['jp__clip0001'],texts:'试读正文'}:{sourceLang:'en'}},{params:Promise.resolve({speaker:'cloud'})});
  assert.equal(response.status,409);assert.match(response.body.error,/未配对英文/);assert.equal(queries,draft?1:2);
 }
});
