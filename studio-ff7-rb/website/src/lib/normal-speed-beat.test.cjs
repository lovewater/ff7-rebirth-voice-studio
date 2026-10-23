/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalSpeedIgnoresBeat:ignore,measureNormalSpeedBeatExemption:measure}=require('./normal-speed-beat.ts');
function wave(parts,sr=1000){const samples=[];for(const [seconds,amplitude]of parts)for(let i=0;i<Math.round(seconds*sr);i++)samples.push(amplitude);return{samples:Float32Array.from(samples),sampleRate:sr};}
test('4.5至7.0含边界，超出和缺测量不能获得比值豁免',()=>{
 for(const r of [4.5,5,5.5,6,6.78280880957668,7])assert.equal(ignore(r),true);
 for(const r of [4.499999,7.000001,0,-1,null,undefined,NaN,Infinity])assert.equal(ignore(r),false);
});
test('只按正文净发声算速度，长静音和低于峰值15%的连续低能量均扣除',()=>{
 const r=measure(wave([[1,.8],[1,0],[1,.8],[.4,.05]]),'一二三四五六七八九十甲');
 assert.equal(r.netSeconds,2);assert.equal(r.silenceSeconds,1.4);assert.equal(r.rate,5.5);assert.equal(r.exempt,true);
 assert.equal(measure(wave([[2,.8],[10,0]]),'一二三四五六七八九十甲乙丙丁戊').exempt,false); // 7.5音节/秒，不能靠长空白稀释到正常
});
test('200ms含边界，短间隙和阈值相等的声音保留，纯静音不能算正常',()=>{
 assert.equal(measure(wave([[1,.8],[.2,0],[1,.8]]),'一二三四五六七八九十甲').netSeconds,2);
 assert.equal(measure(wave([[1,.8],[.199,0],[1,.8]]),'一二三四五六七八九十甲').netSeconds,2.199);
 const equal={samples:Float32Array.of(1,...new Array(1000).fill(.15)),sampleRate:1000};
 assert.equal(measure(equal,'一二三四五').silenceSeconds,0);
 assert.equal(measure(wave([[3,0]]),'一二三四五').rate,null);
 assert.equal(measure(wave([[3,0]]),'一二三四五').exempt,false);
});
test('只采用当前音频的测量，不给同一份文字或新稿永久豁免',()=>{
 const text='一二三四五六七八九十甲';
 assert.equal(measure(wave([[2,.8]]),text).exempt,true);
 assert.equal(measure(wave([[1,.8]]),text).exempt,false);
 assert.equal(measure(wave([[2,.8]]),'一二三').exempt,false);
});
