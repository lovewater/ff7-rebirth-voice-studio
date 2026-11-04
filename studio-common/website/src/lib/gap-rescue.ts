import type { SeedAsrResult } from "./seed-asr";
import type { SpeechChunk } from "./speech-segments";
import { applyPronunciations, type Pronunciation } from "./pronounce";
import { correctAsrWords, type AsrWordRule, type AsrWordCorrection } from "./asr-word-corrections";

export const GAP_RESCUE_POLICY = { relativePeak: .05, minCoreMs: 100, searchGuardMs: 120, anchorGuardMs: 40, edgeGuardMs: 10, frameMs: 10 };
const compact = (text: string) => text.replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
export type RescueGap = { startMs: number; endMs: number; durationMs: number; peak: number };
export type RescueBoundary = { index: number; leftText: string; rightText: string; leftEndMs?: number; rightStartMs?: number; searchStartMs?: number; searchEndMs?: number; candidates: RescueGap[]; selectedGap?: RescueGap; cutMs?: number; reason: string };
export type GapRescueMeta = {
  version: string; attempted: boolean; accepted: boolean; used: boolean; reason: string; sourceFailure: string;
  expectedParts: string[]; canonicalParts: string[]; canonicalAsr: string; appliedRules: { src: string; dst: string }[];
  waveformPolicy: typeof GAP_RESCUE_POLICY; boundaries: RescueBoundary[]; asr: Pick<SeedAsrResult, "text" | "words" | "raw" | "status">;
  asrWordCorrection?:AsrWordCorrection;
  sampleRate: number; originalSamples: number; verifiedChunks?: SpeechChunk[]; partChecks?: { target: string; recognized: string; matches: boolean; raw: unknown }[];
};

