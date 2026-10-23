// ASR word gaps are not acoustic gaps. Only sustained waveform silence may
// separate connected speech; unassigned sound is unknown, never ambient by default.
export type SegmentSpan = { startMs: number; endMs: number; text?: string };
export type AudioSegment = SegmentSpan & { kind: "speech" | "silence" | "onomatopoeia" | "ambient" | "unknown" };

export const SEGMENT_FRAME_MS = 10;
export const SEGMENT_SILENCE_RATIO = 0.05;
export const SEGMENT_MIN_SILENCE_MS = 250;
const BOUNDARY_LOOK_BACK_MS = 200;
const BOUNDARY_LOOK_AHEAD_MS = 50;
const BOUNDARY_WINDOW_MS = 10;

function waveformQuietSpans(samples: Float32Array, sampleRate: number): SegmentSpan[] {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 1e-8) return [{ startMs: 0, endMs: Math.round(samples.length / sampleRate * 1000) }];
  const frame = Math.max(1, Math.round(sampleRate * SEGMENT_FRAME_MS / 1000));
  const spans: SegmentSpan[] = [];
  let start: number | null = null;
  for (let offset = 0; offset <= samples.length; offset += frame) {
    const end = Math.min(offset + frame, samples.length);
    let framePeak = 0;
    for (let i = offset; i < end; i += 1) framePeak = Math.max(framePeak, Math.abs(samples[i]));
    const silent = offset < samples.length && framePeak < peak * SEGMENT_SILENCE_RATIO;
    if (silent && start === null) start = offset;
    if ((!silent || end === samples.length) && start !== null) {
      const stop = silent ? end : offset;
      if ((stop - start) / sampleRate * 1000 >= SEGMENT_MIN_SILENCE_MS) {
        spans.push({ startMs: Math.round(start / sampleRate * 1000), endMs: Math.round(stop / sampleRate * 1000) });
      }
      start = null;
    }
  }
  return spans;
}

/** 测语速专用的净时长，与字幕/拟声切段规则独立。
 * 语义切段会保护无标点的连续日文，不能因此把句内长停顿算成“说得慢”。
 * 输入必须是已去拟声、裁首尾的实际参考；只扣连续>=250ms且每个10ms帧峰值
 * 都低于参考峰值5%的区间。短间隙保留；有声拖音计时。低声拖音可能落入阈值，
 * 因此返回全部证据供日志核对；不修改音频，也不使用ASR漏字间隙猜静音。
 */
export function measurePerformanceSpeakingTime(input: { samples: Float32Array; sampleRate: number; startS: number; endS: number }) {
  const { samples, sampleRate } = input;
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate) || !samples.length) return null;
  const startMs = Math.max(0, input.startS * 1000);
  const endMs = Math.min(samples.length / sampleRate * 1000, input.endS * 1000);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  // 此处不使用 segmentPerformanceAudio 的“仅字幕边界静音”过滤，句内长静音也要扣。
  const pauses = waveformQuietSpans(samples, sampleRate).map(span => ({
    startMs: Math.max(startMs, span.startMs), endMs: Math.min(endMs, span.endMs),
  })).filter(span => span.endMs > span.startMs);
  const pauseSeconds = pauses.reduce((sum, span) => sum + (span.endMs - span.startMs) / 1000, 0);
  const speechSeconds = Math.max(0, (endMs - startMs) / 1000 - pauseSeconds);
  return { speechSeconds, pauseSeconds, pauses, startMs, endMs,
    metricVersion: "reference-waveform-speaking-time-v1", frameMs: SEGMENT_FRAME_MS,
    peakRatio: SEGMENT_SILENCE_RATIO, minSilenceMs: SEGMENT_MIN_SILENCE_MS };
}

export type BoundaryRefinement = {
  leftClause: number;
  rightClause: number;
  leftAsrEndMs: number;
  asrMs: number;
  cutMs: number;
  reason: "silence-interval" | "energy-valley" | "no-clear-valley";
  silence?: SegmentSpan;
  searchStartMs?: number;
  searchEndMs?: number;
  valley?: SegmentSpan;
};

