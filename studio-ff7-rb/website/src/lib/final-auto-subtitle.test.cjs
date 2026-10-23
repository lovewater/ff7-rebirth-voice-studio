/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {finalizeAutoSubtitle:finalize}=require('./final-auto-subtitle.ts');
test('short two-line subtitle merges, retaining existing punctuation and adding comma only at an unpunctuated join',()=>{
 assert.equal(finalize('我，\n不要被吃啊！','我不想被吃掉啊！'),'我，不要被吃啊！');
 assert.equal(finalize('我\n不要被吃啊！','我不想被吃掉啊！'),'我不要被吃啊！');
 assert.equal(finalize('我\n，不要被吃啊！','我不想被吃掉啊！'),'我，不要被吃啊！');
});
test('13 characters including punctuation merge, 14 characters do not; inserted comma is after threshold decision',()=>{
 const a='一二三四五六\n七八九十一二！',b='一二三四五六\n七八九十一二三！';
 assert.equal(finalize(a,'另一句台词'),'一二三四五六七八九十一二！');
 assert.equal(finalize(b,'另一句台词'),b);
});
test('final punctuation-insensitive comparison clears rewrite even when a long subtitle still occupies two lines',()=>{
 assert.equal(finalize('我，\n不要被吃啊！','我不要被吃啊！'),null);
 assert.equal(finalize('我们现在必须赶在天黑之前\n找到回去的路！','我们现在必须赶在天黑之前，找到回去的路。'),null);
 assert.equal(finalize('这是“诱饵作战”！','这是诱饵作战！'),null);
});
test('actual wording changes and restored repeated reactions cannot disappear as formatting-only edits',()=>{
 assert.equal(finalize('哦，诱饵吗！','哦哦，诱饵吗！'),'哦，诱饵吗！');
 assert.equal(finalize('我，\n不要被吃啊！','我不想被吃掉啊！'),'我，不要被吃啊！');
});
test('existing long two-line drafts remove only commas and full stops at the surviving line break',()=>{
 const first='在过去的训练数据中',second='确认到了相应的序号。难道说，你是塔……';
 for(const mark of ['，',',','。','．','.']){
  assert.equal(finalize(`${first}${mark}\n${second}`,'原字幕'),`${first}\n${second}`);
 }
 for(const mark of ['！','？','；','：','……','...','”']){
  const draft=`${first}${mark}\n${second}`;
  assert.equal(finalize(draft,'原字幕'),draft);
 }
 assert.equal(finalize(`${first}，\n${second}`,`${first}${second}`),null);
});

