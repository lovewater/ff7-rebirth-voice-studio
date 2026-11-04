import { correctAsrWords, type AsrWordCorrection } from './asr-word-corrections';
import { loadAsrWordRules } from './asr-word-corrections-db';
import { splitBodyScript, scriptLines, type BodyScriptPolicy } from "./two-part-script";
import { decodeWavMono, encodeWavMono } from './wav-stretch';
import { findGapRescueCuts, type GapRescueMeta } from './gap-rescue';
import { seedAsr } from './seed-asr';
import { sql } from './db';
import { applyPronunciations, type Pronunciation } from './pronounce';
import type { SpeechChunk } from './speech-segments';
import { qwenAsr } from './qwen-asr';
import { rewriteChat, parseJsonObject } from './auto-run-llm';

export { speechChunks } from "./speech-segments";
import { speechChunks } from "./speech-segments";
/** 只允许连续分组：每个原片段出现一次、顺序不变，每组均非空。
 * 模型不得丢片段、重复片段、跨组穿插，也不能输出“把字切开”之类无法执行的建议。
 */
export function validateGroups(value: unknown, count: number, requiredGroups = 2): number[][] {
  if(!Array.isArray(value)||value.length!==requiredGroups||value.some(g=>!Array.isArray(g)||!g.length))throw Error(`必须返回${requiredGroups}个非空连续分组`);
  const groups=value as unknown[][],flat=groups.flat();
  if(flat.length!==count||flat.some((x,i)=>!Number.isInteger(x)||x!==i+1))throw Error('分组必须完整覆盖原片段并保持连续顺序');
  return groups as number[][];
}
/** 合并组内长停顿为240ms（小于旧250ms分隔门槛），组间保留原切口至少250ms。
 * 不截发声、不重排、不做变速；随后由既有逐段85%～115%缩放、>=250ms留白与等长组装处理。
 */
export function mergeGroups(audio:Buffer,groups:number[][]){
  const {wave,chunks}=speechChunks(audio),{samples,sampleRate}=wave;
  validateGroups(groups,chunks.length,groups.length);
  if(![2,3,4].includes(groups.length))throw Error("只支持两段、三段或四段连续分组");
  const pieces:Float32Array[]=[samples.subarray(0,chunks[0].start)];
  groups.forEach((group,gi)=>group.forEach((index,i)=>{
    if(i>0)pieces.push(new Float32Array(Math.round(.24*sampleRate)));
    if(gi>0&&i===0){const previous=chunks[groups[gi-1].at(-1)!-1],next=chunks[index-1];pieces.push(new Float32Array(Math.max(Math.ceil(.25*sampleRate),next.start-previous.end)));}
    const c=chunks[index-1];pieces.push(samples.subarray(c.start,c.end));
  }));
  pieces.push(samples.subarray(chunks.at(-1)!.end));
  const out=new Float32Array(pieces.reduce((n,a)=>n+a.length,0));let offset=0;
  for(const a of pieces){out.set(a,offset);offset+=a.length;}
  return encodeWavMono(sampleRate,out);
}
export type RegroupMeta = {asrWordCorrections?:AsrWordCorrection[];serviceFailure?:boolean;normalBoundaryCheck?:{matches:boolean[];grouped:string[];canonicalTargets:string[]};verifiedChunks?:SpeechChunk[];gapRescue?:GapRescueMeta;version:string;consistent:boolean;reason:string;textConsistent?:boolean;boundaryMatches?:boolean[];groups?:number[][];requiredParts?:number;scriptPolicy?:BodyScriptPolicy;innerGapSeconds?:number;segments:{index:number;startS:number;endS:number;text:string;raw:unknown}[]};
/** 参考已确认两/三/四段时核对真实切口：片数恰好也可能把“其实”独立切成第一片。
 * 有明确strict/lines目标时，恰好片数仍做免费Qwen逐片核对；逐字一致无需模型，近音才询问。
 * 多于目标片数则继续原有核字与归组；少于目标或relaxed无固定文字分界时交回原流程。
 * 不一致/不可执行建议均返回失败，由上层原稿重新TTS，不能靠合并掩盖缺字、多字、重复或倒序。
 * 同音/近音、声调、轻声、标点与ASR误字由模型宽容判断；没有识别证据时不得猜测通过。
 */