/** Evaluate every subtitle clause boundary, regardless of speech/FX class.
 * Short valleys refine a transition without inventing extra silence segments. */
export function refinePerformanceBoundaries(input: {
  samples: Float32Array;
  sampleRate: number;
  onomatopoeia: SegmentSpan[];
  subtitleClauses: SegmentSpan[];
}) {
  const { samples, sampleRate, subtitleClauses } = input;
  if (!(sampleRate > 0)) throw new Error("无效的音频采样率");
  const durationMs = samples.length / sampleRate * 1000;
  const prefix = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i += 1) prefix[i + 1] = prefix[i] + samples[i] * samples[i];
  const half = Math.max(1, Math.round(sampleRate * BOUNDARY_WINDOW_MS / 2000));
  const rms = (ms: number) => {
    const center = Math.round(ms * sampleRate / 1000);
    const start = Math.max(0, center - half);
    const end = Math.min(samples.length, center + half);
    return end > start ? Math.sqrt(Math.max(0, prefix[end] - prefix[start]) / (end - start)) : 0;
  };
  const adjustments: BoundaryRefinement[] = [];
  const longSilences = waveformQuietSpans(samples, sampleRate);
  const refine = (previous: SegmentSpan, next: SegmentSpan, index: number) => {
    const anchor = next.startMs;
    // An ASR boundary can lag behind the next onset by more than the short
    // search radius. A long pause shared by these clauses is stronger evidence.
    const pause = longSilences.filter((span) => previous.endMs <= next.startMs
      && span.startMs < next.startMs && span.endMs > previous.endMs)
      .sort((a, b) => Math.abs(a.endMs - anchor) - Math.abs(b.endMs - anchor))[0];
    if (pause) {
      adjustments.push({
        leftClause: index, rightClause: index + 1, leftAsrEndMs: previous.endMs,
        asrMs: anchor,
        cutMs: Math.max(previous.endMs, Math.min(next.startMs, Math.round((pause.startMs + pause.endMs) / 2))),
        reason: "silence-interval", silence: pause,
      });
      return;
    }
    // 以后一文字段首字的ASR起点为基准：向前200ms、向后50ms。
    // ASR可能早报或晚报；不能把搜索上限卡死在首字起点，否则无法向后修正。
    const lo = Math.ceil(Math.max(previous.endMs, anchor - BOUNDARY_LOOK_BACK_MS));
    const hi = Math.floor(Math.min(next.endMs - 1, durationMs, anchor + BOUNDARY_LOOK_AHEAD_MS));
    let best = anchor;
    let energy = Infinity;
    for (let ms = lo; ms <= hi; ms += 1) {
      const value = rms(ms);
      if (value < energy || (value === energy && Math.abs(ms - anchor) < Math.abs(best - anchor))) {
        energy = value;
        best = ms;
      }
    }
    let left = 0;
    let right = 0;
    // 检查整个搜索窗内谷底两边的声音，而非只看谷底左右各50ms。
    // 平底静音可能宽于50ms，旧算法左侧还在静音中便误判无谷，退回正在说话的ASR点。
    for (let ms = lo; ms <= best - BOUNDARY_WINDOW_MS; ms++) left = Math.max(left, rms(ms));
    for (let ms = best + BOUNDARY_WINDOW_MS; ms <= hi; ms++) right = Math.max(right, rms(ms));
    // A low sample or a zero crossing is not enough: the whole 10ms window
    // must be much quieter than sound on BOTH sides. Otherwise keep the ASR anchor.
    const clear = Number.isFinite(energy) && Math.min(left, right) > 1e-5
      && energy <= Math.min(left, right) * 0.25;
    // 找出与最低点连通的整片低谷，切在中间；不选靠近正文的平底末端。
    let valleyStart = best, valleyEnd = best;
    if (clear) {
      const threshold = Math.min(left, right) * 0.25;
      while (valleyStart > lo && rms(valleyStart - 1) <= threshold) valleyStart--;
      while (valleyEnd < hi && rms(valleyEnd + 1) <= threshold) valleyEnd++;
    }
    const cutMs = clear ? Math.round((valleyStart + valleyEnd) / 2) : anchor;
    adjustments.push({
      leftClause: index, rightClause: index + 1, leftAsrEndMs: previous.endMs,
      asrMs: anchor, cutMs, reason: clear ? "energy-valley" : "no-clear-valley",
      searchStartMs: lo, searchEndMs: hi,
      ...(clear ? { valley: { startMs: valleyStart, endMs: valleyEnd } } : {}),
    });
  };
  subtitleClauses.slice(0, -1).forEach((clause, index) => refine(clause, subtitleClauses[index + 1], index));
  const move = (anchor: number) => {
    // Keep the file head/tail with its existing segment.
    if (anchor <= 0 || anchor >= durationMs) return anchor;
    const boundary = adjustments.find((row) => anchor === row.asrMs || anchor === row.leftAsrEndMs);
    return boundary && boundary.reason !== "no-clear-valley" ? boundary.cutMs : anchor;
  };
  const onomatopoeia = input.onomatopoeia.map((span) => {
    const startMs = move(span.startMs);
    const endMs = move(span.endMs);
    return endMs > startMs ? { ...span, startMs, endMs } : { ...span };
  });
  // Semantic phrase ranges use shared acoustic cuts. The waveform segmenter
  // still retains any long silence as its own interval instead of collapsing it.
  const clauses = subtitleClauses.map((span, index) => ({
    ...span,
    startMs: index === 0 ? 0 : adjustments[index - 1].cutMs,
    endMs: index === subtitleClauses.length - 1 ? Math.round(durationMs) : adjustments[index].cutMs,
  }));
  return { onomatopoeia, adjustments, clauses };
}

