/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const calls=[];
let reply={audio_blocks:1,missing_text_blocks:1,kind:'onomatopoeia',matched_jp:'わあ～',matched_zh:'哇～',before_word:null,after_word:0,reason:'唯一缺文与唯一声音顺序对应'};
const m=new Module(__filename);m.require=id=>id==='./auto-run-llm'?{parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return{content:JSON.stringify(reply)}}}:id==='./speech-segmentation'?require('./speech-segmentation.ts'):require(id);
m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/missing-fragment.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {missingAudioBlocks,missingFragmentMessages,classifyMissingFragment,recoverMissingFragment}=m.exports;
function audio(length,spans){const samples=new Float32Array(length);for(const [a,b]of spans)samples.fill(.5,a,b);return{samples,sampleRate:1000};}
function scenario(position){
 if(position==='head')return{...audio(2500,[[50,680],[1050,2320]]),textJp:'わあ～ 食べていいか？',textZh:'哇～我可以吃吗？',words:[{text:'食べていいかー',start:1120,end:2320}],decision:{...reply}};
 if(position==='tail')return{...audio(2500,[[50,1000],[1400,2400]]),textJp:'食べていいか？ わあ～',textZh:'我可以吃吗？哇～',words:[{text:'食べていいかー',start:50,end:1000}],decision:{...reply,before_word:0,after_word:null}};
 return{...audio(3500,[[50,900],[1250,1900],[2300,3400]]),textJp:'食べていいか？ わあ～ うまいな！',textZh:'我可以吃吗？哇～真好吃！',words:[{text:'食べていいかー',start:50,end:900},{text:'うまいな',start:2300,end:3400}],decision:{...reply,before_word:0,after_word:1}};
}
function recover(s){return recoverMissingFragment({...s,blocks:missingAudioBlocks(s)});}
for(const position of ['head','middle','tail'])test(`one missing reaction can be recovered at ${position}, keeping original punctuation and exact FX`,()=>{
 const s=scenario(position),blocks=missingAudioBlocks(s);assert.equal(blocks.length,1);
 const r=recover(s);assert.ok(r);assert.equal(r.fragment.text,'わあ～');assert.ok(r.boundaries.every(b=>b.reason!=='no-clear-valley'));
 assert.equal(r.subtitleClauses.length,s.words.length+1);
 assert.match(r.chineseBody,/我可以吃吗？/);
 const {subtitleRestorePlan,restorePerformanceSubtitle}=require('./auto-run-subtitle.ts');
 assert.equal(restorePerformanceSubtitle(subtitleRestorePlan(s.textZh,r.chineseBody),r.chineseBody).replace(/\n/g,''),s.textZh);
});
test('a model-identified internal reaction need not already be separated by subtitle punctuation',()=>{
 const s=scenario('middle');s.textJp='食べていいかわあ～うまいな';
 const r=recover(s);assert.ok(r);assert.equal(r.japaneseBody,'食べていいか\nうまいな');
});
test('silence and connected word gaps do not become unrecognized audio',()=>{
 const silence={...audio(2000,[[700,1400]]),words:[{text:'本文',start:700,end:1400}]};assert.deepEqual(missingAudioBlocks(silence),[]);
 const connected={...audio(1800,[[100,1700]]),words:[{text:'本',start:100,end:800},{text:'文',start:950,end:1700}]};assert.deepEqual(missingAudioBlocks(connected),[]);
 const dragged={...audio(2400,[[50,2300]]),words:[{text:'正文拖音',start:50,end:1700}]};assert.deepEqual(missingAudioBlocks(dragged),[]);
});
test('two independent audio omissions are never reduced to a single guess',()=>{
 const s={...scenario('head'),...audio(4000,[[50,600],[1000,2000],[2600,3500]]),words:[{text:'食べていいか',start:1000,end:2000}]};assert.equal(missingAudioBlocks(s).length,2);assert.equal(recover(s),null);
});
test('multiple missing text blocks, zero missing text, ordinary speech and uncertainty all fall back',()=>{
 const s=scenario('middle');
 for(const missing_text_blocks of [0,2,3])assert.equal(recover({...s,decision:{...s.decision,missing_text_blocks}}),null);
 for(const audio_blocks of [0,2,3])assert.equal(recover({...s,decision:{...s.decision,audio_blocks}}),null);
 for(const kind of ['speech','ambient','unknown'])assert.equal(recover({...s,decision:{...s.decision,kind}}),null);
});
test('オレ means ordinary first-person speech, not an omitted reaction, including ASR 俺 spelling',()=>{
 const s={...audio(2600,[[120,360],[900,2400]]),words:[{text:'俺',start:120,end:360},{text:'壊れたくない',start:920,end:2400}]};
 assert.deepEqual(missingAudioBlocks(s),[]);
 const messages=missingFragmentMessages('オレ 食われたくない！','我不想被吃掉啊！',{text:'俺、壊れたくない。',words:s.words},[]);
 assert.match(messages[0].content,/字幕オレ、ASR俺/);
});
test('model cannot invent or shorten subtitle, jump over words, or swap head and tail',()=>{
 const s=scenario('middle');
 for(const decision of [{...s.decision,matched_zh:'哦'},{...s.decision,matched_jp:'ああ'}, {...s.decision,after_word:null},{...s.decision,before_word:null},{...s.decision,after_word:2}])assert.equal(recover({...s,decision}),null);
});
test('no two-sided waveform valley means fallback even when model approves',()=>{
 const s=scenario('middle'),blocks=missingAudioBlocks(s);
 for(const [a,b] of [[900,1250],[1900,2300]]){const samples=s.samples.slice();samples.fill(.5,a,b);assert.equal(recoverMissingFragment({...s,samples,blocks}),null);}
});
test('prompt delegates semantic omission detection to model for any position and uses only one request',async()=>{
 const s=scenario('middle'),asr={text:'食べていいかーうまいな',words:s.words},blocks=missingAudioBlocks(s);
 const before=calls.length;await classifyMissingFragment(s.textJp,s.textZh,asr,blocks);assert.equal(calls.length,before+1);assert.equal(calls.at(-1)[2],'missing-fragment-classification');assert.equal(calls.at(-1)[3],1);
 const [system,user]=missingFragmentMessages(s.textJp,s.textZh,asr,blocks);assert.match(system.content,/句首、句中或句尾/);assert.match(system.content,/不要机械逐字比对/);assert.match(system.content,/没有听到音频/);assert.match(system.content,/不要把两块缺文合并/);assert.equal(JSON.parse(user.content).words.length,2);
 reply={...reply,missing_text_blocks:undefined};await assert.rejects(()=>classifyMissingFragment(s.textJp,s.textZh,asr,blocks),/格式/);
});

