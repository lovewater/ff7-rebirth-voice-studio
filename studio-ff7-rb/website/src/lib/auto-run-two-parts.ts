import { AsyncLocalStorage } from "node:async_hooks";
import { singleInternalGap } from "./gap-only-align";
import { decodeWavMono } from "./wav-stretch";
import { rewriteChat, parseJsonObject } from "./auto-run-llm";
import { spliceMix } from "./audio-splice";
import { assembleParts, type PartAlignmentMeta } from "./auto-run-part-alignment";
import type { OnoPlan, SplicePiece } from "./auto-run-onomatopoeia";
import type { SeedAsrResult } from "./seed-asr";
import type { PromptMessage } from "./prompt-template";
type Geometry = NonNullable<ReturnType<typeof waveGeometry>>;
type Measurement = {
    ttsId: string;
    script: string;
    parts: number;
    wave?: Geometry;
    secondOpenDeltaS?: number;
    firstDurationDeltaS?: number;
    secondDurationDeltaS?: number;
    score?: number;
};
type MeaningAnchor = {
    japanese: string;
    chinese: string;
    earliestDialogue?: {
        japanese: string;
        chinese: string;
    }[];
};
type Context = {
    required: boolean;
    candidates: Map<string, Measurement>;
    reference?: Geometry | null;
    textJp?: string;
    jpChunks?: string[];
    preserved?: unknown[];
    meaningAnchor?: MeaningAnchor;
};
// 每条句子使用独立异步上下文，四并发不会串日文参考、旧稿、情绪恢复或中心意思。
const contexts = new AsyncLocalStorage<Context>();
export function withTwoPartContext<T>(fn: () => T): T { return contexts.run({ required: false, candidates: new Map() }, fn); }
/** 10ms窗内全部采样<峰值5%才是静音；默认250ms用于中文/最终结构，入口JP传350ms。
 * 首尾静音不计；零处/多处长停顿都不作为“两段正文”。不按标点数量判断段数。
 */
export function countParts(buffer: Buffer, minimumSeconds = .25) {
    const { samples, sampleRate } = decodeWavMono(buffer);
    let peak = 0;
    for (const x of samples)
        peak = Math.max(peak, Math.abs(x));
    if (peak <= 1e-8)
        return 0;
    const threshold = peak * .05, hop = Math.max(1, Math.round(sampleRate * .01)), minimum = Math.ceil(sampleRate * minimumSeconds);
    let start = 0, end = samples.length;
    while (start < end && Math.abs(samples[start]) < threshold)
        start++;
    while (end > start && Math.abs(samples[end - 1]) < threshold)
        end--;
    let quietStart: number | null = null, gaps = 0;
    for (let at = Math.floor(start / hop) * hop; at < end + hop; at += hop) {
        let quiet = at < samples.length;
        for (let i = at; i < Math.min(at + hop, samples.length); i++)
            if (Math.abs(samples[i]) >= threshold) {
                quiet = false;
                break;
            }
        if (quiet && quietStart === null)
            quietStart = at;
        if (!quiet && quietStart !== null) {
            if (at - quietStart >= minimum && quietStart > start && at < end)
                gaps++;
            quietStart = null;
        }
    }
    return gaps + 1;
}
export function waveGeometry(buffer: Buffer, minimumSeconds = .25) {
    const d = decodeWavMono(buffer), g = singleInternalGap(d, minimumSeconds);
    if (!g)
        return null;
    return { firstSeconds: (g.gapStart - g.start) / d.sampleRate, secondSeconds: (g.end - g.gapEnd) / d.sampleRate,
        secondOpenSeconds: (g.gapEnd - g.start) / d.sampleRate, gapSeconds: (g.gapEnd - g.gapStart) / d.sampleRate,
        gapStartSeconds: g.gapStart / d.sampleRate, gapEndSeconds: g.gapEnd / d.sampleRate };
}
export function setMeaningAnchor(anchor: MeaningAnchor) {
    const c = contexts.getStore();
    if (c)
        c.meaningAnchor = structuredClone(anchor);
}
export function setReference(audio: Buffer, asr: SeedAsrResult, textJp: string, plan: OnoPlan) {
    const c = contexts.getStore();
    if (!c)
        throw Error("两段线路缺少独立上下文");
    c.reference = waveGeometry(audio, .35);
    c.required = !!c.reference;
    c.textJp = textJp;
    c.preserved = plan.subtitleRestore.preserved;
    if (c.reference && asr.words?.length) {
        const split = (c.reference.gapStartSeconds + c.reference.gapEndSeconds) * 500;
        c.jpChunks = [asr.words.filter(w => (w.start + w.end) / 2 < split).map(w => w.text).join(''), asr.words.filter(w => (w.start + w.end) / 2 >= split).map(w => w.text).join('')];
    }
}
export function rememberRhythm(id: string, audio: Buffer, script: string) {
    const c = contexts.getStore();
    if (!c?.reference)
        return;
    const wave = waveGeometry(audio);
    if (!wave) {
        c.candidates.set(String(id), { ttsId: String(id), script, parts: countParts(audio) });
        return;
    }
    const ref = c.reference, opening = wave.secondOpenSeconds - ref.secondOpenSeconds, first = wave.firstSeconds - ref.firstSeconds, second = wave.secondSeconds - ref.secondSeconds;
    c.candidates.set(String(id), { ttsId: String(id), script, parts: 2, wave, secondOpenDeltaS: opening, firstDurationDeltaS: first, secondDurationDeltaS: second, score: Math.max(Math.abs(opening), Math.abs(first), Math.abs(second)) });
}
export function rankByRhythm<T extends {
    clip: {
        id: string;
    };
}>(items: T[]) {
    const c = contexts.getStore();
    if (!c?.required || !items.length)
        return { items, metrics: { enabled: false } };
    const ranked = items.map(item => ({ item, metric: c.candidates.get(String(item.clip.id)) }));
    if (ranked.some(x => !Number.isFinite(x.metric?.score)))
        return { items, metrics: { enabled: false, reason: '缺少测量，保持原择优' } };
    ranked.sort((a, b) => a.metric!.score! - b.metric!.score!);
    const best = ranked[0].metric!.score!;
    return { items: ranked.filter(x => x.metric!.score! <= best + .05).map(x => x.item), metrics: { enabled: true, bestScoreS: best, nearTieSlackS: .05, reference: c.reference, candidates: ranked.map(x => x.metric) } };
}
export function alignmentCheck(clip: {
    conversion_meta?: {
        auto_run_gap_alignment?: PartAlignmentMeta;
    } | null;
}) {
    const meta = clip.conversion_meta?.auto_run_gap_alignment;
    if (meta?.version === 'two-parts-v1')
        return meta;
    const required = contexts.getStore()?.required;
    return { pass: !required, status: required ? 'error' as const : 'correct' as const, reason: required ? '缺少逐段检查记录' : '参考不是两段正文，沿用原线路' };
}
export function inspectFinal(audio: Buffer, required: boolean) { const parts = countParts(audio); return { required: required ? 2 : null, actual: parts, pass: !required || parts === 2 }; }
export function assemblePreserved(jp: Buffer, cn: Buffer, plan: OnoPlan, pieces: SplicePiece[], target: number, reference: Buffer) {
    if (!contexts.getStore()?.required && !plan.enabled)
        return spliceMix(jp, cn, plan, pieces, target);
    return assembleParts(jp, cn, plan, pieces, target, reference);
}
/** 每轮固定重发原日中字幕与最初前文，历史改稿不能取代原意。
 * JP分节使用已有Seed轴，不额外付费；不提供日文分段字/拍数或中文分段字数配额。
 */