type Word = { start: number; end: number; text: string };
const subtitleParts = (text: string) => text.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);

/** 取分类后保留的日文原文；保留原标点/换行，不能把字幕段 join 成无标点文本，
 * 否则后续拍数“比”会丢掉句中标点拍数。分类索引仍对应 subtitleParts。 */
export function subtitleSpeechText(text: string, indexes: number[]) {
  const parts = [...text.matchAll(/[^\s\p{P}\p{S}]+/gu)];
  const selected = new Set(indexes);
  return parts.flatMap((part, index) => selected.has(index) ? [
    text.slice(index === 0 ? 0 : part.index!, parts[index + 1]?.index ?? text.length),
  ] : []).join("").trim();
}
const comparable = (text: string) => [...text.normalize("NFKC").toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, "")].map((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
  });

/** ASR漏分隔的保守补切：原字幕分界 + 至少1秒的真实静音 + 唯一字轴边界。
 * 新旧文本只允许全半角/假名归一后完全一致；不靠编辑距离猜文字对应，不按字轴空档猜静音。
 * 保留已有ASR分段及原文字，不修改字幕，只给拟声分类增加已确认的候选切口。
 */
export function splitAsrClausesByOriginalPauses(input: {
  samples: Float32Array; sampleRate: number; textJp: string; asrText: string;
  words: Word[]; clauses: SegmentSpan[];
}) {
  const unchanged = { clauses: input.clauses, splits: [] as {
    characterOffset: number; leftText: string; rightText: string; silence: SegmentSpan; cutMs: number;
  }[] };
  if (!(input.sampleRate > 0) || !input.samples.length || !input.clauses.length) return unchanged;
  const original = subtitleParts(input.textJp);
  const body = (text: string) => comparable(text).join("");
  const asrBody = body(input.asrText);
  if (original.length < 2 || !asrBody || body(input.textJp) !== asrBody
    || body(input.words.map(w => w.text).join("")) !== asrBody
    || body(input.clauses.map(c => c.text ?? "").join("")) !== asrBody) return unchanged;
  // 字轴缺失/重叠/倒序，不允许新切口。首尾ASR轻微越界仍由原有声学校正裁回。
  if (input.words.some((w,i) => !Number.isFinite(w.start) || !Number.isFinite(w.end)
    || w.start < 0 || w.end <= w.start || (i > 0 && w.start < input.words[i-1].end))) return unchanged;
  const wordEnds: number[] = []; let count = 0;
  for (const word of input.words) { count += comparable(word.text).length; wordEnds.push(count); }
  const existing = new Set<number>(); count = 0;
  for (const clause of input.clauses) { count += comparable(clause.text ?? "").length; existing.add(count); }
  const pauses = waveformQuietSpans(input.samples, input.sampleRate)
    .filter(p => p.endMs - p.startMs >= 1000 && p.startMs > 0
      && p.endMs < input.samples.length / input.sampleRate * 1000);
  count = 0;
  const accepted = new Map<number, {left:Word; right:Word}>();
  for (let i = 0; i < original.length - 1; i++) {
    count += comparable(original[i]).length;
    if (existing.has(count)) continue;
    const indexes = wordEnds.flatMap((n,j) => n === count ? [j] : []);
    if (indexes.length !== 1) continue;
    const j = indexes[0], left = input.words[j], right = input.words[j+1];
    if (!right || !body(left.text) || !body(right.text)) continue;
    // 静音中点必须位于这两个相邻字轴之间；拒绝字幕别处的长空白。
    const matches = pauses.filter(p => { const mid = (p.startMs+p.endMs)/2;
      return mid >= left.end && mid <= right.start; });
    if (matches.length !== 1) continue;
    accepted.set(count, {left,right});
    unchanged.splits.push({characterOffset:count,leftText:original[i],rightText:original[i+1],
      silence:matches[0],cutMs:(matches[0].startMs+matches[0].endMs)/2});
  }
  if (!accepted.size) return unchanged;
  const clauses: SegmentSpan[] = []; count = 0;
  for (const clause of input.clauses) {
    const chars = [...(clause.text ?? "").normalize("NFKC")], size = comparable(clause.text ?? "").length;
    // 特殊归一导致字符位置不一致时整次放弃，不借计数猜切点。
    if (chars.length !== size) return { clauses: input.clauses, splits: [] };
    const cuts = [...accepted.keys()].filter(n => n > count && n < count+size).sort((a,b)=>a-b);
    let start = 0, startMs = clause.startMs;
    for (const cut of cuts) {
      const pair = accepted.get(cut)!;
      if (pair.left.end <= startMs || pair.right.start >= clause.endMs) return {clauses:input.clauses,splits:[]};
      clauses.push({text:chars.slice(start,cut-count).join(""),startMs,endMs:pair.left.end});
      start = cut-count; startMs = pair.right.start;
    }
    clauses.push({...clause,text:chars.slice(start).join(""),startMs}); count += size;
  }
  return {clauses,splits:unchanged.splits};
}

