import { fastLongPromptValues } from "./fast-long-pressure";
import { NATURAL_PUNCTUATION_HINT } from "./rewrite-punctuation-hint";
import { rewriteEditInstruction } from "./rewrite-edit-policy";
import { calculateAttemptFeedback, renderAttemptFeedback, type AttemptInput } from "./attempt-feedback";
import { speechChunks, type SpeechSplitRegion } from "./speech-segments";
import { validBodyScript, scriptFromPolicyParts, type BodyScriptPolicy } from "./two-part-script";
import { TWO_PART_JP_GAP_S } from "./gap-only-align";
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
    requiredParts?: number;
    scriptPolicy?: BodyScriptPolicy;
    candidates: Map<string, Measurement>;
    attempts: Map<string, AttemptInput>;
    reference?: Geometry | null;
    textJp?: string;
    jpChunks?: string[];
    preserved?: unknown[];
    meaningAnchor?: MeaningAnchor;
};
// 每条句子使用独立异步上下文，四并发不会串日文参考、旧稿、情绪恢复或中心意思。
const contexts = new AsyncLocalStorage<Context>();
/** 每批合成前更新，AsyncLocalStorage隔离并发句子；不影响其他自动任务。 */
export function setBodyScriptPolicy(policy:BodyScriptPolicy){const c=contexts.getStore();if(c)c.scriptPolicy=policy;}
export function withTwoPartContext<T>(fn: () => T): T { return contexts.run({ required: false, candidates: new Map(), attempts: new Map() }, fn); }
/** 每个音频只更新自己的记录。稿ID来自实际朗读稿，四并发隔离，禁止继承旧稿测量。 */
export function rememberAttempt(input: AttemptInput) {
    const c = contexts.getStore();
    if (!c || !input.measurement) return null;
    const previous=[...c.attempts.values()].find(a=>a.draftId===input.draftId);
    const bound=previous?{...input,script:previous.script}:input;
    c.attempts.set(input.measurement.audioId, structuredClone(bound));
    return calculateAttemptFeedback(bound);
}
export function hasAttemptHistory() { return !!contexts.getStore()?.attempts.size; }
export function attemptHistoryText() {
    const c = contexts.getStore();
    return c?.attempts.size ? renderAttemptFeedback([...c.attempts.values()].map(calculateAttemptFeedback)) : "";
}
/** 10ms窗内全部采样<峰值5%才是静音；默认250ms用于中文/最终结构，入口JP传500ms。
 * 首尾静音不计；零处/多处长停顿都不作为“两段正文”。不按标点数量判断段数。
 */
