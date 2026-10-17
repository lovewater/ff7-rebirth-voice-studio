import { parseJsonObject, rewriteChat } from "./auto-run-llm";
import { alignJapaneseClauses, refinePerformanceBoundaries, type SegmentSpan } from "./speech-segmentation";
import type { SeedAsrResult } from "./seed-asr";

type Word = SeedAsrResult["words"][number];
export type FragmentDecision = {
  audio_blocks: number; missing_text_blocks: number;
  kind: "onomatopoeia" | "speech" | "ambient" | "unknown";
  matched_jp: string; matched_zh: string;
  before_word: number | null; after_word: number | null; reason: string;
};

/** 用真实字轴约束候选两侧的能量谷搜索；端点只作搜索界限，不伪造ASR。 */
function fragmentBoundaries(input: { samples: Float32Array; sampleRate: number; words: Word[] }, block: SegmentSpan, before: number | null, after: number | null) {
  const { words } = input;
  const left = before === null ? 0 : words[before].end;
  const right = after === null ? input.samples.length / input.sampleRate * 1000 : words[after].start;
  if (left >= right || block.startMs < left || block.endMs > right) return null;
  const boundary = (a: SegmentSpan, b: SegmentSpan) => refinePerformanceBoundaries({
    samples: input.samples, sampleRate: input.sampleRate, onomatopoeia: [], subtitleClauses: [a, b],
  }).adjustments[0];
  const leftCut = before === null ? null : boundary(
    { startMs: words[before].start, endMs: left },
    { startMs: Math.min(left + 180, block.startMs), endMs: block.endMs });
  const rightCut = after === null ? null : boundary(
    { startMs: block.startMs, endMs: Math.max(block.endMs, right - 180) },
    { startMs: right, endMs: words[after].end });
  if ([leftCut, rightCut].some(c => c?.reason === "no-clear-valley")) return null;
  return {
    leftCut: leftCut && { ...leftCut, rightEvidence: "unrecognized-fragment-search-bound" },
    rightCut: rightCut && { ...rightCut, leftEvidence: "unrecognized-fragment-search-bound" },
    right,
  };
}

/** 只寻找“可能漏识别的一块声音”，不判断缺了哪段字幕，更不把字轴空档当环境音。
 * 10ms 帧峰值须达到全局峰值5%；先给现有字轴两侧各留180ms容错，避免连读/尾音被切走。
 * 剩余声音中，间隔不足250ms视作同块；每块至少100ms实有声，静音不算一块。
 * 两块及以上直接降级，不能挑其中一块救。字轴严重漂移或贴连得无法独立定位时也不强猜。
 * 返回值仅供模型查看的候选范围，绝不是拟声的实际起止点。
 */
export function missingAudioBlocks(input: { samples: Float32Array; sampleRate: number; words: Word[] }): SegmentSpan[] {
  if (!(input.sampleRate > 0) || !input.samples.length || !input.words.length) return [];
  let peak = 0;
  for (const s of input.samples) peak = Math.max(peak, Math.abs(s));
  if (peak <= 1e-8) return [];
  const words = input.words.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  if (words.length !== input.words.length) return [];
  const frame = Math.max(1, Math.round(input.sampleRate * .01));
  const groups: (SegmentSpan & { voicedMs: number })[] = [];
  for (let i = 0; i < input.samples.length; i += frame) {
    const end = Math.min(i + frame, input.samples.length);
    const startMs = i / input.sampleRate * 1000, endMs = end / input.sampleRate * 1000;
    if (words.some(w => startMs < w.end + 180 && endMs > w.start - 180)) continue;
    let local = 0;
    for (let j = i; j < end; j++) local = Math.max(local, Math.abs(input.samples[j]));
    if (local < peak * .05) continue;
    const last = groups.at(-1);
    if (last && startMs - last.endMs < 250) {
      last.endMs = endMs; last.voicedMs += endMs - startMs;
    } else groups.push({ startMs, endMs, voicedMs: endMs - startMs });
  }
  return groups.filter(g => g.voicedMs >= 100).map(({ startMs, endMs }) => ({ startMs, endMs })).filter(block => {
    const before = words.findLastIndex(w => w.end <= block.startMs);
    const after = words.findIndex(w => w.start >= block.endMs);
    // 拖到字轴外的连续正文不是独立缺口：没有能量谷隔开时连候选也不建立。
    return fragmentBoundaries(input, block, before < 0 ? null : before, after < 0 ? null : after) !== null;
  });
}