/** Align subtitle characters to ASR with edits, not character-count slicing:
 * オレ/俺, ワケ/わけ and 魔晄/魔光 must not shift every later clause. */
export function alignJapaneseClauses(text: string, words: Word[]): SegmentSpan[] {
  const clauses = subtitleParts(text);
  const source = clauses.flatMap((clause, index) => comparable(clause).map((char) => ({ char, clause: index })));
  const target = words.flatMap((word) => comparable(word.text).map((char) => ({ char, word })));
  if (!source.length || !target.length) return [];
  // Game lines are short. Refuse pathological input rather than allocating an
  // unbounded alignment matrix; no evidence means no permitted acoustic cuts.
  if (source.length * target.length > 4_000_000) return [];
  const width = target.length + 1;
  const costs = new Uint32Array((source.length + 1) * width);
  for (let i = 0; i <= source.length; i += 1) costs[i * width] = i;
  for (let j = 0; j <= target.length; j += 1) costs[j] = j;
  for (let i = 1; i <= source.length; i += 1) {
    for (let j = 1; j <= target.length; j += 1) {
      costs[i * width + j] = Math.min(
        costs[(i - 1) * width + j - 1] + (source[i - 1].char === target[j - 1].char ? 0 : 1),
        costs[(i - 1) * width + j] + 1,
        costs[i * width + j - 1] + 1,
      );
    }
  }
  // Laugh syllables and elongated speech are often transcribed inconsistently.
  // Allow edits, but require an exact character anchor in every clause below.
  if (costs[source.length * width + target.length] / Math.max(source.length, target.length) > 0.55) return [];
  const matched: Word[][] = clauses.map(() => []);
  const anchors = clauses.map(() => 0);
  let i = source.length;
  let j = target.length;
  while (i || j) {
    if (i && j && costs[i * width + j] === costs[(i - 1) * width + j - 1]
      + (source[i - 1].char === target[j - 1].char ? 0 : 1)) {
      matched[source[i - 1].clause].push(target[j - 1].word);
      if (source[i - 1].char === target[j - 1].char) anchors[source[i - 1].clause] += 1;
      i -= 1;
      j -= 1;
    } else if (i && costs[i * width + j] === costs[(i - 1) * width + j] + 1) i -= 1;
    else j -= 1;
  }
  // Incomplete clause evidence cannot safely authorize a split.
  if (matched.some((rows, index) => !rows.length || !anchors[index])) return [];
  return clauses.map((clause, index) => ({
    text: clause,
    startMs: Math.min(...matched[index].map((word) => word.start)),
    endMs: Math.max(...matched[index].map((word) => word.end)),
  }));
}