async function regroupTwoPartAudioNormally(audio:Buffer,script:string,stem:string,requiredParts = 2,scriptPolicy:BodyScriptPolicy="strict"){
  const version=requiredParts===4?'four-parts-regroup-v1':requiredParts===3?'three-parts-regroup-v1':'two-parts-regroup-v1';
  const taskPrefix=requiredParts===4?'four-parts':requiredParts===3?'three-parts':'two-parts';
  const {wave,chunks}=speechChunks(audio);
  const expectedParts=scriptPolicy==="lines"?scriptLines(script):scriptPolicy==="strict"?splitBodyScript(script):[];
  if(chunks.length<requiredParts)return null;
  if(chunks.length===requiredParts && (scriptPolicy==="relaxed"||expectedParts.length!==requiredParts))return null;
  const segments:RegroupMeta['segments']=[];
  for(const [i,c] of chunks.entries()){
    const result=await qwenAsr(encodeWavMono(wave.sampleRate,wave.samples.subarray(c.start,c.end)).toString('base64'));
    segments.push({index:i+1,startS:c.start/wave.sampleRate,endS:c.end/wave.sampleRate,text:result.text,raw:result.raw});
  }
  if(segments.some(s=>!s.text.trim()))return {audio,meta:{version,requiredParts,consistent:false,reason:'某段Qwen-ASR为空，保留音频并原稿重TTS',segments} as RegroupMeta};
  // lines只以换行定义目标，绝不再按行内标点拆expectedParts。
  // relaxed短句没有固定文本分界，模型在全文核字通过后选择自然连续分界。
  if(scriptPolicy!=="relaxed"&&expectedParts.length!==requiredParts)return {audio,meta:{version,requiredParts,consistent:false,reason:"目标分片台词格式不合法",segments} as RegroupMeta};
  const compact=(x:string)=>x.normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\s]/gu,'');
  const asrWordRules=await loadAsrWordRules();
  const corrected=(recognized:string,target=script)=>correctAsrWords(target,recognized,asrWordRules);
  const correctionProof=segments.map((segment,i)=>corrected(segment.text,chunks.length===requiredParts?expectedParts[i]:script));
  if(chunks.length===requiredParts){
    const matches=segments.map((s,i)=>compact(corrected(s.text,expectedParts[i]).correctedText)===compact(expectedParts[i]));
    const meta:RegroupMeta={version,requiredParts,scriptPolicy,consistent:matches.every(Boolean),reason:"逐片核字与目标台词对应，原切口保持不变",groups:segments.map(s=>[s.index]),segments,asrWordCorrections:correctionProof,textConsistent:compact(corrected(segments.map(s=>s.text).join('')).correctedText)===compact(script),boundaryMatches:matches};
    if(!meta.consistent){
      const checked=await rewriteChat([
        {role:'system',content:'',promptKey:'two-parts.regroup-groups-check-system',promptValues:{}},
        {role:'user',content:JSON.stringify({groups:segments.map((s,i)=>({index:i+1,target:expectedParts[i],recognized:corrected(s.text,expectedParts[i]).correctedText}))})},
      ],.1,taskPrefix+'-boundary-check',3,{stem});
      const verified=parseJsonObject(checked.content);
      meta.consistent=verified.consistent===true&&Array.isArray(verified.matches)&&verified.matches.length===requiredParts&&verified.matches.every(x=>x===true);
      meta.boundaryMatches=Array.isArray(verified.matches)?verified.matches.map(x=>x===true):matches;
      if(meta.consistent)meta.textConsistent=true;
      meta.reason=meta.consistent?'逐片近音核对通过，原切口保持不变':'片数正确但逐片对应失败：'+String(verified.reason||'切口与目标行错位，须按原稿重TTS');
    }
    // 不猜切词、不重分配错位音频，成功也原样返回，避免无意义地重编码或改变留白。
    return {audio,meta};
  }
  const input={script,scriptPolicy,requiredParts,expectedParts,segments:segments.map(s=>({index:s.index,startS:s.startS,endS:s.endS,text:correctionProof[s.index-1].correctedText,rawText:s.text}))};
  // 核字与分组分两次请求：先确认整句被完整读出，再考虑两个组的语义分界。
  const checked=await rewriteChat([
    {role:'system',content:'',promptKey:'two-parts.regroup-check-system',promptValues:{}},
    {role:'user',content:'',promptKey:'two-parts.regroup-input',promptValues:{input_json:JSON.stringify(input)}},
  ],.1,taskPrefix+'-regroup-check',3,{stem});
  const review=parseJsonObject(checked.content);
  if(review.consistent!==true)return {audio,meta:{version,requiredParts,consistent:false,reason:String(review.reason||'逐段全文核字不一致'),segments} as RegroupMeta};
  const result=await rewriteChat([
    {role:'system',content:'',promptKey:'two-parts.regroup-system',promptValues:{}},
    {role:'user',content:'',promptKey:'two-parts.regroup-input',promptValues:{input_json:JSON.stringify(input)}},
  ],.1,taskPrefix+'-regroup',3,{stem});
  const parsed=parseJsonObject(result.content);
  const meta:RegroupMeta={version,requiredParts,scriptPolicy,consistent:parsed.consistent===true,reason:String(parsed.reason||''),segments,asrWordCorrections:correctionProof};
  if(!meta.consistent)return {audio,meta};
  try{meta.groups=validateGroups(parsed.groups,chunks.length,requiredParts);}catch(error){meta.consistent=false;meta.reason=String(error);return {audio,meta};}
  const grouped=meta.groups.map(group=>group.map(i=>segments[i-1].text).join(''));
  if(scriptPolicy!=="relaxed"&&expectedParts.length!==requiredParts){meta.consistent=false;meta.reason=`朗读稿必须恰好${requiredParts}段，拒绝猜测分界`;return {audio,meta};}
  // 全文一致不代表分界正确。能逐字对应时直接确认；同音/ASR误字时才另请模型逐组核对。
  // 防止“好了”被偷偷并进前组，模型却笼统声称“整体意思一样”。
  if(scriptPolicy!=="relaxed"&&grouped.some((text,i)=>compact(corrected(text,expectedParts[i]).correctedText)!==compact(expectedParts[i]))){
    const checkedGroups=await rewriteChat([
      {role:'system',content:'',promptKey:'two-parts.regroup-groups-check-system',promptValues:{}},
      {role:'user',content:JSON.stringify({groups:grouped.map((recognized,i)=>({index:i+1,target:expectedParts[i],recognized:corrected(recognized,expectedParts[i]).correctedText}))})},
    ],.1,taskPrefix+'-regroup-groups-check',3,{stem});
    const verified=parseJsonObject(checkedGroups.content);
    if(verified.consistent!==true||!Array.isArray(verified.matches)||verified.matches.length!==requiredParts||!verified.matches.every(x=>x===true)){
      meta.consistent=false;meta.reason='分组逐段核对失败：'+String(verified.reason||'无法确认每组对应目标段');return {audio,meta};
    }
  }
  meta.innerGapSeconds=.24;
  return {audio:mergeGroups(audio,meta.groups),meta};
}

