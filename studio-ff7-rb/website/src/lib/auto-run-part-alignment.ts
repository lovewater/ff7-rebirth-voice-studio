import { speechChunks, type SpeechSplitRegion } from "./speech-segments";
import { layoutPartTimeline } from "./speech-part-timeline";
import { TWO_PART_JP_GAP_S } from "./gap-only-align";
import { decodeWavMono, encodeWavMono, stretchSamples } from "./wav-stretch";
import * as splice from "./audio-splice";
import type { OnoPlan, SplicePiece } from "./auto-run-onomatopoeia";
/** 两段正文时序状态（与列表通用语速/拍数报警是不同指标）：
 * correct 正确：85%～115%缩放后两段分别对齐，仅容许一个采样的舍入误差。
 * warning 警告：无法完全对齐，但任一段的绝对余差都<=300ms；仍是可用候选。
 * error 错误：任一段余差>300ms、不是恰好两段，或拼装装不下250ms中间静音、最终总长误差超过50ms。
 * 只存在警告可用稿时额外改善一轮；旧稿必须保留，改善失败不得丢失已有答案。
 * 比例=factor=输出时长/输入时长，1.15是拉长15%，不是语速倍率。
 */
export type PartAlignmentStatus = "correct" | "warning" | "error";
export type PartTiming = {
    index: number;
    status: PartAlignmentStatus;
    originalSeconds: number;
    referenceSeconds: number;
    factor: number;
    afterSeconds: number;
    deltaSeconds: number;
    pass: boolean;
    suggestion: string;
};
export type PartAlignmentMeta = {
    version: string;
    status: PartAlignmentStatus;
    pass: boolean;
    lo: number;
    hi: number;
    toleranceSeconds: number;
    parts: PartTiming[];
    gapSeconds?: number;
    gapsSeconds?: number[];
    splitRegions?: SpeechSplitRegion[];
    requiredParts?: number;
    reason?: string;
};
/** 记录每段正文在输出中的位置及缩放系数，后续裁边/组装时随位置平移。
 * 250ms×factor只作用于该段内部；新填充的两/三段间静音始终按250ms判断。
 */
export function partSplitRegions(leading: number, bodies: Float32Array[], sampleRate: number, gaps: number[], factors: number[]): SpeechSplitRegion[] {
    let position=leading;
    return bodies.map((body,i)=>{const startSeconds=position,endSeconds=position+body.length/sampleRate;position=endSeconds+(gaps[i]??0);return {startSeconds,endSeconds,factor:factors[i]??1};});
}

/** 入口只看删拟声/环境音且裁首尾后的实际JP参考：恰好一处>=500ms长停顿。
 * 中文需恰好两段（长停顿识别250ms）；按两段分别缩放，再恢复首尾与中间留白。
 * 总长度凑齐不是逐段合格的证据，因此即使拼成总长相等，仍必须看各段余差。
 * 返回null=不适用；返回status:error=已进入线路但失败，不能偷回旧整体拉伸掩盖错误。
 */
export function alignParts(generated: Buffer, reference: Buffer) {
    const {wave:jp,chunks:j}=speechChunks(reference,TWO_PART_JP_GAP_S),{wave:cn,chunks:c}=speechChunks(generated);
    if(![2,3].includes(j.length))return null;
    const requiredParts=j.length;
    const meta:PartAlignmentMeta={version:requiredParts===3?'three-parts-v1':'two-parts-v1',requiredParts,status:'error',pass:false,lo:.85,hi:1.15,toleranceSeconds:.3,parts:[]};
    if(c.length!==requiredParts)return {audio:generated,meta:{...meta,reason:`中文不是恰好${requiredParts}段`}};
    const bodies=c.map((part,index)=>{
      const originalSeconds=(part.end-part.start)/cn.sampleRate,referenceSeconds=(j[index].end-j[index].start)/jp.sampleRate;
      const factor=Math.max(.85,Math.min(1.15,referenceSeconds/originalSeconds));
      const samples=stretchSamples(cn.samples.subarray(part.start,part.end),cn.sampleRate,factor);
      const afterSeconds=samples.length/cn.sampleRate,deltaSeconds=afterSeconds-referenceSeconds;
      const status:PartAlignmentStatus=Math.abs(deltaSeconds)<=1/cn.sampleRate?'correct':Math.abs(deltaSeconds)<=.3+1/cn.sampleRate?'warning':'error';
      meta.parts.push({index:index+1,status,originalSeconds,referenceSeconds,factor,afterSeconds,deltaSeconds,pass:status!=='error',suggestion:status==='correct'?'保持':deltaSeconds<0?'本段可自然增加表达或调整断句':'本段可精简表达或调整断句'});
      return samples;
    });
    const layout=layoutPartTimeline(jp,j,cn.sampleRate,bodies);
    if(!layout)return {audio:generated,meta:{...meta,reason:`${requiredParts}段正文装入后无法让每处内部停顿保持250ms`}};
    meta.gapsSeconds=layout.gapsSeconds;meta.gapSeconds=layout.gapsSeconds[0];
    meta.splitRegions=partSplitRegions(layout.leadingSeconds,bodies,cn.sampleRate,layout.gapsSeconds,meta.parts.map(p=>p.factor));
    meta.pass=meta.parts.every(p=>p.pass);meta.status=!meta.pass?'error':meta.parts.some(p=>p.status==='warning')?'warning':'correct';
    meta.reason=meta.status==='correct'?'缩放后各段对齐':meta.status==='warning'?'缩放后仍有余差，但每段不超过300ms':'缩放后仍有段落余差超过300ms';
    return {audio:encodeWavMono(cn.sampleRate,layout.samples),meta};
}
/** 手动 Zero-shot 与普通对话的最终编辑共用：两边实际波形同为两段或三段才分段缩放。
 * 日文使用当前句完整原声，不使用邻句音色参考，也不把 TTS 补尾静音计入目标。
 * 中文段数不符则返回 null，沿用各调用方原流程；已命中但逐段不合格，保留错误元数据，
 * 不再整体缩放掩盖差异。本入口不调用 ASR 或大模型，不删情绪/环境音。
 */