/** 中文拼接只由中文自身的文字段落决定切口，不要求与日文段数一致。
 * 复用字幕/ASR 编辑距离对齐和日文能量谷逻辑。共用一个切点并覆盖整份 WAV，
 * 保留 TTS 的首尾、句间静音，避免按字轴尾端/下一字起点分别裁剪而丢掉停顿。
 * 缺字轴、对齐失败或跨段共享同一个词时间戳时，保留整段，不能按字数猜切口。
 */
export function chineseSpliceClauses(input: {
  text: string; samples: Float32Array; sampleRate: number; words: Word[];
}) {
  if (!(input.sampleRate > 0)) throw new Error("无效的音频采样率");
  const durationMs = Math.round(input.samples.length / input.sampleRate * 1000);
  const whole = (method: "whole-clause" | "unreliable-alignment") => ({
    clauses: [{ startMs: 0, endMs: durationMs, text: input.text.trim() }],
    adjustments: [] as BoundaryRefinement[], method,
  });
  if (subtitleParts(input.text).length <= 1) return whole("whole-clause");
  // 对齐器的假名归一化不影响中文；中日文共用同一套文字匹配和声学边界判定。
  const aligned = alignJapaneseClauses(input.text, input.words);
  if (!aligned.length || aligned.some((span, index) => span.startMs < 0
    || span.endMs > durationMs || span.endMs <= span.startMs
    || (index > 0 && aligned[index - 1].endMs > span.startMs))) {
    return whole("unreliable-alignment");
  }
  const refined = refinePerformanceBoundaries({
    samples: input.samples, sampleRate: input.sampleRate, subtitleClauses: aligned, onomatopoeia: [],
  });
  if (refined.clauses.some((span) => span.endMs <= span.startMs)) return whole("unreliable-alignment");
  return {
    clauses: refined.clauses.map((span, index) => ({ ...span, text: aligned[index].text || "" })),
    adjustments: refined.adjustments, method: "asr-waveform" as const,
  };
}