export function countParts(buffer: Buffer, minimumSeconds = .25, splitRegions: SpeechSplitRegion[] = []) {
    return speechChunks(buffer, minimumSeconds, splitRegions).chunks.length;
}
export function waveGeometry(buffer: Buffer, minimumSeconds = .25, splitRegions: SpeechSplitRegion[] = []) {
    const {wave:d,chunks}=speechChunks(buffer,minimumSeconds,splitRegions);
    if(![2,3].includes(chunks.length))return null;
    const start=chunks[0].start/d.sampleRate;
    const parts=chunks.map((p,index)=>({index:index+1,startSeconds:p.start/d.sampleRate,endSeconds:p.end/d.sampleRate,durationSeconds:(p.end-p.start)/d.sampleRate,openingSeconds:p.start/d.sampleRate-start}));
    const gaps=chunks.slice(1).map((p,i)=>({startSeconds:chunks[i].end/d.sampleRate,endSeconds:p.start/d.sampleRate,durationSeconds:(p.start-chunks[i].end)/d.sampleRate}));
    return {requiredParts:chunks.length,parts,gaps,firstSeconds:parts[0].durationSeconds,secondSeconds:parts[1].durationSeconds,secondOpenSeconds:parts[1].openingSeconds,gapSeconds:gaps[0].durationSeconds,gapStartSeconds:gaps[0].startSeconds,gapEndSeconds:gaps[0].endSeconds};
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
    c.reference = waveGeometry(audio, TWO_PART_JP_GAP_S);
    c.required = !!c.reference;
    c.requiredParts=c.reference?.requiredParts;
    c.textJp = textJp;
    c.preserved = plan.subtitleRestore.preserved;
    if (c.reference && asr.words?.length) {
        const boundaries=c.reference.gaps.map(g=>(g.startSeconds+g.endSeconds)*500);
        c.jpChunks=Array.from({length:c.reference.requiredParts},(_,index)=>asr.words.filter(w=>{const middle=(w.start+w.end)/2;return (index===0||middle>=boundaries[index-1])&&(index===boundaries.length||middle<boundaries[index]);}).map(w=>w.text).join(''));
    }
}
export function rememberRhythm(id: string, audio: Buffer, script: string, splitRegions: SpeechSplitRegion[] = []) {
    const c = contexts.getStore();
    if (!c?.reference)
        return;
    const wave = waveGeometry(audio, .25, splitRegions);
    if (!wave || wave.requiredParts!==c.reference.requiredParts) {
        c.candidates.set(String(id), { ttsId: String(id), script, parts: countParts(audio, .25, splitRegions) });
        return;
    }
    const ref = c.reference, opening = wave.secondOpenSeconds - ref.secondOpenSeconds, first = wave.firstSeconds - ref.firstSeconds, second = wave.secondSeconds - ref.secondSeconds;
    c.candidates.set(String(id), { ttsId: String(id), script, parts: wave.requiredParts, wave, secondOpenDeltaS: opening, firstDurationDeltaS: first, secondDurationDeltaS: second, score: Math.max(...wave.parts.flatMap((p,i)=>[Math.abs(p.durationSeconds-ref.parts[i].durationSeconds),Math.abs(p.openingSeconds-ref.parts[i].openingSeconds)])) });
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
    if (meta?.version === 'two-parts-v1' || meta?.version === 'three-parts-v1')
        return meta;
    const required = contexts.getStore()?.required;
    return { pass: !required, status: required ? 'error' as const : 'correct' as const, reason: required ? '缺少逐段检查记录' : '参考不是两段正文，沿用原线路' };
}
export function inspectFinal(audio: Buffer, required: boolean|number, splitRegions: SpeechSplitRegion[] = []) { const parts=countParts(audio, .25, splitRegions),wanted=required===true?2:required||null;return {required:wanted,actual:parts,pass:!wanted||parts===wanted}; }
export function assemblePreserved(jp: Buffer, cn: Buffer, plan: OnoPlan, pieces: SplicePiece[], target: number, reference: Buffer, splitRegions: SpeechSplitRegion[] = []) {
    // 环境音不等于保留情绪：单段正文+环境音沿用整句编辑，允许最终正文轻微缩放。
    // 只有真实两/三段或需要保留情绪原声时，才用逐段/情绪严格等长装配。
    if (!contexts.getStore()?.required && !plan.onomatopoeia.length)
        return spliceMix(jp, cn, plan, pieces, target);
    return assembleParts(jp, cn, plan, pieces, target, reference, splitRegions);
}
/** 每轮固定重发原日中字幕与最初前文，历史改稿不能取代原意。
 * JP分节使用已有Seed轴，不额外付费；不提供日文分段字/拍数或中文分段字数配额。
 */
