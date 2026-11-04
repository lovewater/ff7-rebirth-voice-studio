/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {reportTtsPlayback,ttsPlaybackIdentity}=require('./tts-play-count.ts');
test('each playback request reports once, including repeated clicks and failed responses, without retries',async()=>{
 const original=global.fetch,calls=[];
 try{
  global.fetch=async(url,init)=>{calls.push({url,...init});return {ok:calls.length!==2};};
  assert.equal(await reportTtsPlayback('same',123),true);
  assert.equal(await reportTtsPlayback('same',123),false);
  assert.equal(await reportTtsPlayback('same',123),true);
  assert.equal(calls.length,3);for(const call of calls){assert.equal(call.method,'POST');assert.equal(call.keepalive,true);}
  global.fetch=async()=>{calls.push({});throw Error('network');};
  assert.equal(await reportTtsPlayback('same',123),false);assert.equal(calls.length,4);
 }finally{global.fetch=original;}
});
test('only generated audio URLs identify a countable record; original Japanese reference is excluded',()=>{
 assert.deepEqual(ttsPlaybackIdentity('/api/lines/a/tts/123/audio'),{stem:'a',id:'123'});
 assert.deepEqual(ttsPlaybackIdentity('http://host/api/lines/a/tts/123/audio?x=1'),{stem:'a',id:'123'});
 for(const url of ['/api/lines/a/tts/123/audio?kind=reference','/api/audio/jp/a','/data/cn/a.mp3','not audio'])assert.equal(ttsPlaybackIdentity(url),null);
});