export function segmentPerformanceAudio(input: {
  samples: Float32Array;
  sampleRate: number;
  speech: SegmentSpan[];
  words: Word[];
  onomatopoeia: SegmentSpan[];
  ambient?: SegmentSpan[];
  subtitleClauses?: SegmentSpan[];
}) {
  const { samples, sampleRate } = input;
  if (!(sampleRate > 0) || !samples.length) throw new Error("没有可切分的日文音频");
  const durationMs = Math.round(samples.length / sampleRate * 1000);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 1e-8) return [{ kind: "silence", startMs: 0, endMs: durationMs }] satisfies AudioSegment[];

  const quiet = waveformQuietSpans(samples, sampleRate).filter((span) => {
    const clauses = input.subtitleClauses;
    const atBoundary = clauses === undefined || clauses.some((clause, index) => {
      const next = clauses[index + 1];
      if (!next) return false;
      return span.startMs <= Math.max(clause.endMs, next.startMs)
        && span.endMs >= Math.min(clause.endMs, next.startMs);
    });
    return atBoundary || span.startMs === 0 || span.endMs === durationMs;
  });

  const valid = (spans: SegmentSpan[]) => spans.filter((span) => (
    Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs > span.startMs
  ));
  const speech = valid(input.speech);
  const words = valid(input.words.map((word) => ({ startMs: word.start, endMs: word.end, text: word.text })));
  const ono = valid(input.onomatopoeia);
  // 只有上层“零缺文+唯一声音+声学切口”确认过的环境音才可传入；未知声音仍保持unknown。
  const ambient=valid(input.ambient??[]);
  if (input.subtitleClauses && ono.some((span) => [span.startMs, span.endMs].some((cut) => (
    input.subtitleClauses!.some((clause) => cut > clause.startMs && cut < clause.endMs)
  )))) {
    throw new Error("拟声切分落在没有分隔符的连续日文正文内部，需要人工核对");
  }
  // Explicit semantic cuts may separate a laugh from adjacent speech, even
  // without a long pause. Ordinary word edges never become cut boundaries.
  const cuts = [...new Set([0, durationMs, ...quiet.flatMap((span) => [span.startMs, span.endMs]),
    ...[...ono,...ambient].flatMap((span) => [Math.max(0, Math.min(durationMs, span.startMs)), Math.max(0, Math.min(durationMs, span.endMs))])])]
    .sort((a, b) => a - b);
  const overlaps = (a: SegmentSpan, b: SegmentSpan) => a.startMs < b.endMs && b.startMs < a.endMs;
  const result: AudioSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const span = { startMs: cuts[i], endMs: cuts[i + 1] };
    if (span.endMs <= span.startMs) continue;
    const fx = ono.find((row) => overlaps(row, span));
    const kind: AudioSegment["kind"] = quiet.some((row) => overlaps(row, span)) ? "silence"
      : fx ? "onomatopoeia"
        : ambient.some(row=>overlaps(row,span)) ? "ambient"
        : speech.some((row) => overlaps(row, span)) || words.some((row) => overlaps(row, span)) ? "speech" : "unknown";
    const text = kind === "onomatopoeia" ? fx?.text : undefined;
    const last = result[result.length - 1];
    if (last?.kind === kind) {
      last.endMs = span.endMs;
      last.text = [last.text, text].filter(Boolean).join("");
    } else result.push({ ...span, kind, ...(text ? { text } : {}) });
  }
  // ASR can place a word partly or wholly in an acoustic pause. Attach its
  // display label to the nearest sound segment, without moving audio cuts or
  // dropping/duplicating the word. Timestamps remain evidence, not scissors.
  const sounded = result.filter((span) => span.kind !== "silence");
  for (const word of words) {
    const midpoint = (word.startMs + word.endMs) / 2;
    const overlap = (span: SegmentSpan) => Math.max(0, Math.min(span.endMs, word.endMs) - Math.max(span.startMs, word.startMs));
    const distance = (span: SegmentSpan) => Math.max(0, span.startMs - midpoint, midpoint - span.endMs);
    const chosen = sounded.reduce<AudioSegment | null>((best, span) => {
      if (!best || overlap(span) > overlap(best)) return span;
      if (overlap(span) === overlap(best) && distance(span) < distance(best)) return span;
      return best;
    }, null);
    if (chosen?.kind === "speech") chosen.text = (chosen.text || "") + (word.text || "");
  }
  return result;
}
