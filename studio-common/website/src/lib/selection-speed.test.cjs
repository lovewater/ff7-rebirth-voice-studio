const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const normal=require('./normal-speed-beat.ts'),m=new Module(__filename);m.require=()=>normal;m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/selection-speed.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {selectionSpeed:describe}=m.exports,base={beatBand:{low:.85,high:1.15}};
const states=[{rate:3,ratio:1.3},{rate:6,ratio:1},{rate:8,ratio:.7}];
const expected=[['速度有些过慢','速度有些稍慢','语速有点奇怪'],['速度有些稍慢','语速正常','速度有些稍快'],['语速有点奇怪','速度有些稍快','速度有些过快']];
for(let i=0;i<3;i++)for(let j=0;j<3;j++)test(`净语速方向${i}与拍数比方向${j}的综合描述`,()=>{
 const result=describe({...base,netRate:states[i].rate,normalizedBeatRatio:states[j].ratio});assert.equal(result.speedDescription,expected[i][j]);assert.equal(result.speedEvidenceComplete,true);
});
test('豁免不抹除诊断，正常区间和比值边界取现有同源数据',()=>{
 for(const rate of [normal.NORMAL_CHINESE_BEAT_SPEED_LOW,normal.NORMAL_CHINESE_BEAT_SPEED_HIGH])for(const ratio of [.85,1.15])assert.equal(describe({...base,netRate:rate,normalizedBeatRatio:ratio}).speedDescription,'语速正常');
 assert.equal(describe({...base,netRate:6,normalizedBeatRatio:.7,beatExempt:true}).speedDescription,'速度有些稍快');
 assert.equal(describe({netRate:6,normalizedBeatRatio:.8,beatBand:{low:.75,high:1.1}}).speedDescription,'语速正常');
});
test('短句/无效测量不伪造比=1或双正常，保留部分证据与不可测标记',()=>{
 for(const value of [null,undefined,NaN,0,-1]){
  const result=describe({...base,netRate:6,normalizedBeatRatio:value});assert.equal(result.beat.normalizedRatio,null);assert.equal(result.beat.status,'不可计算');assert.equal(result.speedDescription,'语速数据不足');assert.equal(result.speedEvidenceComplete,false);
 }
 assert.equal(describe({...base,netRate:8,normalizedBeatRatio:null}).speedDescription,'速度有些稍快');
 assert.equal(describe({...base,netRate:null,normalizedBeatRatio:1.3}).speedDescription,'速度有些稍慢');
 assert.equal(describe({netRate:6,normalizedBeatRatio:1}).speedDescription,'语速数据不足');
});