/** Final-resort boundary evidence only. Never edits PCM or guesses time from text length. */
export function findGapRescueCuts(samples: Float32Array, sampleRate: number, expectedParts: string[], asr: SeedAsrResult, rules: Pronunciation[], sourceFailure: string, asrWordRules:AsrWordRule[]=[]): GapRescueMeta {
  // Only currently configured literal Han replacements can canonicalize recognition.
  // Pinyin/Latin control strings are not speech transcripts and are deliberately excluded.
  const legalRules=rules.filter(r=>r.src && !/[A-Za-z0-9]/.test(r.src+r.dst));
  const canonical=(s:string)=>compact(applyPronunciations(s,legalRules));
  const correction=correctAsrWords(expectedParts.join(''),asr.text,asrWordRules);
  const canonicalParts=expectedParts.map(canonical), canonicalAsr=canonical(correction.correctedText);
  const meta:GapRescueMeta={version:"seed-local-gap-rescue-v1",attempted:true,accepted:false,used:false,reason:"",sourceFailure,expectedParts,canonicalParts,canonicalAsr,
    appliedRules:legalRules.filter(r=>(expectedParts.join("")+asr.text).includes(r.src)).map(({src,dst})=>({src,dst})),
    waveformPolicy:{...GAP_RESCUE_POLICY},boundaries:[],asr:{text:asr.text,words:asr.words,raw:asr.raw,status:asr.status},sampleRate,originalSamples:samples.length,
    ...(correction.hits.length?{asrWordCorrection:correction}:{})};
  const reject=(reason:string)=>{meta.reason=reason;return meta;};
  if(![2,3,4].includes(expectedParts.length)||canonicalParts.some(p=>!p))return reject("仅支持有明确正文边界的两/三/四段");
  if(canonicalParts.join("")!==canonical(expectedParts.join("")))return reject("词库替换跨越目标分句边界，拒绝猜测对应");
  if(canonicalAsr.length!==compact(asr.text).length || canonicalParts.some((part,i)=>part.length!==compact(expectedParts[i]).length))return reject("词库级联替换后的最终正文改变字轴字符数，本轮拒绝猜测字符归属");
  if(correction.hits.some(hit=>compact(hit.word).length!==compact(hit.alias).length))return reject('ASR别名改变局部字轴字符数，禁止凭纠错文字猜切点');
  if(asr.status!=="20000000"||canonicalAsr!==canonicalParts.join(""))return reject("Seed整句正文与目标不一致（仅允许当前词库的字面替换）");
  // Full literal replacements may span several Seed word units. Equal-length Han
  // mappings preserve every character offset; a length-changing mapping needs a
  // stronger ownership map and is conservatively rejected in this first probe.
  if(meta.appliedRules.some(r=>compact(r.src).length!==compact(r.dst).length))return reject("词库替换改变字轴字符数，本轮拒绝猜测字符归属");
  let cursor=0;let previousEnd=-Infinity;
  const units: {a:number;b:number;start:number;end:number;text:string}[]=[];
  for(const word of asr.words){
    const text=compact(word.text);if(!text)continue;
    if(!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<=word.start||word.start<previousEnd)return reject("Seed字轴缺失、重叠或倒序");
    units.push({a:cursor,b:cursor+text.length,start:word.start,end:word.end,text});cursor+=text.length;previousEnd=word.end;
  }
  const axisBody=units.map(u=>u.text).join("");
  if(!units.length||axisBody!==compact(asr.text)||canonical(correctAsrWords(expectedParts.join(''),axisBody,asrWordRules).correctedText)!==canonicalAsr)return reject("Seed字轴正文不能完整唯一覆盖识别全文");
  let peak=0;for(const x of samples)peak=Math.max(peak,Math.abs(x));
  if(!(sampleRate>0)||peak<=1e-8)return reject("音频没有可验证的非零正文");
  const policy=GAP_RESCUE_POLICY,hop=Math.max(1,Math.round(sampleRate*policy.frameMs/1000)),threshold=peak*policy.relativePeak;
  const gaps:RescueGap[]=[];let quiet:number|null=null;
  for(let at=0;at<=samples.length;at+=hop){
    let framePeak=0;
    if(at<samples.length)for(let j=at;j<Math.min(samples.length,at+hop);j++)framePeak=Math.max(framePeak,Math.abs(samples[j]));
    const low=at<samples.length&&framePeak<threshold;
    if(low&&quiet===null)quiet=at;
    if(!low&&quiet!==null){
      const end=Math.min(at,samples.length),durationMs=(end-quiet)/sampleRate*1000;
      if(durationMs>=policy.minCoreMs){let p=0;for(let j=quiet;j<end;j++)p=Math.max(p,Math.abs(samples[j]));gaps.push({startMs:quiet/sampleRate*1000,endMs:end/sampleRate*1000,durationMs,peak:p});}
      quiet=null;
    }
  }
  let offset=0;
  for(let i=0;i<canonicalParts.length-1;i++){
    offset+=canonicalParts[i].length;
    const b:RescueBoundary={index:i+1,leftText:expectedParts[i],rightText:expectedParts[i+1],candidates:[],reason:""};meta.boundaries.push(b);
    const left=units.find(u=>u.b===offset),right=units.find(u=>u.a===offset);
    if(!left||!right){b.reason="目标边界位于同一个Seed词单元内部";return reject(b.reason);}
    b.leftEndMs=left.end;b.rightStartMs=right.start;
    b.searchStartMs=Math.max(0,left.end-policy.searchGuardMs);b.searchEndMs=Math.min(samples.length/sampleRate*1000,right.start+policy.searchGuardMs);
    const anchorLo=left.end-policy.anchorGuardMs,anchorHi=right.start+policy.anchorGuardMs;
    b.candidates=gaps.filter(g=>g.startMs>=b.searchStartMs!&&g.endMs<=b.searchEndMs!&&(g.startMs+g.endMs)/2>=anchorLo&&(g.startMs+g.endMs)/2<=anchorHi);
    // Multiple possible gaps are ambiguous; do not let "longest" jump to a different word.
    if(b.candidates.length!==1){b.reason=b.candidates.length?"目标词界附近有多个候选缝，不能唯一定位":"目标词界没有至少100ms的安全低能量缝";return reject(b.reason);}
    b.selectedGap=b.candidates[0];b.cutMs=(b.selectedGap.startMs+b.selectedGap.endMs)/2;b.reason="唯一低能量核心位于目标Seed词界附近";
  }
  let edgeStart=0,edgeEnd=samples.length;
  while(edgeStart<edgeEnd&&Math.abs(samples[edgeStart])<threshold)edgeStart++;
  while(edgeEnd>edgeStart&&Math.abs(samples[edgeEnd-1])<threshold)edgeEnd--;
  const starts=[edgeStart,...meta.boundaries.map(b=>Math.round((b.selectedGap!.endMs-policy.edgeGuardMs)*sampleRate/1000))];
  const ends=[...meta.boundaries.map(b=>Math.round((b.selectedGap!.startMs+policy.edgeGuardMs)*sampleRate/1000)),edgeEnd];
  const chunks=starts.map((start,i)=>({start,end:ends[i]}));
  if(chunks.some(c=>c.end<=c.start))return reject("补切产生空片段或边界交叉");
  meta.accepted=true;meta.reason="全部目标词界均有唯一可靠字轴和至少100ms的波形低能量核心";meta.verifiedChunks=chunks;
  return meta;
}
