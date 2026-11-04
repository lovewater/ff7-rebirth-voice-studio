/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const Module=require('node:module');
const ts=require('typescript');
const mod=new Module(__filename);
mod.require=id=>require(id+'.ts');
mod._compile(ts.transpileModule(readFileSync(`${__dirname}/tts-subtitle-display.ts`,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,`${__dirname}/tts-subtitle-display.ts`);
const {ttsSubtitleDisplay}=mod.exports;
test('identical stored subtitle does not show rewrite even when TTS text contains a period',()=>{
  const subtitle='不过我可以强烈地感受到它\n强大的能量！';
  assert.equal(ttsSubtitleDisplay({subtitle,original:subtitle,spoken:'不过我可以强烈地感受到它。强大的能量！'}),null);
});
test('layout-only changes are visible even when all characters and punctuation are unchanged',()=>{
  assert.equal(ttsSubtitleDisplay({subtitle:'前面有敌人\n大家小心！',original:'前面有敌人大家小心！',spoken:'前面有敌人大家小心！'}),'前面有敌人\n大家小心！');
});
test('stored subtitle takes priority over a different spoken script',()=>{
  assert.equal(ttsSubtitleDisplay({subtitle:'哦哦，诱饵吗！',original:'哦哦，诱饵吗！',spoken:'诱饵吗！'}),null);
  assert.equal(ttsSubtitleDisplay({subtitle:'修订字幕\n保持两行！',original:'旧字幕',spoken:'朗读稿不用于字幕'}),'修订字幕\n保持两行！');
});
test('NULL subtitle always inherits original even for old records with different TTS wording',()=>{
  assert.equal(ttsSubtitleDisplay({subtitle:null,original:'旧字幕',spoken:'不过我可以强烈地感受到它。强大的能量！'}),null);
});
test('identical or empty original and output do not fabricate a modification',()=>{
  assert.equal(ttsSubtitleDisplay({subtitle:'原文\n第二行！',original:'原文\\n第二行！',spoken:'原文\n第二行！'}),null);
  assert.equal(ttsSubtitleDisplay({subtitle:' ',original:null,spoken:null}),null);
});

test('1100_0600 fallback punctuation and 0800 removed reference laughter never fabricate a subtitle rewrite',()=>{
 for(const [original,spoken]of [['啊啊，大哥\n这这这这下真的完了～！','啊啊，大哥。这这这这下真的完了～！'],['嘿嘿，怎么样\n不知道在谁手上了吧！','怎么样。不知道在谁手上了吧！']])assert.equal(ttsSubtitleDisplay({subtitle:null,original,spoken}),null);
 assert.equal(ttsSubtitleDisplay({subtitle:'真正改过的字幕',original:'原字幕'}),'真正改过的字幕');
});

test('0800 final effective caption inherits complete original laughter; body-only child retains its own explicit subtitle',()=>{
 const {effectiveTtsSubtitle}=mod.exports;
 const original='嘿嘿，怎么样\n不知道在谁手上了吧！';
 assert.equal(effectiveTtsSubtitle({subtitle:null,original}),original);
 assert.equal(effectiveTtsSubtitle({subtitle:'怎么样\n不知道在谁手上了吧！',original}),'怎么样\n不知道在谁手上了吧！');
 assert.equal(effectiveTtsSubtitle({subtitle:'真正改过的字幕',original}),'真正改过的字幕');
 assert.equal(effectiveTtsSubtitle({subtitle:null,original:null}),'');
});