test('模型确认零缺文时，唯一独立声音可作为环境音，不被speech或unknown标签阻断',()=>{
 const {recoverCompleteTextAmbient}=m.exports;
 for(const position of ['head','middle','tail'])for(const kind of ['ambient','speech','unknown']){
  const s=scenario(position),blocks=missingAudioBlocks(s),decision={...s.decision,kind,missing_text_blocks:0,matched_jp:'',matched_zh:''};
  const r=recoverCompleteTextAmbient({...s,blocks,decision});assert.ok(r);
  assert.ok(s.words.every(w=>r.endMs<=w.start||r.startMs>=w.end));
  const {segmentPerformanceAudio}=require('./speech-segmentation.ts');
  const parts=segmentPerformanceAudio({...s,speech:[],onomatopoeia:[],ambient:[r]});
  assert.ok(parts.some(x=>x.kind==='ambient'));assert.ok(parts.some(x=>x.kind==='speech'));assert.equal(parts.filter(x=>x.kind==='unknown').length,0);
 }
});
test('环境音补救必须零缺文、唯一块、可靠谷地，不吞漏字和连读正文',()=>{
 const {recoverCompleteTextAmbient}=m.exports,s=scenario('middle'),blocks=missingAudioBlocks(s),decision={...s.decision,kind:'ambient',missing_text_blocks:0,matched_jp:'',matched_zh:''};
 for(const d of [{...decision,missing_text_blocks:1},{...decision,audio_blocks:2},{...decision,matched_jp:'正文'},{...decision,kind:'onomatopoeia'}])assert.equal(recoverCompleteTextAmbient({...s,blocks,decision:d}),null);
 assert.equal(recoverCompleteTextAmbient({...s,blocks:[...blocks,...blocks],decision}),null);
 const samples=s.samples.slice();samples.fill(.5,900,1250);assert.equal(recoverCompleteTextAmbient({...s,samples,blocks,decision}),null);
});

test('句中环境音必须严格超过500ms且两侧各至少150ms真实静音，不能用180ms保护区充数',()=>{
 const {internalAmbientEvidence,recoverCompleteTextAmbient}=m.exports;
 function check(length,left=150,right=150){
  const start=1000+left,end=start+length,next=end+right;
  const s={...audio(next+1000,[[100,1000],[start,end],[next,next+900]]),words:[{text:'前文',start:100,end:1000},{text:'后文',start:next,end:next+900}]};
  const block={startMs:start+40,endMs:end-40},decision={audio_blocks:1,missing_text_blocks:0,kind:'ambient',matched_jp:'',matched_zh:''};
  return {e:internalAmbientEvidence(s,block),r:recoverCompleteTextAmbient({...s,blocks:[block],decision})};
 }
 assert.equal(check(500).e.pass,false);assert.equal(check(500).r,null);
 const good=check(510);assert.equal(good.e.pass,true);assert.equal(good.e.durationMs,510);assert.equal(good.e.leadingSilenceMs,150);assert.equal(good.e.trailingSilenceMs,150);assert.ok(good.r);
 for(const [left,right]of [[140,150],[150,140],[0,300],[300,0]]){const x=check(600,left,right);assert.equal(x.e.pass,false);assert.equal(x.r,null);}
});
test('640ms字轴间隙里的短呼吸归入正文，不生成环境音或未知声音片段',()=>{
 const {internalAmbientEvidence,recoverCompleteTextAmbient}=m.exports;
 const s={...audio(6500,[[100,4760],[4870,5290],[5400,6400]]),words:[{text:'ね',start:4440,end:4760},{text:'私',start:5400,end:5680}]};
 const block={startMs:4940,endMs:5220};
 const e=internalAmbientEvidence(s,block);
 assert.equal(e.gap.endMs-e.gap.startMs,640);assert.equal(e.durationMs,420);assert.equal(e.leadingSilenceMs,110);assert.equal(e.trailingSilenceMs,110);assert.equal(e.pass,false);
 assert.equal(recoverCompleteTextAmbient({...s,blocks:[block],decision:{audio_blocks:1,missing_text_blocks:0,kind:'ambient',matched_jp:'',matched_zh:''}}),null);
 const {segmentPerformanceAudio}=require('./speech-segmentation.ts');
 const segments=segmentPerformanceAudio({...s,speech:[e.gap],ambient:[],onomatopoeia:[]});
 assert.deepEqual(segments.filter(x=>x.kind==='ambient'||x.kind==='unknown'),[]);
 assert.ok(segments.some(x=>x.kind==='speech'&&x.startMs<=4870&&x.endMs>=5290));
});