/** Only the final automatic stage may request a conservative local-gap attempt after ordinary regrouping. */
export async function regroupTwoPartAudio(audio:Buffer,script:string,stem:string,requiredParts=2,scriptPolicy:BodyScriptPolicy="strict", options:{allowGapSplit?:boolean}={}) {
  let normal:Awaited<ReturnType<typeof regroupTwoPartAudioNormally>>;
  try { normal=await regroupTwoPartAudioNormally(audio,script,stem,requiredParts,scriptPolicy); }
  catch(error) {
    // A failed ASR/model request is not evidence of an uncuttable waveform.
    return {audio,meta:{version:requiredParts===4?'four-parts-regroup-v1':requiredParts===3?'three-parts-regroup-v1':'two-parts-regroup-v1',requiredParts,scriptPolicy,consistent:false,serviceFailure:true,reason:`逐段核对服务/验证异常：${String(error)}`,segments:[]} as RegroupMeta};
  }
  if(options.allowGapSplit!==true)return normal;
  const expected=scriptPolicy==="lines"?scriptLines(script):scriptPolicy==="strict"?splitBodyScript(script):[];
  if(expected.length!==requiredParts || ![2,3,4].includes(requiredParts))return normal;
  const decoded=decodeWavMono(audio);
  const originalChunks=speechChunks(audio).chunks;
  // An exact ordinary split requires no rescue even when the normal policy returned null.
  if(!normal && originalChunks.length===requiredParts)return normal;
  let failure=normal?.meta.reason ?? `常规250ms分句得到${originalChunks.length}段，要求${requiredParts}段`;
  const version=requiredParts===4?'four-parts-regroup-v1':requiredParts===3?'three-parts-regroup-v1':'two-parts-regroup-v1';
  const base:RegroupMeta=normal?.meta ?? {version,requiredParts,scriptPolicy,consistent:false,reason:failure,segments:[]};
  try {
    const rows=await sql<Pronunciation[]>`SELECT id,src,dst,note FROM pronunciations WHERE usage='reference' ORDER BY id`;
    const legal=rows.filter(r=>r.src&&!/[A-Za-z0-9]/.test(r.src+r.dst));
    const asrWordRules=await loadAsrWordRules();
    const corrected=(recognized:string,target:string)=>correctAsrWords(target,recognized,asrWordRules).correctedText;
    const compact=(s:string)=>applyPronunciations(s,legal).replace(/[\p{P}\p{S}\p{Z}\s]/gu,'');
    if(normal?.meta.consistent===true) {
      // A model's near-homophone approval cannot certify that words stayed in their group.
      const groups=normal.meta.groups ?? normal.meta.segments.map(s=>[s.index]);
      const grouped=groups.map(group=>group.map(index=>normal.meta.segments.find(s=>s.index===index)?.text??'').join(''));
      const matches=expected.map((target,i)=>grouped.length===requiredParts&&compact(corrected(grouped[i]??'',target))===compact(target));
      base.normalBoundaryCheck={matches,grouped,canonicalTargets:expected.map(compact)};
      if(matches.every(Boolean))return {audio:normal.audio,meta:{...normal.meta,normalBoundaryCheck:base.normalBoundaryCheck}};
      base.consistent=false;base.textConsistent=false;base.boundaryMatches=matches;
      failure='常规模型声称分组一致，但严格逐组正文对应失败，须Seed词界重新核对';
      base.reason=failure;
    }
    const asr=await seedAsr(audio.toString('base64'),'wav','zh-CN');
    const rescue=findGapRescueCuts(decoded.samples,decoded.sampleRate,expected,asr,rows,failure,asrWordRules);
    if(!rescue.accepted || !rescue.verifiedChunks)return {audio,meta:{...base,consistent:false,...(!["20000000","20000003"].includes(asr.status)?{serviceFailure:true}:{}),reason:`短缝补切拒绝：${rescue.reason}`,gapRescue:rescue}};
    const segments:RegroupMeta['segments']=[];
    rescue.partChecks=[];
    for(const [i,c] of rescue.verifiedChunks.entries()) {
      const recognized=await qwenAsr(encodeWavMono(decoded.sampleRate,decoded.samples.subarray(c.start,c.end)).toString('base64'));
      const matches=compact(corrected(recognized.text,expected[i]))===rescue.canonicalParts[i];
      rescue.partChecks.push({target:expected[i],recognized:recognized.text,matches,raw:recognized.raw});
      segments.push({index:i+1,startS:c.start/decoded.sampleRate,endS:c.end/decoded.sampleRate,text:recognized.text,raw:recognized.raw});
    }
    if(rescue.partChecks.some(p=>!p.matches)) {
      rescue.accepted=false;rescue.reason='补切逐段Qwen正文不能按当前词库字面替换与目标逐字对应';
      return {audio,meta:{...base,consistent:false,reason:rescue.reason,gapRescue:rescue}};
    }
    rescue.used=true;
    return {audio,meta:{...base,consistent:true,textConsistent:true,boundaryMatches:expected.map(()=>true),groups:expected.map((_,i)=>[i+1]),segments,
      reason:'末轮短缝补切：Seed词界、波形核心及逐段Qwen正文全部确认；等待既有时长与组装验收',verifiedChunks:rescue.verifiedChunks,gapRescue:rescue}};
  } catch(error) {
    return {audio,meta:{...base,consistent:false,serviceFailure:true,reason:`短缝补切服务/验证失败：${String(error)}`,gapRescue:{version:'seed-local-gap-rescue-v1',attempted:true,accepted:false,used:false,reason:String(error),sourceFailure:failure,expectedParts:expected,canonicalParts:[],canonicalAsr:'',appliedRules:[],waveformPolicy:{relativePeak:.05,minCoreMs:100,searchGuardMs:120,anchorGuardMs:40,edgeGuardMs:10,frameMs:10},boundaries:[],asr:{text:'',words:[],raw:null,status:'error'},sampleRate:decoded.sampleRate,originalSamples:decoded.samples.length}}};
  }
}