export function performanceRewriteMessages(messages: PromptMessage[], task: string): PromptMessage[] {
    const c = contexts.getStore();
    if (!c)
        return messages;
    if (!['script-rewrite', 'fallback-duration-rewrite', 'two-parts-repair', 'rhythm-pick'].includes(task))
        return messages;
    const extra: PromptMessage[] = [];
    if (c.meaningAnchor && task !== 'rhythm-pick')
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.meaning-anchor', promptValues: { input_json: JSON.stringify(c.meaningAnchor) } });
    if (c.preserved?.length && task !== 'rhythm-pick')
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.preserved-emotion', promptValues: { input_json: JSON.stringify(c.preserved) } });
    if (c.required)
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.rhythm-context', promptValues: { input_json: JSON.stringify({ reference: c.reference, jpChunks: c.jpChunks, textJp: c.textJp, candidateMeasurements: [...c.candidates.values()].slice(-6) }) } });
    return [...messages, ...extra];
}
export async function repairTwoParts(input: {
    stem: string;
    script: string;
    textJp: string;
    textEn: string;
    referenceAudio: Buffer;
    round: number;
    history: unknown[];
    allowRewrite?: boolean;
    feedback?: string;
    beatEvidence?: unknown[];
}) {
    const d = decodeWavMono(input.referenceAudio), gap = singleInternalGap(d, .35);
    const data = { current: input.script, textJp: input.textJp, textEn: input.textEn, round: input.round, previousAttempts: input.history, beatEvidence: input.beatEvidence,
        requiredParts: countParts(input.referenceAudio, .35), allowRewrite: !!input.allowRewrite, feedback: input.feedback || '前次结构或分段余差不合格，请根据各段测量优先调整自然断句，必要时按允许范围调整表达。',
        pause: gap ? { startS: gap.gapStart / d.sampleRate, endS: gap.gapEnd / d.sampleRate } : null };
    const messages: PromptMessage[] = [{ role: 'system', content: '', promptKey: 'two-parts.repair-system', promptValues: {} }, { role: 'user', content: '', promptKey: 'two-parts.repair-input', promptValues: { input_json: JSON.stringify(data) } }];
    if (/[2２]/u.test(input.script))
        messages.push({ role: 'user', content: '', promptKey: 'rewrite.number-two', promptValues: {} });
    const result = await rewriteChat(messages, .2, 'two-parts-repair', 3, { modelId: 'volcengine', stem: input.stem });
    const parsed = parseJsonObject(result.content), script = parsed.spoken_text;
    const compact = (x: string) => x.replace(/[\p{P}\p{Z}\s]/gu, '');
    if (typeof script !== 'string' || !compact(script))
        throw Error('模型未返回有效朗读稿');
    if (!input.allowRewrite && compact(script) !== compact(input.script))
        throw Error('仅调整标点时不得改动正文字符');
    // 不检查分隔符种类或数量，中文是否两段只看下一次真实合成波形。
    return script;
}
