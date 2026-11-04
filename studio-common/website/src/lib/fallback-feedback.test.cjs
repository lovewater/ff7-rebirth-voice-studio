/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runFallbackFeedback,fallbackRewriteMessages}=require('./fallback-feedback.ts');
test('feedback uses ASR Japanese, actual net time and advisory characters without enforcing suggested count',async()=>{
 const texts=[],prompts=[],errors=[];let n=0;
 const rounds=await runFallbackFeedback({original:'醒了！',initial:'醒了！',japaneseAsr:'目が覚めました。',target:{span:1.38,net:1.38},
 synthesize:async text=>{texts.push(text);return{value:++n,timing:{span:[.446,1.334,1.252][n-1],net:[.446,1.334,1.252][n-1]}};},
 rewrite:async p=>{prompts.push(p);return prompts.length===1?'你终于醒过来了！':'你终于醒过来了呀！';},onRewriteError:async e=>errors.push(e)});
 assert.equal(rounds.length,3);assert.deepEqual(texts,['醒了！','你终于醒过来了！','你终于醒过来了呀！']);assert.deepEqual(prompts.map(p=>p.suggestedCharacters),[6,7]);
 assert.equal(JSON.parse(prompts[0].messages[1].content).japaneseAsr,'目が覚めました。');assert.match(prompts[1].messages[1].content,/已接近/);assert.equal(errors.length,0);
});
test('rewrite failures reuse the last valid script and still produce three audio candidates',async()=>{
 const texts=[];let errors=0;await runFallbackFeedback({original:'醒了！',initial:'醒了！',japaneseAsr:'',target:{span:1.38,net:1.38},synthesize:async t=>{texts.push(t);return{value:t,timing:{span:.6,net:.6}};},rewrite:async()=>{throw Error('API故障');},onRewriteError:async()=>{errors++;}});
 assert.deepEqual(texts,['醒了！','醒了！','醒了！']);assert.equal(errors,2);
});
test('a failed middle synthesis retains the prior successful round for next feedback and best selection',async()=>{
 let errors=0;const out=await runFallbackFeedback({original:'醒了！',initial:'醒了！',japaneseAsr:'目が覚めました。',target:{span:1.38,net:1.38},synthesize:async(t,n)=>{if(n===2)throw Error('TTS暂时异常');return{value:n,timing:{span:.7,net:.7}};},rewrite:async()=> '已经醒了！',onRewriteError:async()=>{errors++;}});
 assert.deepEqual(out.map(r=>r.round),[1,3]);assert.equal(errors,1);
});
test('punctuation does not inflate estimated characters and long silence is excluded via net measurement',()=>{
 const prompt=fallbackRewriteMessages('醒了！','目が覚めました。',{span:3,net:1.4},[{round:1,text:'醒，了！',value:null,timing:{span:4,net:.7}}]);assert.equal(prompt.suggestedCharacters,4);
});
