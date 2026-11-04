const {test}=require('node:test'),assert=require('node:assert/strict');
const {alignmentDetectionSignal:detect}=require('./alignment-transients.ts');
function wave(sr=1000, amplitude=.08, activeMs=20, beforeMs=50, afterMs=50){
 const first=Math.round(beforeMs*sr/1000),n=Math.round(activeMs*sr/1000),body=first+n+Math.round(afterMs*sr/1000);
 const x=new Float32Array(body+Math.round(.2*sr));x.fill(amplitude,first,first+n);x.fill(1,body);
 return {x,first,n,body,sr};
}
for(const sr of [1000,22050,44100,48000])test(`${sr}Hz：满足边界的微弱凸起仅在检测副本忽略，原PCM不变`,()=>{
 // duration is rounded down to stay within 20ms at every rate.
 const w=wave(sr,.1,Math.floor(.02*sr)/sr*1000,60,60),before=w.x.slice(),r=detect(w.x,sr);
 assert.equal(r.ignored.length,1);assert.ok(r.samples.subarray(w.first,w.first+w.n).every(x=>x===0));
 assert.deepEqual(w.x,before);assert.equal(r.peak,1);assert.deepEqual(r.samples.subarray(w.body),w.x.subarray(w.body));
});
for(const [label,args] of [['超过10%',[1000,.101]],['超过20ms',[1000,.08,21]],['前静音不足50ms',[1000,.08,20,49]],['后静音不足50ms',[1000,.08,20,50,49]]])test(`${label}保留`,()=>{
 const w=wave(...args),r=detect(w.x,w.sr);assert.equal(r.ignored.length,0);assert.equal(r.samples,w.x);
});
test('恰好50ms两侧静音与20ms累计越线可忽略；5%以内仍是静音',()=>{
 const w=wave(1000,.08,20);w.x.fill(.04,0,w.first);w.x.fill(.04,w.first+w.n,w.body);
 assert.equal(detect(w.x,w.sr).ignored.length,1);
});
test('#68172形态：50ms跨度中仅零星越线，总越线不足20ms',()=>{
 const w=wave(1000,0,60,90,300);for(const i of [90,100,120,139])w.x[i]=.062;
 const r=detect(w.x,w.sr);assert.deepEqual(r.ignored,[{start:90,end:140,activeSamples:4}]);
});
test('不足50ms间隔的小尖峰合并检查，不能拆开误删连续轻声',()=>{
 const w=wave(1000,0,100,100,100);for(let at=100;at<180;at+=20)w.x.fill(.08,at,at+6);
 assert.equal(detect(w.x,w.sr).ignored.length,0);
});
test('尾部对称处理，片头片尾没有足够实际静音时保护声音',()=>{
 const x=new Float32Array(500);x.fill(1,60,200);x.fill(.08,300,310);
 assert.deepEqual(detect(x,1000).ignored,[{start:300,end:310,activeSamples:10}]);
 x[499]=.08;assert.equal(detect(x,1000).samples[499],x[499]);
 const head=new Float32Array(500);head.fill(.08,0,10);head.fill(1,100,300);assert.equal(detect(head,1000).ignored.length,0);
});
test('固定原峰值且无效采样率/非有限采样/静音不伪造发声',()=>{
 assert.equal(detect(new Float32Array(500),1000).ignored.length,0);
 assert.equal(detect(Float32Array.of(NaN),1000).peak,0);
 const w=wave();for(const sr of [0,NaN,Infinity])assert.equal(detect(w.x,sr).samples,w.x);
});
