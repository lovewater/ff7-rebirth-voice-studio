import { singleInternalGap } from "./gap-only-align";
import { decodeWavMono, encodeWavMono, stretchSamples } from "./wav-stretch";
import * as splice from "./audio-splice";
import type { OnoPlan, SplicePiece } from "./auto-run-onomatopoeia";
/** 两段正文时序状态（与列表通用语速/拍数报警是不同指标）：
 * correct 正确：85%～115%缩放后两段分别对齐，仅容许一个采样的舍入误差。
 * warning 警告：无法完全对齐，但任一段的绝对余差都<=300ms；仍是可用候选。
 * error 错误：任一段余差>300ms、不是恰好两段，或拼装装不下250ms中间静音、最终不能与原音频等长。
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
    reason?: string;
};
/** 入口只看删拟声/环境音且裁首尾后的实际JP参考：恰好一处>=350ms长停顿。
 * 中文需恰好两段（长停顿识别250ms）；按两段分别缩放，再恢复首尾与中间留白。
 * 总长度凑齐不是逐段合格的证据，因此即使拼成总长相等，仍必须看各段余差。
 * 返回null=不适用；返回status:error=已进入线路但失败，不能偷回旧整体拉伸掩盖错误。
 */
export function alignParts(generated: Buffer, reference: Buffer) {
    const jp = decodeWavMono(reference), cn = decodeWavMono(generated), j = singleInternalGap(jp, .35), c = singleInternalGap(cn);
    if (!j)
        return null; // 正文参考不具备两节特征，不能强行制造两节。
    const meta: PartAlignmentMeta = { version: 'two-parts-v1', status: 'error', pass: false, lo: .85, hi: 1.15, toleranceSeconds: .3, parts: [] };
    if (!c)
        return { audio: generated, meta: { ...meta, reason: '中文不是恰好两节' } };
    const ranges = [[c.start, c.gapStart, j.start, j.gapStart], [c.gapEnd, c.end, j.gapEnd, j.end]];
    const bodies = ranges.map(([a, b, x, y], index) => {
        const originalSeconds = (b - a) / cn.sampleRate, referenceSeconds = (y - x) / jp.sampleRate;
        const factor = Math.max(.85, Math.min(1.15, referenceSeconds / originalSeconds));
        const samples = stretchSamples(cn.samples.subarray(a, b), cn.sampleRate, factor);
        // 测实际输出采样数，不能只用期望factor推断；WSOLA可能对极短输入保持原样。
        const afterSeconds = samples.length / cn.sampleRate, deltaSeconds = afterSeconds - referenceSeconds;
        // “正确”只容许采样舍入误差；不是把300ms以内统称为正确。
        const status = Math.abs(deltaSeconds) <= 1 / cn.sampleRate ? 'correct' : Math.abs(deltaSeconds) <= .3 + 1 / cn.sampleRate ? 'warning' : 'error';
        meta.parts.push({ index: index + 1, status, originalSeconds, referenceSeconds, factor, afterSeconds, deltaSeconds,
            pass: Math.abs(deltaSeconds) <= .3 + 1 / cn.sampleRate,
            suggestion: Math.abs(deltaSeconds) <= 1 / cn.sampleRate ? '保持' : deltaSeconds < 0 ? '本段可自然增加表达或调整断句' : '本段可精简表达或调整断句' });
        return samples;
    });
    const cv = (n: number) => Math.round(n * cn.sampleRate / jp.sampleRate);
    const total = cv(jp.samples.length), leading = cv(j.start), trailing = cv(jp.samples.length - j.end);
    const middle = total - leading - trailing - bodies[0].length - bodies[1].length;
    meta.gapSeconds = middle / cn.sampleRate;
    // 入口日文长停顿>=350ms；拼装最小间隔仍是250ms，两个阈值用途不同。
    // 即使两节均在300ms内，也不能把原有长停顿挤没或裁掉正文。
    if (middle < Math.ceil(.25 * cn.sampleRate))
        return { audio: generated, meta: { ...meta, reason: '两段正文装入后无法保留250ms中间停顿' } };
    const out = new Float32Array(total);
    out.set(bodies[0], leading);
    out.set(bodies[1], leading + bodies[0].length + middle);
    meta.pass = meta.parts.every(p => p.pass);
    meta.status = !meta.pass ? 'error' : meta.parts.some(p => p.status === 'warning') ? 'warning' : 'correct';
    meta.reason = meta.status === 'correct' ? '缩放后各段对齐' : meta.status === 'warning' ? '缩放后仍有余差，但每段不超过300ms' : '缩放后仍有段落余差超过300ms';
    return { audio: encodeWavMono(cn.sampleRate, out), meta };
}
/** 最终组装硬门槛：与原JP解码后等长（允许一个采样的舍入误差）。
 * 警告只是“逐段余差<=300ms”；如果无法保留正文并组装成等长，必须升级错误。
 * 只分配已有声音之间的静音，不截正文、不改情绪原声、不再次整体拉伸。
 */