export function performanceRewriteMessages(messages: PromptMessage[], task: string): PromptMessage[] {
    const c = contexts.getStore();
    if (!c)
        return messages;
    if (!['script-rewrite', 'fallback-duration-rewrite', 'two-parts-repair', 'three-parts-repair', 'rhythm-pick'].includes(task))
        return messages;
    const extra: PromptMessage[] = [];
    if(task!=="rhythm-pick")extra.push({role:"user",content:"",promptKey:"rewrite.chinese-speed-limit",promptValues:{}});
    if(task!=="rhythm-pick")extra.push({role:"user",content:"",promptKey:"rewrite.fast-long-pressure",promptValues:fastLongPromptValues()});
    if (c.meaningAnchor && task !== 'rhythm-pick')
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.meaning-anchor', promptValues: { input_json: JSON.stringify(c.meaningAnchor) } });
    if (c.preserved?.length && task !== 'rhythm-pick')
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.preserved-emotion', promptValues: { input_json: JSON.stringify(c.preserved) } });
    if (c.required)
        extra.push({ role: 'user', content: '', promptKey: 'two-parts.rhythm-context', promptValues: { input_json: JSON.stringify({ requiredParts:c.requiredParts, scriptPolicy:c.scriptPolicy??"strict", reference: c.reference, jpChunks: c.jpChunks, textJp: c.textJp, candidateMeasurements: task === "rhythm-pick" ? [...c.candidates.values()].slice(-6) : [] }) } });
    if (task !== "rhythm-pick" && c.attempts.size)
        extra.push({role:"user",content:"",promptKey:"rewrite.attempt-history",promptValues:{history_text:attemptHistoryText()}});
    if (task !== "rhythm-pick") {
        let currentScript: string | undefined;
        let allowRewrite: boolean | undefined;
        for (const message of messages) {
            const json = message.promptValues?.input_json;
            if (typeof json !== "string") continue;
            try { const data = JSON.parse(json); if (typeof data.current === "string") currentScript = data.current; if (typeof data.allowRewrite === "boolean") allowRewrite = data.allowRewrite; } catch { /* 非结构化输入沿用上下文当前稿。 */ }
        }
        extra.push({role:"user",content:rewriteEditInstruction([...c.attempts.values()], currentScript, allowRewrite)+"\n\n"+NATURAL_PUNCTUATION_HINT});
    }
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
    const d = decodeWavMono(input.referenceAudio), geometry=waveGeometry(input.referenceAudio,TWO_PART_JP_GAP_S), gap = singleInternalGap(d, TWO_PART_JP_GAP_S);
    const data = { current: input.script, textJp: input.textJp, textEn: input.textEn, round: input.round, previousAttempts: hasAttemptHistory() ? undefined : input.history, beatEvidence: hasAttemptHistory() ? undefined : input.beatEvidence,
        scriptPolicy:contexts.getStore()?.scriptPolicy??"strict", requiredParts: geometry?.requiredParts ?? 1, allowRewrite: !!input.allowRewrite, feedback: input.feedback || '前次结构或分段余差不合格，请根据各段测量优先调整自然断句，必要时按允许范围调整表达。',
        referenceParts:geometry?.parts,referenceGaps:geometry?.gaps, pause: gap ? { startS: gap.gapStart / d.sampleRate, endS: gap.gapEnd / d.sampleRate } : null };
    const messages: PromptMessage[] = [{ role: 'system', content: '', promptKey: 'two-parts.repair-system', promptValues: {} }, { role: 'user', content: '', promptKey: 'two-parts.repair-input', promptValues: { input_json: JSON.stringify(data) } }];
    if (/[2２]/u.test(input.script))
        messages.push({ role: 'user', content: '', promptKey: 'rewrite.number-two', promptValues: {} });
    const result = await rewriteChat(messages, .2, data.requiredParts===3?'three-parts-repair':'two-parts-repair', 3, { stem: input.stem });
    const parsed = parseJsonObject(result.content);
    // strict清理片内停顿；lines/relaxed保留模型标点，换行是语义分组而非最终字幕布局。
    // 短句放开后允许直接返回spoken_text；长句必须按行，不用标点数量冒充行数。
    // 兼容普通改稿返回的text字段，但下方仍完整验证本轮分片协议、正文与allowRewrite。
    // 字段名差异不应直接消耗一整批TTS；内容/片数错误仍拒绝，不放宽语义规则。
    const script = [2,3].includes(data.requiredParts) ? scriptFromPolicyParts(parsed.parts,data.requiredParts,data.scriptPolicy) ?? parsed.spoken_text ?? parsed.text : parsed.spoken_text ?? parsed.text;
    const compact = (x: string) => x.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
    if (typeof script !== 'string' || !compact(script))
        throw Error('模型未返回有效朗读稿');
    if (!input.allowRewrite && compact(script) !== compact(input.script))
        throw Error(`仅调整标点时不得改动正文字符，应为：${compact(input.script)}；模型实际返回：${compact(script)}`);
    // 只限制当前线路的文本协议；实际音频仍独立检测，多段须Qwen校字后连续归组。
    if([2,3].includes(data.requiredParts) && !validBodyScript(script,data.requiredParts,data.scriptPolicy))throw Error(`朗读稿不满足${data.scriptPolicy}分片协议，目标${data.requiredParts}段`);
    return script;
}