/** 文本有没有缺、缺几块、是否恰好对应这一块声音，全部交模型作语义判断。
 * 不再用“删第一段再字符串比对”推断遗漏。模型没听音频，只能结合波形候选和字轴证据；
 * 不允许凭 ASR 漏字直接认定拟声。返回邻接字轴索引，程序从原字轴取时间，不接受模型猜毫秒。
 */
export function missingFragmentMessages(textJp: string, textZh: string, asr: SeedAsrResult, blocks: SegmentSpan[]) {
  const words = asr.words.length ? asr.words : asr.utterances.flatMap(u => u.words);
  return [{ role: "system" as const, content: [
    "你在检查游戏配音的一块疑似漏识别声音，它可能在句首、句中或句尾。",
    "程序提供波形中的有声候选区域和全部ASR字轴。请按语义及顺序比较原日文字幕与ASR，不要机械逐字比对：ASR可能有错字、同音字、拖音及误转写。",
    "例如字幕オレ、ASR俺，是同一个表示我的正文词的不同写法，不是漏掉的拟声。已有字轴但被误转写的正文，也不能当成完全缺失的拟声片段。",
    "先判断：声音是否只有一块未对应，字幕是否也恰好只有一块连续文本未被识别，其余正文能否按顺序可靠对应。不要把两块缺文合并成一块，不要为了凑数吞掉中间已识别正文。",
    "只有 audio_blocks=1 且 missing_text_blocks=1，并且这两块位置和前后顺序相互对应，才可以判为onomatopoeia。超过一块、不确定或无法一一对应，返回unknown；程序将直接fallback。",
    "拟声包括わあ～／哇、おお／哦哦、笑声、叹气、惊叫、呻吟等人声反应。漏掉的普通台词判speech，不能伪装成拟声。字幕没有缺失时missing_text_blocks=0，不能编造缺文或中文表达。",
    "ASR没字不代表静音或环境音。你没有听到音频，不要声称听到了某种声音；候选有声范围不是精确切口，也不一定全属同一种声音。",
    "matched_jp与matched_zh必须逐字复制各自原字幕中唯一连续的一块，保留重复次数；不改写、不补写ASR。中文无明确对应则unknown。",
    "before_word、after_word是缺口紧邻的ASR词index，句首before_word=null，句尾after_word=null；句中两者必须相邻。不要输出毫秒，不得跨过已有ASR词去制造缺口。",
    '只输出JSON：{"audio_blocks":1,"missing_text_blocks":1,"kind":"onomatopoeia|speech|ambient|unknown","matched_jp":"原日文连续片段","matched_zh":"原中文对应连续片段","before_word":null,"after_word":0,"reason":"数量、位置和语义依据；不确定则说明"}',
  ].join("\n"), promptKey: "missing-fragment.system", promptValues: {} }, { role: "user" as const, content: JSON.stringify({
    japanese_subtitle: textJp, chinese_subtitle: textZh, asr_text: asr.text,
    words: words.map((w, index) => ({ index, text: w.text, start_ms: w.start, end_ms: w.end })),
    candidate_audio_blocks: blocks,
  }), promptKey: "missing-fragment.input", promptValues: {"input_json": JSON.stringify({
    japanese_subtitle: textJp, chinese_subtitle: textZh, asr_text: asr.text,
    words: words.map((w, index) => ({ index, text: w.text, start_ms: w.start, end_ms: w.end })),
    candidate_audio_blocks: blocks,
  })} }];
}

