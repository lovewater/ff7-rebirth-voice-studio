import { alignmentDetectionSignal } from "./alignment-transients";
import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";
import { layoutPartTimeline } from "./speech-part-timeline";

/** 日文入口450ms，中文分隔与最终组装仍为250ms，不能混用阈值。 */
export const TWO_PART_JP_GAP_S = .45;
export const TWO_PART_CN_GAP_S = .25;

type Wave = { samples: Float32Array; sampleRate: number };
type TwoParts = { start: number; end: number; gapStart: number; gapEnd: number };
type Part = { start: number; end: number };

/** 扫描全部内部停顿：5%峰值、10ms窗、默认内部>=250ms静音；无需ASR或模型。
 * 检测前共用alignment-transients规则忽略孤立微弱凸起，原音频不变。
 * 首尾留白不算分段；导出的internalSpeechParts仍只接受两/三段。
 * 私有扫描器允许更多段，仅供手动两端工具挑最长停顿，不能放宽自动流程。
 */
function detectInternalSpeechParts({ samples: original, sampleRate }: Wave, minimumSeconds = 0.25) {
  const { samples, peak } = alignmentDetectionSignal(original, sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !samples.length) return null;
  if (peak <= 1e-8) return null;
  const threshold = peak * ALIGN_SILENCE_RATIO;
  let start = 0, end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const minimum = Math.ceil(sampleRate * minimumSeconds);
  let quietStart: number | null = null;
  const gaps: { start: number; end: number }[] = [];
  for (let at = Math.floor(start / hop) * hop; at < end + hop; at += hop) {
    let quiet = at < samples.length;
    for (let i = at; i < Math.min(at + hop, samples.length); i++) {
      if (Math.abs(samples[i]) >= threshold) { quiet = false; break; }
    }
    if (quiet && quietStart === null) quietStart = at;
    if (!quiet && quietStart !== null) {
      if (at - quietStart >= minimum && quietStart > start && at < end) {
        gaps.push({ start: quietStart, end: at });
      }
      quietStart = null;
    }
  }
  if (!gaps.length) return null;
  const parts: Part[] = []; let at = start;
  for (const gap of gaps) { parts.push({start:at,end:gap.start}); at=gap.end; }
  parts.push({start:at,end});
  return { start, end, gaps, parts };
}

/** 自动流程/既有调用保持只认两段或三段，不套用手动最长停顿归并。 */
export function internalSpeechParts(wave: Wave, minimumSeconds = 0.25) {
  const result = detectInternalSpeechParts(wave, minimumSeconds);
  return result && [2,3].includes(result.parts.length) ? result : null;
}

/** 仅手动工具：生成音频为两段时，以日文最长的>=250ms内部停顿为唯一分界。
 * 日文即使有三段或更多段，也归为前后两组；其他短停顿属于组内，不能删掉。
 * 等长停顿取较早的一处，首尾静音不参与竞争；仍共用孤立微弱凸起过滤。
 * 三段生成音频保持原三段对应规则。不要用于大模型自动分段/拉伸。
 */
function manualReferenceParts(reference: Wave, candidatePartCount: number) {
  if (candidatePartCount !== 2) return internalSpeechParts(reference);
  const detected = detectInternalSpeechParts(reference);
  if (!detected) return null;
  const longest = detected.gaps.reduce((best, gap) => gap.end - gap.start > best.end - best.start ? gap : best);
  return { start: detected.start, end: detected.end, gaps: [longest], parts: [
    { start: detected.start, end: longest.start }, { start: longest.end, end: detected.end },
  ] };
}

/** 保留原两段检测入口，避免自动流程把三段误当两端对话工作流。 */
export function singleInternalGap(wave: Wave, minimumSeconds = 0.25): TwoParts | null {
  const result=internalSpeechParts(wave,minimumSeconds);
  return result?.gaps.length===1 ? {start:result.start,end:result.end,gapStart:result.gaps[0].start,gapEnd:result.gaps[0].end} : null;
}

/** 手动“高级自动对齐”：两端对话工作流只调整唯一间隔；三段对话工作流
 * 共用时序布局：首段贴头、末段贴尾、中段中心贴日文对应中段中心，间隔至少250ms。
 * 中文两段时日文按最长停顿归为两组；中文三段时仍要求日文三段。
 * 这里只复制原声音、调整留白，不拉伸、不改音量，正文必须能装下。
 */
export function gapOnlyAlignmentPlan(reference: Wave, edited: Wave) {
  const cn=internalSpeechParts(edited);
  const jp=cn ? manualReferenceParts(reference,cn.parts.length) : null;
  if(!jp || !cn || jp.parts.length!==cn.parts.length)return null;
  const convert=(frames:number)=>Math.round(frames*edited.sampleRate/reference.sampleRate);
  const total=convert(reference.samples.length),leading=convert(jp.start),trailing=convert(reference.samples.length-jp.end);
  const lengths=cn.parts.map(p=>p.end-p.start);
  const middle=total-leading-trailing-lengths.reduce((n,x)=>n+x,0);
  if(middle<0)return null;
  let gaps:number[];
  if(cn.parts.length===2) gaps=[middle]; // 保持旧两端对话工作流行为，不额外收紧原有手动规则。
  else {
    const layout=layoutPartTimeline(reference,jp.parts,edited.sampleRate,cn.parts.map(p=>edited.samples.subarray(p.start,p.end)));
    if(!layout)return null;
    gaps=layout.gapsSeconds.map(seconds=>Math.round(seconds*edited.sampleRate));
  }
  let position=leading;
  const starts=lengths.map((length,i)=>{const start=position;position+=length+(gaps[i]??0);return start;});
  return {total,leading,trailing,middle,firstLength:lengths[0],secondLength:lengths.at(-1)!,
    cn:{...cn,gapStart:cn.gaps[0].start,gapEnd:cn.gaps.at(-1)!.end},parts:cn.parts,starts,gaps,partCount:cn.parts.length,
    referenceParts:jp.parts,referenceGaps:jp.gaps};
}

export function alignSpeechGaps(reference: Wave, edited: Wave): Float32Array {
  const plan=gapOnlyAlignmentPlan(reference,edited);
  if(!plan)throw new Error("高级自动对齐需要中文为两段正文（日文取最长停顿）或日中同为三段正文，且声音能放入日文时长");
  const out=new Float32Array(plan.total);
  plan.parts.forEach((part,i)=>out.set(edited.samples.subarray(part.start,part.end),plan.starts[i]));
  return out;
}

/** 兼容旧调用名；新编辑器用alignSpeechGaps，现已支持两端/三段对话工作流。 */
export const alignSingleGap=alignSpeechGaps;