export function alignZeroShotParts(generated: Buffer, fullJapanese: Buffer) {
    const required=speechChunks(fullJapanese,TWO_PART_JP_GAP_S).chunks.length;
    if(![2,3].includes(required)||speechChunks(generated).chunks.length!==required)return null;
    return alignParts(generated, fullJapanese);
}
/** 最终成品总长容差；与逐段300ms警告、85%～115%缩放规则分别判断。 */
export const ASSEMBLY_LENGTH_TOLERANCE_S = 0.05;
export function assemblyLengthPass(actual: number, target: number) {
    return Number.isFinite(actual) && Number.isFinite(target)
        && Math.abs(actual - target) <= ASSEMBLY_LENGTH_TOLERANCE_S + 1e-9;
}
/** 最终组装仍尽量与原JP解码后等长，允许正负50ms的成品误差。
 * 警告只是“逐段余差<=300ms”；如果无法保留正文并组装成等长，必须升级错误。
 * 只分配已有声音之间的静音，不截正文、不改情绪原声、不再次整体拉伸。
 */
export class PartAssemblyError extends Error {
    readonly code = "TWO_PARTS_ASSEMBLY_ERROR";
    constructor(message: string) { super(message); this.name = "PartAssemblyError"; }
}
/** 已有停顿可能装在正文切片里，先暴露真实>=250ms静音，不能凭字轴造空白。 */
function exposeBodySilences(segments: splice.MixSeg[]): splice.MixSeg[] {
    return segments.flatMap(segment => {
        if (segment.kind !== "speech") return [segment];
        const { wave, chunks } = speechChunks(segment.buffer, .25);
        if (!chunks.length) return [segment];
        const gaps = [
            { start: 0, end: chunks[0].start },
            ...chunks.slice(1).map((chunk, index) => ({ start: chunks[index].end, end: chunk.start })),
            { start: chunks[chunks.length - 1].end, end: wave.samples.length },
        ].filter(gap => gap.end - gap.start >= Math.ceil(.25 * wave.sampleRate));
        if (!gaps.length) return [segment];
        const parts: splice.MixSeg[] = [];
        let cursor = 0;
        const append = (end: number, kind: string) => {
            if (end <= cursor) return;
            const duration = (end - cursor) / wave.sampleRate;
            parts.push({ ...segment, id: `${segment.id}-${parts.length}`, kind, duration,
                buffer: splice.sliceWav(segment.buffer, cursor / wave.sampleRate, end / wave.sampleRate),
                ...(kind === "silence" ? { origDuration: duration } : {}) });
            cursor = end;
        };
        for (const gap of gaps) { append(gap.start, "speech"); append(gap.end, "silence"); }
        append(wave.samples.length, "speech");
        return parts;
    });
}
export function assembleParts(jp: Buffer, cn: Buffer, plan: OnoPlan, pieces: SplicePiece[], _target: number, reference: Buffer, splitRegions: SpeechSplitRegion[] = []) {
    const jd = decodeWavMono(jp), target = jd.samples.length / jd.sampleRate;
    if (!plan.enabled) {
        const {wave:cd,chunks:c}=speechChunks(cn, .25, splitRegions),j=speechChunks(jp,TWO_PART_JP_GAP_S).chunks,ref=speechChunks(reference,TWO_PART_JP_GAP_S).chunks;
        if(![2,3].includes(ref.length)||j.length!==ref.length||c.length!==ref.length)throw new PartAssemblyError("最终组装缺少对应的两/三段结构");
        const layout=layoutPartTimeline(jd,j,cd.sampleRate,c.map(p=>cd.samples.subarray(p.start,p.end)));
        if(!layout)throw new PartAssemblyError("各段虽可能只有警告，但等长组装后无法每处保留250ms静音，升级错误");
        const actual=layout.samples.length/cd.sampleRate;
        const outputRegions=partSplitRegions(layout.leadingSeconds,c.map(p=>cd.samples.subarray(p.start,p.end)),cd.sampleRate,layout.gapsSeconds,c.map(p=>splitRegions.find(r=>(p.start+p.end)/2/cd.sampleRate>=r.startSeconds && (p.start+p.end)/2/cd.sampleRate<=r.endSeconds)?.factor??1));
        return {audio:encodeWavMono(cd.sampleRate,layout.samples),ok:true,fit:{version:ref.length===3?'three-parts-exact-assembly-v1':'two-parts-exact-assembly-v1',target,actual_s:actual,wav_s:actual,scales:{body:1},splitRegions:outputRegions,middle_s:layout.gapsSeconds.reduce((n,x)=>n+x,0),gaps_s:layout.gapsSeconds}};
    }
    // 拟声原声与正文均不缩放；剩余总时长只分配给两者之间的静音。
    let segments = splice.mixSegments(jp, cn, plan, pieces, target);
    // 无独立静音段且偏短时，仍可使用正文内部已有的真实留白补齐。
    if (!segments.some(x => x.kind === "silence")
        && segments.reduce((sum, x) => sum + x.duration, 0) < target - ASSEMBLY_LENGTH_TOLERANCE_S)
        segments = exposeBodySilences(segments);
    const silences = segments.filter(x => x.kind === 'silence');
    const actual = segments.reduce((sum, x) => sum + x.duration, 0);
    const oldSilence = silences.reduce((sum, x) => sum + x.duration, 0), wanted = oldSilence + target - actual;
    // 情绪与正文相接时可能没有独立静音段；微小长短偏差不能因此丢掉情绪原声。
    // 有可分配静音仍优先凑齐；连全部静音拿掉也装不下时，只允许50ms内保留原拼装。
    if ((wanted < 0 || !silences.length) && !assemblyLengthPass(actual, target))
        throw new PartAssemblyError("正文和保留原声无法装入原音频总长（容差50ms），升级错误并重新改稿");
    const fitSilence = silences.length > 0 && oldSilence > 0 && wanted >= 0;
    if (fitSilence) {
        for (const x of silences) {
            x.duration = wanted * x.duration / oldSilence;
            x.buffer = splice.silenceWav(decodeWavMono(x.buffer).sampleRate, x.duration);
        }
    }
    let audio = splice.concatWavs(segments.map(x => x.buffer), 0), decoded = decodeWavMono(audio);
    // 不同采样率逐段取整可能累计几个采样，只修正最后一段内部静音的取整，绝不截声音。
    const targetFrames = Math.round(target * decoded.sampleRate), difference = targetFrames - decoded.samples.length;
    if (difference && fitSilence) {
        const last = silences[silences.length - 1], sr = decodeWavMono(last.buffer).sampleRate;
        last.duration += difference / decoded.sampleRate;
        if (last.duration <= 0)
            throw new PartAssemblyError("静音间隔无法容纳采样舍入修正");
        last.buffer = splice.silenceWav(sr, last.duration);
        audio = splice.concatWavs(segments.map(x => x.buffer), 0);
        decoded = decodeWavMono(audio);
    }
    const seconds = decoded.samples.length / decoded.sampleRate;
    if (!assemblyLengthPass(seconds, target))
        throw new PartAssemblyError("最终文件与日文原音频总长误差超过50ms，升级错误");
    return { audio, ok: true, fit: { version: "emotion-exact-silence-assembly-v1", target, actual_s: seconds, wav_s: seconds,
            tolerance_s: ASSEMBLY_LENGTH_TOLERANCE_S, delta_s: seconds - target,
            scales: Object.fromEntries(segments.map(x => [x.id, 1])), segments: segments.map(x => ({ id: x.id, kind: x.kind, packed_s: x.duration, scale: 1 })) } };
}
