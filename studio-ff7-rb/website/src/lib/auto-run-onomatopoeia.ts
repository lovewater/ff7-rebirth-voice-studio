import { retainedOhInterjection, subtitleRestorePlan, type SubtitleRestore } from "./auto-run-subtitle";
import { scriptClauses } from "./auto-run-script-policy";
import { parseJsonObject, rewriteChat } from "./auto-run-llm";
import type { SeedAsrResult } from "./seed-asr";
import { alignJapaneseClauses, chineseSpliceClauses, type BoundaryRefinement, type SegmentSpan } from "./speech-segmentation";
import { requireDeletionOnlyScript } from "./tts-reference";
import { ORIGINAL_VOICE_REUSE_POLICY } from "./onomatopoeia-reuse-policy";

export type TimeSpan = { startMs: number; endMs: number; text?: string };

export type OnoPlan = {
  enabled: boolean;
  reason: string;
  thinking: string;
  speech: TimeSpan[];
  onomatopoeia: TimeSpan[];
  ambient: TimeSpan[];
  cnTtsText: string;
  originalCnTtsText: string;
  jpSpeechText: string;
  subtitleRestore: SubtitleRestore;
};

export type SplicePiece =
  | { src: "ono"; index: number }
  | { src: "env"; index: number }
  | { src: "tts"; startMs: number; endMs: number | null };

function overlaps(a: TimeSpan, b: TimeSpan) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function punchSpans(spans: TimeSpan[], holes: TimeSpan[]) {
  return spans.flatMap((span) => holes.reduce((cur, hole) => cur.flatMap((piece) => {
    if (!overlaps(piece, hole)) return [piece];
    const out: TimeSpan[] = [];
    if (piece.startMs < hole.startMs) out.push({ ...piece, endMs: hole.startMs });
    if (piece.endMs > hole.endMs) out.push({ ...piece, startMs: hole.endMs });
    return out.filter((row) => row.endMs - row.startMs >= 40);
  }), [span]));
}