export class PartAssemblyError extends Error {
    readonly code = "TWO_PARTS_ASSEMBLY_ERROR";
    constructor(message: string) { super(message); this.name = "PartAssemblyError"; }
}
export function assembleParts(jp: Buffer, cn: Buffer, plan: OnoPlan, pieces: SplicePiece[], _target: number, reference: Buffer) {
    const jd = decodeWavMono(jp), target = jd.samples.length / jd.sampleRate;
    if (!plan.enabled) {
        const cd = decodeWavMono(cn), rd = decodeWavMono(reference);
        const geometry = singleInternalGap(jd, .35), rg = singleInternalGap(rd, .35), cg = singleInternalGap(cd);
        if (!geometry || !rg || !cg)
            throw new PartAssemblyError("最终组装缺少两段结构");
        const cv = (n: number) => Math.round(n * cd.sampleRate / jd.sampleRate);
        const total = cv(jd.samples.length), lead = cv(geometry.start), tail = cv(jd.samples.length - geometry.end);
        const first = cd.samples.subarray(cg.start, cg.gapStart), second = cd.samples.subarray(cg.gapEnd, cg.end);
        const middle = total - lead - tail - first.length - second.length;
        if (middle < Math.ceil(.25 * cd.sampleRate))
            throw new PartAssemblyError("两段虽可能只有警告，但组装等长后内部静音不足250ms，升级错误");
        const out = new Float32Array(total);
        out.set(first, lead);
        out.set(second, lead + first.length + middle);
        const audio = encodeWavMono(cd.sampleRate, out), actual = out.length / cd.sampleRate;
        return { audio, ok: true, fit: { version: "two-parts-exact-assembly-v1", target, actual_s: actual, wav_s: actual, scales: { body: 1 }, middle_s: middle / cd.sampleRate } };
    }
    // 拟声原声与正文均不缩放；剩余总时长只分配给两者之间的静音。
    const segments = splice.mixSegments(jp, cn, plan, pieces, target);
    const silences = segments.filter(x => x.kind === 'silence');
    const actual = segments.reduce((sum, x) => sum + x.duration, 0);
    const oldSilence = silences.reduce((sum, x) => sum + x.duration, 0), wanted = oldSilence + target - actual;
    if (wanted < 0 || (!silences.length && Math.abs(actual - target) > 1 / jd.sampleRate))
        throw new PartAssemblyError("正文和保留原声无法装入原音频总长，升级错误并重新改稿");
    if (silences.length && oldSilence > 0) {
        for (const x of silences) {
            x.duration = wanted * x.duration / oldSilence;
            x.buffer = splice.silenceWav(decodeWavMono(x.buffer).sampleRate, x.duration);
        }
    }
    let audio = splice.concatWavs(segments.map(x => x.buffer), 0), decoded = decodeWavMono(audio);
    // 不同采样率逐段取整可能累计几个采样，只修正最后一段内部静音的取整，绝不截声音。
    const targetFrames = Math.round(target * decoded.sampleRate), difference = targetFrames - decoded.samples.length;
    if (difference && silences.length) {
        const last = silences[silences.length - 1], sr = decodeWavMono(last.buffer).sampleRate;
        last.duration += difference / decoded.sampleRate;
        if (last.duration <= 0)
            throw new PartAssemblyError("静音间隔无法容纳采样舍入修正");
        last.buffer = splice.silenceWav(sr, last.duration);
        audio = splice.concatWavs(segments.map(x => x.buffer), 0);
        decoded = decodeWavMono(audio);
    }
    if (Math.abs(decoded.samples.length - targetFrames) > 1)
        throw new PartAssemblyError("最终文件未能与日文原音频等长，升级错误");
    const seconds = decoded.samples.length / decoded.sampleRate;
    return { audio, ok: true, fit: { version: "emotion-exact-silence-assembly-v1", target, actual_s: seconds, wav_s: seconds,
            scales: Object.fromEntries(segments.map(x => [x.id, 1])), segments: segments.map(x => ({ id: x.id, kind: x.kind, packed_s: x.duration, scale: 1 })) } };
}