export async function classifyMissingFragment(textJp: string, textZh: string, asr: SeedAsrResult, blocks: SegmentSpan[]): Promise<FragmentDecision> {
  const reply = await rewriteChat(missingFragmentMessages(textJp, textZh, asr, blocks), .1, "missing-fragment-classification", 1);
  const result = parseJsonObject(reply.content);
  if (!["onomatopoeia", "speech", "ambient", "unknown"].includes(String(result.kind))
    || ![result.audio_blocks, result.missing_text_blocks].every(n => Number.isInteger(n) && Number(n) >= 0)
    || ["matched_jp", "matched_zh", "reason"].some(k => typeof result[k] !== "string")
    || [result.before_word, result.after_word].some(n => n !== null && (!Number.isInteger(n) || Number(n) < 0))) throw new Error("漏识别片段分类返回格式无效");
  return result as FragmentDecision;
}

/** 模型负责语义，程序只验证安全条件：原文真有这一块、唯一位置、邻接字轴、双侧声学谷地。
 * 任一侧没有可靠切口、剩余正文对齐仍不可用，直接fallback，不扩大猜测范围。
 * 句中恢复必须同时找到左右两个切口；不能只切好一边就删除另一边正文。
 */
export function recoverMissingFragment(input: {
  decision: FragmentDecision; textJp: string; textZh: string; words: Word[]; blocks: SegmentSpan[];
  samples: Float32Array; sampleRate: number;
}) {
  const { decision: d, words } = input;
  if (input.blocks.length !== 1 || d.audio_blocks !== 1 || d.missing_text_blocks !== 1 || d.kind !== "onomatopoeia") return null;
  const unique = (text: string, part: string) => part.trim() && text.indexOf(part) >= 0 && text.indexOf(part) === text.lastIndexOf(part);
  if (!unique(input.textJp, d.matched_jp) || !unique(input.textZh, d.matched_zh)) return null;
  const before = d.before_word, after = d.after_word;
  if (!words.length || (before === null && after === null)
    || (before === null ? after !== 0 : before < 0 || before >= words.length)
    || (after === null ? before !== words.length - 1 : after < 0 || after >= words.length)
    || (before !== null && after !== null && after !== before + 1)) return null;
  const split = (text: string, part: string) => {
    const at = text.indexOf(part);
    return [text.slice(0, at), text.slice(at + part.length)].map(s => /[^\s\p{P}\p{S}]/u.test(s) ? s.trim() : "");
  };
  const jp = split(input.textJp, d.matched_jp), zh = split(input.textZh, d.matched_zh);
  // 这里只核对模型所说的位置，不做日文与ASR文字的相等比较。
  if ((!jp[0]) !== (before === null) || (!jp[1]) !== (after === null)
    || (!zh[0]) !== (before === null) || (!zh[1]) !== (after === null)) return null;
  const cuts = fragmentBoundaries(input, input.blocks[0], before, after);
  if (!cuts) return null;
  const { leftCut, rightCut, right } = cuts;
  const fragment: SegmentSpan = { startMs: leftCut?.cutMs ?? 0, endMs: rightCut?.cutMs ?? Math.round(right), text: d.matched_jp };
  if (fragment.endMs <= fragment.startMs) return null;
  const leftClauses = before === null ? [] : alignJapaneseClauses(words.slice(0, before + 1).map(w => w.text).join(""), words.slice(0, before + 1));
  const rightClauses = after === null ? [] : alignJapaneseClauses(words.slice(after).map(w => w.text).join(""), words.slice(after));
  if ((before !== null && !leftClauses.length) || (after !== null && !rightClauses.length)) return null;
  // 采用模型选定的缺口分开左右ASR正文，字轴对齐不再强求官方原字与ASR相等。
  // 官方日文正文单独保留，后续参考拍数/改写不使用ASR误字。
  const japaneseBody = jp.filter(Boolean).join("\n");
  const chineseBody = zh.filter(Boolean).join("\n");
  return { japaneseBody, chineseBody, fragment,
    bodyClauses: [...leftClauses, ...rightClauses],
    subtitleClauses: [...leftClauses, fragment, ...rightClauses], boundaries: [leftCut, rightCut].filter(Boolean) };
}