function mergeSpans(list: TimeSpan[]) {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  const out: TimeSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.startMs <= last.endMs + 40) {
      last.endMs = Math.max(last.endMs, span.endMs);
      last.text = [last.text, span.text].filter(Boolean).join(" ");
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

function gapsAroundSpeech(speech: TimeSpan[], durationMs: number): TimeSpan[] {
  const sorted = [...speech].sort((a, b) => a.startMs - b.startMs);
  const gaps: TimeSpan[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.startMs - cursor >= 40) gaps.push({ startMs: cursor, endMs: span.startMs });
    cursor = Math.max(cursor, span.endMs);
  }
  if (durationMs - cursor >= 40) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

export async function planOnomatopoeia(input: {
  textJp: string;
  textZh: string;
  ttsText?: string;
  textEn: string;
  durationMs: number;
  jpAsr: SeedAsrResult;
  /** 唯一漏识别拟声补救已分左右ASR正文，复用其字轴，防止再次跨缺口对齐。 */
  subtitleClauses?: SegmentSpan[];
  clauseSplitEvidence?: unknown[];
}): Promise<OnoPlan> {
  const sourceScript = input.ttsText ?? input.textZh;
  const words = input.jpAsr.words.length ? input.jpAsr.words : input.jpAsr.utterances.flatMap((row) => row.words);
  // 模型分类的对象是ASR自己可定位的文字段，不先要求官方字幕逐字对齐。
  // 官方字幕可信但ASR可能转错字：两份都给模型，ASR只定位，官方字幕决定语义及正文原字。
  const clauses = input.subtitleClauses ?? alignJapaneseClauses(input.jpAsr.text, words);
  if (!clauses.length) throw new Error("ASR 自身文本与字轴无法可靠对齐，不能让模型猜拟声切点");
  const originalOh = retainedOhInterjection(clauses[0]?.text, input.textZh);
  const retainedOh = originalOh ?? retainedOhInterjection(clauses[0]?.text, sourceScript);
  const utterances = (input.jpAsr.utterances ?? []).map((row, index) => ({
    index,
    start_ms: Math.round(row.start),
    end_ms: Math.round(row.end),
    text: row.text,
  }));
  const { content, thinking } = await rewriteChat([
    {
      role: "system",
      content: [
        "你在给《最终幻想7 重生》表演句做拟声切分。",
        "Seed-ASR 的分句和字轴用于对应正文，不是完整的声音边界。字时间戳之间没有标字，不代表那里没有说话声。",
        "程序会根据波形中的持续低能量停顿切分声音；你只判断正文和有明确字幕或 ASR 依据的拟声，不要根据字轴空档猜环境音。",
        "subtitle_clauses 是程序按 ASR 字幕分隔符分好、已经有字轴定位的完整 ASR 文字段。你只把每段分为 speech（正文）或 onomatopoeia（笑、哭、哼、独立感叹等原声表演），不能拆开一段。",
        "text_jp 是官方日文字幕，语义和原字以它为准；subtitle_clauses/seed_words 可能有错字、同音替换、假名汉字异写或漏识别。请结合官方日/中/英字幕按读音、上下文和顺序理解这些ASR段，不要把误识正文当拟声。",
        "例如官方オレ、ASR俺都是我；官方食われたくない、ASR壊れたくない可能是误识正文。不能因写法或误字将这类ASR段分类为onomatopoeia。",
        "original_jp_speech_text 必须从官方 text_jp 仅删除已确认保留原声的拟声及关联标点，保留全部正文原字、原标点和段落，不能抄ASR误字、不能改写。没有拟声时原样返回text_jp。这份正文供参考音频拍数和改写使用。",
        "如果无法把ASR片段与官方字幕建立合理的语义/顺序对应，返回unparseable=true并说明reason，程序会fallback；不要为凑分类强行猜测。否则unparseable=false。",
        "每个 index 必须恰好归入一类，不可遗漏、重复或同时归入两类。",
        "不要输出、猜测或按字符比例估计任何毫秒切点。时间由程序按 ASR 自身文本与字轴的对应结果决定，再用波形谷地修正。",
        "空隙：说字之外连在一起的部分（含句首、句间、句尾，以及听成哈哈/フフ但对不上正文的分句）。",
        "空隙里如果有拟声（看日/中/英字幕或 ASR 的 ha/heh/哼/哈/嘿/フフ/ウウ），整段空隙都算拟声，包括气口。",
        "空隙里没有明确拟声依据：不要列入 onomatopoeia。未识别的声音不能直接认定为环境音。",
        "程序会把句首拟声及其后的气口一起保留到正文开始；你不需要确定音频边界。",
        "tts_text 是本轮自动运行从游戏原中文字幕取得的起始稿，不使用手动 TTS 框或历史修订稿。cn_tts_text 只从 tts_text 删除拟声及其关联标点，保留其他正文、标点和段落，不要借去拟声改写正文。",
        "独立成段的感叹、笑声、叹气可以保留原声演出，不要求必须是笑声。正常词句仍归 speech。没有需保留原声的声音时原样返回 tts_text。",
        "required_original_indexes 是程序确认要保留原声的独立感叹，必须归入 onomatopoeia；中文稿中的对应句首感叹及关联标点从 cn_tts_text 删除。即使它有感叹语义，也不能以不是笑声为由改为正文。",
        "original_cn_tts_text 是从 text_zh 删除同一批保留原声的拟声后得到的原版正文，必须独立处理，保留原正文所有字、标点和段落。不能拿改稿 cn_tts_text 代替：例如原字幕哦哦，诱饵吗！、改稿哦！诱饵！，分别返回原正文诱饵吗！和改稿正文诱饵！。原拟声字幕将从 text_zh 恢复，不能缩字、改字。",
        // 与迁移071及提示词库保持一致：拟声是保留原声的工程分类，不按语法词性判断。
        // 正式请求使用数据库最新启用模板；这里保留可审阅的源码定义，不能绕过提示词管理。
        "分类优先规则（工程上的保留原声，与语法词性无关）：",
        "onomatopoeia 是“独立情绪/非正文发声，保留原日文演出”的工程标签，不限于语言学上的拟声词。叹词、感叹词、语气词即使有字幕、具有感叹语义、位于句首或能与中文字幕逐字对应，也不能据此归为speech。",
        "先判断一个完整ASR文字段是否仅为独立的情绪发声，再判断能否与中文对应。对于独立成段、无普通词句内容，且中文有兼容发声的感叹（例如日文「あ／ああ／あ～」与中文“啊／啊～”，「おお」与“哦”，「うん」与“嗯”），优先归入onomatopoeia，原声保留；从中日正文及中文TTS稿删除对应语气词和关联标点，最终字幕由程序恢复。",
        "反例纠正：官方「あ～ 完全にだましにきてる」、中文“啊～根本就是在骗人”，若ASR已分成「ああ」和「完全に騙しに来てる」，前段应归onomatopoeia，后段归speech。中日「あ～／啊～」对应正是保留原声的依据，不是将它当正文重新TTS的理由。",
        "仍不可拆开完整ASR段；语气和正文混在同一个不可拆ASR段时不得猜切。正常词句、呼叫人名、明确招呼/征询的「ねえ／ねぇ／ねー」以及词内「わからねえ」等继续按正文处理，不能因含有某个假名就当拟声。已有独立情绪应答可保留的规则仍有效。",
        "返回前检查：若将独立啊/哦/嗯类段归speech，不能仅以“属于字幕的一部分”“能与中文对应”“是句首叹词”作为理由，必须有它实际承载普通正文内容或符合明确排除项的证据。",
        ORIGINAL_VOICE_REUSE_POLICY,
        "只输出 JSON：unparseable 是否无法解析；original_jp_speech_text 去掉已确认拟声后的官方日文正文；original_cn_tts_text 去掉拟声后的原中文字幕正文；speech_clause_indexes 正文段 index 数组；onomatopoeia_clause_indexes 拟声段 index 数组；cn_tts_text 去掉拟声后的中文朗读稿；reason 一句话；thinking。",
      ].join("\n"), promptKey: "onomatopoeia-plan.system", promptValues: {},
    },
    {
      role: "user",
      content: JSON.stringify({
        slice_text_source: "seed-asr",
        conservative_split_evidence: input.clauseSplitEvidence?.length ? input.clauseSplitEvidence : undefined,
        asr_text: input.jpAsr.text,
        text_jp: input.textJp,
        text_zh: input.textZh,
        tts_text: sourceScript,
        required_original_indexes: retainedOh ? [0] : [],
        text_en: input.textEn,
        duration_ms: input.durationMs,
        seed_utterances: utterances,
        seed_words: words,
        subtitle_clauses: clauses.map((span, index) => ({ index, text: span.text })),
      }), promptKey: "onomatopoeia-plan.input", promptValues: {"input_json": JSON.stringify({
        slice_text_source: "seed-asr",
        conservative_split_evidence: input.clauseSplitEvidence?.length ? input.clauseSplitEvidence : undefined,
        asr_text: input.jpAsr.text,
        text_jp: input.textJp,
        text_zh: input.textZh,
        tts_text: sourceScript,
        required_original_indexes: retainedOh ? [0] : [],
        text_en: input.textEn,
        duration_ms: input.durationMs,
        seed_utterances: utterances,
        seed_words: words,
        subtitle_clauses: clauses.map((span, index) => ({ index, text: span.text })),
      })},
    },
  ], 0.1, "onomatopoeia-plan");
  const parsed = parseJsonObject(content);
  if (parsed.unparseable === true) throw new Error(`模型无法解析 ASR 片段与官方字幕的对应：${String(parsed.reason || "差异过大")}`);
  const durationMs = Math.max(1, input.durationMs);
  const parseIndexes = (value: unknown) => {
    if (!Array.isArray(value) || value.some((index) => !Number.isInteger(index) || index < 0 || index >= clauses.length)) {
      throw new Error("模型未返回有效的字幕段分类");
    }
    return value as number[];
  };
  let speechIndexes = parseIndexes(parsed.speech_clause_indexes);
  let onoIndexes = parseIndexes(parsed.onomatopoeia_clause_indexes);
  const assigned = [...speechIndexes, ...onoIndexes];
  if (assigned.length !== clauses.length || new Set(assigned).size !== clauses.length || !speechIndexes.length) {
    throw new Error("模型的字幕段分类存在遗漏、重复或没有正文");
  }
  if (retainedOh) {
    speechIndexes = speechIndexes.filter((index) => index !== 0);
    onoIndexes = [...new Set([...onoIndexes, 0])];
    if (!speechIndexes.length) throw new Error("保留独立感叹后没有可合成正文");
  }
  const speech = mergeSpans(speechIndexes.map((index) => clauses[index]));
  const llmOno = onoIndexes.map((index) => clauses[index]);
  const gaps = gapsAroundSpeech(speech, durationMs);
  const onomatopoeia = mergeSpans(gaps.filter((gap) => llmOno.some((span) => overlaps(span, gap))).map((gap) => {
    const hit = llmOno.find((span) => overlaps(span, gap));
    return { ...gap, text: hit?.text || "" };
  }));
  // 不允许模型漏返回时悄悄退回原稿，否则会把拟声重新送入 TTS。
  let cnTtsText = requireDeletionOnlyScript(sourceScript, parsed.cn_tts_text);
  if (retainedOh) {
    cnTtsText = requireDeletionOnlyScript(sourceScript, retainedOhInterjection("おお", cnTtsText)?.body ?? cnTtsText);
  }
  const enabled = onomatopoeia.length > 0;
  // ASR段索引不等于官方字幕段索引，不能拿分类索引去截官方字幕。
  // 无拟声时直接沿用完整官方正文；有拟声才验证模型返回的“仅删除”官方日文正文。
  let jpSpeechText = input.textJp;
  if (enabled) {
    jpSpeechText = requireDeletionOnlyScript(input.textJp, parsed.original_jp_speech_text);
  } else {
    cnTtsText = sourceScript;
  }
  // 原声片段配原字幕；改稿只决定新合成的正文。两份正文必须分别做删除校验，
  // 否则原正文与改稿的差异（如“吗”）也会被误认成拟声并恢复。
  // 独立おお的句首中文有明确规则，不依赖模型去猜“哦”的个数。
  const originalBody = !enabled ? input.textZh
    : originalOh && onoIndexes.length === 1 && onoIndexes[0] === 0 ? originalOh.body
      : requireDeletionOnlyScript(input.textZh, parsed.original_cn_tts_text);
  const subtitleRestore = subtitleRestorePlan(input.textZh, originalBody);
  return {
    enabled,
    reason: retainedOh ? "保留句首独立感叹「おお／哦」的原声，正文单独合成"
      : typeof parsed.reason === "string" ? parsed.reason.slice(0, 1000) : (enabled ? "存在已确认拟声" : "没有拟声"),
    thinking: (typeof parsed.thinking === "string" ? parsed.thinking : thinking).slice(0, 4000),
    speech,
    onomatopoeia,
    ambient: [],
    cnTtsText,
    originalCnTtsText: originalBody,
    jpSpeechText,
    subtitleRestore,
  };
}

function stripCn(text: string) {
  return text.replace(/[\s\p{P}\p{S}]/gu, "");
}

export function splitCnClauses(text: string) {
  return scriptClauses(text);
}

function gapForSpan(span: TimeSpan, clauseCount: number, speechStart: number, speechEnd: number, jpCuts: number[]) {
  if (span.endMs <= speechStart + 80) return 0;
  if (span.startMs >= speechEnd - 80) return clauseCount;
  if (clauseCount <= 1) {
    const mid = (speechStart + speechEnd) / 2;
    return span.startMs < mid ? 0 : 1;
  }
  for (let i = 0; i < jpCuts.length; i += 1) {
    if (span.startMs < jpCuts[i]) return i + 1;
  }
  return clauseCount;
}

export async function planSpliceAfterTts(input: {
  onomatopoeia: TimeSpan[];
  ambient: TimeSpan[];
  speech: TimeSpan[];
  cnAsr: SeedAsrResult;
  cnAudio: { samples: Float32Array; sampleRate: number };
  cnTtsText: string;
}): Promise<{
  pieces: SplicePiece[]; thinking: string; reason: string; clauses: string[];
  boundaries: BoundaryRefinement[]; cutMethod: string;
}> {
  if (!input.onomatopoeia.length && !input.ambient.length) {
    return {
      pieces: [{ src: "tts", startMs: 0, endMs: null }], clauses: [input.cnTtsText],
      boundaries: [], cutMethod: "whole-clause", thinking: "",
      reason: "无拟声或环境音，整段中文保留，选定后进入编辑并整体拉伸",
    };
  }
  const cuts = chineseSpliceClauses({
    text: input.cnTtsText, ...input.cnAudio,
    words: input.cnAsr.words.length ? input.cnAsr.words : input.cnAsr.utterances.flatMap((row) => row.words),
  });
  const clauses = cuts.clauses;
  const speechStart = input.speech[0]?.startMs ?? 0;
  const speechEnd = input.speech[input.speech.length - 1]?.endMs ?? speechStart;
  const weights = clauses.map((clause) => stripCn(clause.text).length || 1);
  const weightSum = weights.reduce((total, value) => total + value, 0);
  let seen = 0;
  const jpCuts: number[] = [];
  for (let i = 0; i < clauses.length - 1; i += 1) {
    seen += weights[i];
    jpCuts.push(speechStart + (speechEnd - speechStart) * seen / weightSum);
  }
  const gaps: SplicePiece[][] = Array.from({ length: clauses.length + 1 }, () => []);
  const place = (src: "ono" | "env", index: number, span: TimeSpan) => {
    gaps[gapForSpan(span, clauses.length, speechStart, speechEnd, jpCuts)].push({ src, index });
  };
  input.onomatopoeia.forEach((span, index) => place("ono", index, span));
  input.ambient.forEach((span, index) => {
    if (input.onomatopoeia.some((ono) => ono.startMs < span.endMs && span.startMs < ono.endMs)) return;
    place("env", index, span);
  });
  const byTime = (left: SplicePiece, right: SplicePiece) => {
    const time = (piece: SplicePiece) => (
      piece.src === "ono" ? input.onomatopoeia[piece.index]?.startMs ?? 0
        : piece.src === "env" ? input.ambient[piece.index]?.startMs ?? 0
          : 0
    );
    return time(left) - time(right);
  };
  const pieces: SplicePiece[] = [];
  for (let i = 0; i < clauses.length; i += 1) {
    pieces.push(...gaps[i].sort(byTime));
    pieces.push({ src: "tts", startMs: clauses[i].startMs, endMs: i === clauses.length - 1 ? null : clauses[i].endMs });
  }
  pieces.push(...gaps[clauses.length].sort(byTime));
  return {
    pieces,
    clauses: clauses.map((clause) => clause.text),
    boundaries: cuts.adjustments,
    cutMethod: cuts.method,
    thinking: "",
    reason: cuts.method === "unreliable-alignment"
      ? "中文字轴无法可靠定位分段，保留整段正文，不按字数猜切口"
      : clauses.length <= 1
        ? "中文正文一段，整段保留，不因日文多段而强切"
        : `按中文自身分隔符和波形切成 ${clauses.length} 段，保留句间静音：${clauses.map((clause) => clause.text).join(" / ")}`,
  };
}