const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function finishHarness({draft,original,quote=false,preserve=false}){
 const state={subtitle:draft,tts:'我，\n不要被吃啊！',spoken:'我，不要被吃啊！'},writes=[],events=[];
 const sql=async(parts,...values)=>{
  const query=parts.join('?');
  if(query.includes('AS japanese'))return[{japanese:quote?'『誘餌』':'',chinese:state.subtitle}];
  if(query.includes('SELECT stem FROM line_auto_runs'))return[{stem:'test'}];
  if(query.includes('AS original_subtitle'))return[{id:'main',review_state:'candidate',subtitle_text:state.subtitle,original_subtitle:original}];
  if(query.includes('UPDATE line_tts_versions v SET subtitle_text')||query.includes('UPDATE line_tts_versions SET subtitle_text')){
   writes.push({query,values});state.subtitle=values[0];return[{id:'main'}];
  }
  if(query.includes('INSERT INTO line_auto_run_events'))events.push({query,values});
  return[];
 };sql.json=x=>x;sql.begin=fn=>fn(sql);
 const m=new Module(__filename);m.require=id=>id==='./auto-run-model-policy'?{captureAutoRunOutcome:()=>false}:id==='./db'?{sql}:id==='./final-auto-subtitle'?{finalizeAutoSubtitle:finalize}:id==='./llm-metrics'?{llmMetricsForRun:()=>({tokens:null,speed:null})}:id==='./subtitle-quotes'?{needsSubtitleQuotes:()=>quote,addSubtitleQuotes:async()=>`“${draft}”`}:{};
 m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/auto-run.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+'\nexports.finish=finish;',`${__dirname}/auto-run.ts`);
 return{state,writes,events,run:()=>m.exports.finish('run','passed',null,'main',{preserveSubtitle:preserve})};
}
test('actual workflow restores original subtitle after quotation-only edits while leaving TTS untouched',async()=>{
 const s=finishHarness({draft:'这是诱饵！',original:'这是诱饵。',quote:true});await s.run();
 assert.equal(s.writes.length,2);assert.equal(s.state.subtitle,null);
 assert.ok(s.events.some(e=>e.query.includes("'subtitle-finalize'")));
 assert.ok(!s.events.some(e=>e.query.includes("'subtitle'")));
 assert.equal(s.state.tts,'我，\n不要被吃啊！');assert.equal(s.state.spoken,'我，不要被吃啊！');
 for(const w of s.writes){assert.doesNotMatch(w.query,/SET\s+(tts_text|spoken_text)/);assert.equal(w.values[1],'main');}
});
test('actual workflow finalizes only selected subtitle and preserves real wording changes',async()=>{
 const s=finishHarness({draft:'我，\n不要被吃啊！',original:'我不想被吃掉啊！'});await s.run();
 assert.equal(s.state.subtitle,'我，不要被吃啊！');assert.equal(s.writes.length,1);assert.equal(s.writes[0].values[1],'main');
 assert.ok(s.events.some(e=>e.query.includes("'subtitle'")));
});
test('direct-original route explicitly preserving subtitles skips final rewrite cleanup',async()=>{
 const s=finishHarness({draft:'我，\n不要被吃啊！',original:'我不要被吃啊！',preserve:true});await s.run();
 assert.equal(s.writes.length,0);assert.equal(s.state.subtitle,'我，\n不要被吃啊！');
});
test('workflow cleans an existing line-break comma only in the selected final subtitle',async()=>{
 const s=finishHarness({draft:'在过去的训练数据中，\n确认到了相应的序号。难道说，你是塔……',original:'原字幕'});
 await s.run();
 assert.equal(s.state.subtitle,'在过去的训练数据中\n确认到了相应的序号。难道说，你是塔……');
 assert.equal(s.writes.length,1);
 assert.equal(s.state.tts,'我，\n不要被吃啊！');
 assert.equal(s.state.spoken,'我，不要被吃啊！');
});


test('new semantic layout cannot override original subtitle when the words match',()=>{
 const original='就算是伙伴\n我们塔克斯，有时也必须无情地舍弃',reflowed='就算是伙伴，我们塔克斯\n有时也必须无情地舍弃';
 assert.equal(finalize(reflowed,original),null);
 assert.equal(finalize(original,original),null);
 assert.equal(finalize(reflowed,original),null);
});

test('lock dialog cleans both line ends and internal full stops while preserving ellipses and decimal numbers',()=>{
 const {normalizeLockSubtitlePunctuation:clean}=require('./final-auto-subtitle.ts');
 assert.equal(clean('就算是伙伴。我们塔克斯，\n有时。也必须无情地舍弃。'),'就算是伙伴，我们塔克斯\n有时，也必须无情地舍弃');
 assert.equal(clean('真的吗？\n等一下……'),'真的吗？\n等一下……');
 assert.equal(clean('等等...\n数值是1.25。'),'等等...\n数值是1.25');
 assert.equal(clean('第一句.接着说,\n最后一句.'),'第一句，接着说\n最后一句');
});


test('piano line inherits original subtitle for punctuation-only rewrites',()=>{
 const original='比小时候弹得好多了';
 for(const draft of ['比小时候弹得，好多了','比小时候弹得\n好多了','“比小时候弹得好多了！”','比小时候弹得, 好多了。'])assert.equal(finalize(draft,original),null);
 assert.equal(finalize('比小时候弹得，更好了',original),'比小时候弹得，更好了');
 assert.equal(finalize('比小时候弹的好多了',original),'比小时候弹的好多了');
});
test('actual finish drops the punctuation-only piano override without changing synthesis text',async()=>{
 const s=finishHarness({draft:'比小时候弹得，好多了',original:'比小时候弹得好多了'});await s.run();
 assert.equal(s.state.subtitle,null);assert.equal(s.writes.length,1);
 assert.equal(s.state.tts,'我，\n不要被吃啊！');assert.equal(s.state.spoken,'我，不要被吃啊！');
});
