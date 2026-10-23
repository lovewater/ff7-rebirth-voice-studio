import type { SpeechChunk } from './speech-segments';
/** 两/三段共用时序分配：首尾按JP，内部每处>=250ms，最后严格等长。
 * 三段时：首段对齐JP开头，末段对齐JP结尾，中段按发声区间的中心对齐。
 * 中段缩放后仍有长短余差时，余差平均放到两侧，而非固定开口；仅当250ms间隔
 * 约束不允许时夹到最近可行位置。绝不截正文或再次整体变速。
 * 只有两段时自然退化为原来“唯一中间留白=总长-首尾-两段正文”的规则。
 */
export function layoutPartTimeline(reference:{sampleRate:number;samples:Float32Array},chunks:SpeechChunk[],sampleRate:number,bodies:Float32Array[]){
  if(![2,3].includes(chunks.length)||chunks.length!==bodies.length)throw Error('时序布局必须是相同的两/三段');
  const cv=(n:number)=>Math.round(n*sampleRate/reference.sampleRate),total=cv(reference.samples.length);
  const leading=cv(chunks[0].start),trailing=cv(reference.samples.length-chunks.at(-1)!.end);
  let remaining=total-leading-trailing-bodies.reduce((n,a)=>n+a.length,0);
  const minimum=Math.ceil(.25*sampleRate),gapCount=bodies.length-1;
  if(remaining<minimum*gapCount)return null;
  const gaps:number[]=[];let position=leading;
  for(let i=0;i<gapCount;i++){
    position+=bodies[i].length;
    const next=chunks[i+1];
    const desiredStart=bodies.length===3 && i===0
      ? Math.round((cv(next.start)+cv(next.end)-bodies[i+1].length)/2)
      : cv(next.start);
    const wanted=desiredStart-position;
    const gap=i===gapCount-1?remaining:Math.max(minimum,Math.min(remaining-minimum*(gapCount-i-1),wanted));
    gaps.push(gap);remaining-=gap;position+=gap;
  }
  const out=new Float32Array(total);position=leading;
  bodies.forEach((body,i)=>{out.set(body,position);position+=body.length+(gaps[i]??0);});
  return {samples:out,gapsSeconds:gaps.map(n=>n/sampleRate),leadingSeconds:leading/sampleRate,trailingSeconds:trailing/sampleRate};
}
