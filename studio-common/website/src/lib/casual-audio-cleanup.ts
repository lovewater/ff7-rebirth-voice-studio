import { createHash } from "node:crypto";
import type { QwenAsrResult, QwenAlignmentItem } from "./qwen-asr";

export type CasualPreservedEdge = {
  side: "head" | "tail";
  startFrame: number;
  endFrame: number;
  kind: "nonverbal" | "unclassified";
  jpText?: string;
  zhText?: string;
};
export type CasualAudioCleanupPlan = {
  version: 1;
  enabled: boolean;
  reason: string;
  originalTextZh: string;
  bodyTextZh: string;
  bodyTextJp: string;
  bodyStartFrame: number;
  bodyEndFrame: number;
  sourceFrames: number;
  sampleRate: number;
  sourcePcmSha256: string;
  preserved: CasualPreservedEdge[];
  removedChinesePrefix: string;
  removedChineseSuffix: string;
  evidence: Record<string, unknown>;
};

const SR = 24000;
const QUIET_MS = 250;
const WORD_GUARD_MS = 80;
const MIN_EXTRA_SOUND_MS = 100;
const MIN_BODY_ACTIVITY_MS = 20;
const QUIET_RATIO = .005;
type Pcm = { frames: number; sampleRate: number; payload: Buffer };
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Keep PCM bytes: decode/encode via floating samples would lose positive LSBs. */
function pcm(wav: Buffer): Pcm {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("普通清理需要PCM WAV");
  let format = false, payload: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), name = wav.toString("ascii", at, at + 4);
    // FFmpeg's pipe WAV uses an unknown terminal data size. Actual received PCM
    // frames are authoritative; ordinary corrupt finite chunk sizes still fail.
    const streamingData = name === "data" && size === 0xffffffff;
    const end = streamingData ? wav.length : at + 8 + size;
    if (end > wav.length) throw new Error("PCM WAV块超出文件");
    if (name === "fmt ") {
      if (size < 16 || wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1
        || wav.readUInt32LE(at + 12) !== SR || wav.readUInt16LE(at + 20) !== 2 || wav.readUInt16LE(at + 22) !== 16)
        throw new Error("普通清理只接受24k单声道PCM16");
      format = true;
    }
    if (name === "data") {
      if (payload) throw new Error("PCM WAV含多个data块");
      payload = wav.subarray(at + 8, end);
    }
    at = end + size % 2;
  }
  if (!format || !payload || !payload.length || payload.length % 2) throw new Error("PCM WAV没有完整音频帧");
  return { frames: payload.length / 2, sampleRate: SR, payload };
}

function wavFromPcm(payload: Buffer) {
  const wav = Buffer.alloc(44 + payload.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + payload.length, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(payload.length, 40); payload.copy(wav, 44);
  return wav;
}

export function comparableCasualJapanese(text: string) {
  return [...text.normalize("NFKC")].map(c => c >= "ァ" && c <= "ヶ" ? String.fromCharCode(c.charCodeAt(0) - 96) : c)
    .join("").replace(/[\s\p{P}\p{S}]/gu, "");
}
const normalize = comparableCasualJapanese;
export function casualCleanupTextMatches(expected: string, actual: string) {
  const left = normalize(expected), right = normalize(actual);
  return !!left && left === right;
}

type TextEdge = { token: string; raw: string; body: string };
function textEdge(text: string, side: "head" | "tail"): TextEdge | null {
  // Only explicit separators, never strip a Japanese word's first character.
  const match = side === "head"
    ? /^(\s*)([\p{L}]+)([\s、，,。.!?！？…～〜ー:：;；]+)/u.exec(text)
    : /([\s、，,。.!?！？…～〜ー:：;；]+)([\p{L}]+)([\s、，,。.!?！？…～〜ー:：;；]*)$/u.exec(text);
  if (!match) return null;
  const raw = match[0], body = side === "head" ? text.slice(raw.length) : text.slice(0, text.length - raw.length);
  return { token: match[2], raw, body };
}

function compatible(jp: string, zh: string) {
  const a = normalize(jp), b = normalize(zh);
  return ((a === "あ" || a === "ああ" || a === "あっ") && /^(啊|啊啊)$/u.test(b))
    || ((a === "お" || a === "おお") && /^(哦|噢|哦哦)$/u.test(b))
    || (a === "うん" && b === "嗯")
    || (/^は{2,6}$/u.test(a) && /^哈{2,6}$/u.test(b))
    || (/^ふ{2,6}$/u.test(a) && /^呵{2,6}$/u.test(b));
}

function hasUnpairedChineseNonverbal(text: string, side: "head" | "tail") {
  // Blocking only: never delete Chinese from this heuristic. An untranscribed
  // Japanese edge might already be written in Chinese and would otherwise play
  // once as preserved audio and again in TTS. Unlike deletion, blocking needs
  // no separator: reject uncertain "嗯你好" / "（咳咳）你好" too.
  const value = text.normalize("NFKC").replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
  return side === "head"
    ? /^[啊哦噢嗯唔呃哎唉哼哈呵嘿呼嘻哟呀嗷咳喘呜咕嗝嘶哧噗呸呕吼哇嘤嘘]{1,6}/u.test(value)
    : /[啊哦噢嗯唔呃哎唉哼哈呵嘿呼嘻哟呀嗷咳喘呜咕嗝嘶哧噗呸呕吼哇嘤嘘]{1,6}$/u.test(value);
}

type Quiet = { start: number; end: number };
function waveform(source: Pcm) {
  let peak = 0;
  for (let i = 0; i < source.frames; i++) peak = Math.max(peak, Math.abs(source.payload.readInt16LE(i * 2)));
  const threshold = Math.max(1, peak * QUIET_RATIO), quiet: Quiet[] = [];
  let start: number | null = null;
  for (let i = 0; i <= source.frames; i++) {
    const silent = i < source.frames && Math.abs(source.payload.readInt16LE(i * 2)) <= threshold;
    if (silent && start === null) start = i;
    if (!silent && start !== null) {
      if (i - start >= SR * QUIET_MS / 1000) quiet.push({ start, end: i });
      start = null;
    }
  }
  return { peak, threshold, quiet };
}

function soundFrames(source: Pcm, threshold: number, start: number, end: number) {
  let count = 0;
  for (let i = Math.max(0, start); i < Math.min(end, source.frames); i++)
    if (Math.abs(source.payload.readInt16LE(i * 2)) > threshold) count++;
  return count;
}

function matchingWordBoundary(words: QwenAlignmentItem[], length: number, side: "head" | "tail") {
  let count = 0;
  const order = side === "head" ? words : [...words].reverse();
  for (let i = 0; i < order.length; i++) {
    count += normalize(order[i].text).length;
    if (count === length) return i + 1;
    if (count > length) return null;
  }
  return null;
}

/** Conservative edge-only cleanup. Never infer an interior bilingual insertion. */
export function planCasualAudioCleanup(input: { audio: Buffer; textJp: string; textZh: string; asr: QwenAsrResult; allowUnclassifiedEdges?: boolean }): CasualAudioCleanupPlan {
  const source = pcm(input.audio);
  const plan: CasualAudioCleanupPlan = {
    version: 1, enabled: false, reason: "没有可确认的独立首尾原声", originalTextZh: input.textZh,
    bodyTextZh: input.textZh, bodyTextJp: input.textJp, bodyStartFrame: 0, bodyEndFrame: source.frames,
    sourceFrames: source.frames, sampleRate: SR, sourcePcmSha256: hash(source.payload), preserved: [],
    removedChinesePrefix: "", removedChineseSuffix: "", evidence: { quietMs: QUIET_MS, wordGuardMs: WORD_GUARD_MS, peakRatio: QUIET_RATIO, edgeOnly: true },
  };
  const noop = (reason: string): CasualAudioCleanupPlan => ({ ...plan, enabled: false, reason,
    bodyTextZh: input.textZh, bodyTextJp: input.textJp, bodyStartFrame: 0, bodyEndFrame: source.frames,
    preserved: [], removedChinesePrefix: "", removedChineseSuffix: "" });
  const alignment = input.asr.alignment;
  if (!input.textZh.trim() || !normalize(input.textJp) || !normalize(input.asr.text)) return noop("正文或ASR为空，不做原声清理");
  if (!alignment || alignment.status !== "ok" || alignment.time_unit !== "seconds" || !alignment.items.length)
    return noop("没有成功的ForcedAligner字词轴，不做清理");
  if (alignment.model !== "Qwen/Qwen3-ForcedAligner-0.6B" || !["japanese", "ja", "ja-jp"].includes((input.asr.language || "").toLowerCase()))
    return noop("对齐模型或识别语言不匹配，不做清理");
  const words = alignment.items;
  let previousEnd = 0;
  for (const word of words) {
    if (!normalize(word.text) || !Number.isFinite(word.start_time) || !Number.isFinite(word.end_time)
      || word.start_time < 0 || word.end_time <= word.start_time || word.start_time < previousEnd
      || word.end_time * SR > source.frames) return noop("字词轴存在零宽、倒序、重叠或越界，不做清理");
    previousEnd = word.end_time;
  }
  if (normalize(words.map(w => w.text).join("")) !== normalize(input.asr.text)
    || normalize(input.textJp) !== normalize(input.asr.text)) return noop("日文稿、ASR和字词轴正文不能精确闭合，不做清理");
  const wave = waveform(source);
  if (!wave.peak) return noop("原音PCM全零，不由清理器判断处理");
  const guard = SR * WORD_GUARD_MS / 1000, minGap = SR * QUIET_MS / 1000;
  let firstWord = 0, lastWord = words.length;
  const pickQuiet = (low: number, high: number, side: "head" | "tail") => {
    const candidates = wave.quiet.map(q => ({ start: Math.max(q.start, Math.ceil(low)), end: Math.min(q.end, Math.floor(high)) }))
      .filter(q => q.end - q.start >= minGap);
    return side === "head" ? candidates.at(-1) : candidates[0];
  };
  for (const side of ["head", "tail"] as const) {
    const jp = textEdge(plan.bodyTextJp, side), zh = textEdge(plan.bodyTextZh, side);
    if (!jp || !zh || !normalize(jp.body) || !normalize(zh.body) || !compatible(jp.token, zh.token)) continue;
    const count = matchingWordBoundary(words.slice(firstWord, lastWord), normalize(jp.token).length, side);
    if (!count || count >= lastWord - firstWord) continue;
    const left = side === "head" ? words[firstWord + count - 1] : words[lastWord - count - 1];
    const right = side === "head" ? words[firstWord + count] : words[lastWord - count];
    const quiet = pickQuiet(left.end_time * SR + guard, right.start_time * SR - guard, side);
    if (!quiet) continue;
    const cut = Math.floor((quiet.start + quiet.end) / 2);
    if (side === "head") {
      plan.bodyStartFrame = cut; firstWord += count; plan.removedChinesePrefix = zh.raw;
      plan.preserved.push({ side, startFrame: 0, endFrame: cut, kind: "nonverbal", jpText: jp.token, zhText: zh.token });
    } else {
      plan.bodyEndFrame = cut; lastWord -= count; plan.removedChineseSuffix = zh.raw;
      plan.preserved.push({ side, startFrame: cut, endFrame: source.frames, kind: "nonverbal", jpText: jp.token, zhText: zh.token });
    }
    plan.bodyTextJp = jp.body; plan.bodyTextZh = zh.body;
  }
  // Untranscribed edge sounds may only be preserved when every official word
  // is independently accounted for above. They remain unclassified, not AED truth.
  if (input.allowUnclassifiedEdges === true && plan.bodyStartFrame === 0 && !hasUnpairedChineseNonverbal(plan.bodyTextZh, "head")) {
    const quiet = pickQuiet(0, words[firstWord].start_time * SR - guard, "head");
    if (quiet && soundFrames(source, wave.threshold, 0, quiet.start) >= SR * MIN_EXTRA_SOUND_MS / 1000) {
      const cut = Math.floor((quiet.start + quiet.end) / 2);
      plan.bodyStartFrame = cut; plan.preserved.push({ side: "head", startFrame: 0, endFrame: cut, kind: "unclassified" });
    }
  }
  if (input.allowUnclassifiedEdges === true && plan.bodyEndFrame === source.frames && !hasUnpairedChineseNonverbal(plan.bodyTextZh, "tail")) {
    const quiet = pickQuiet(words[lastWord - 1].end_time * SR + guard, source.frames, "tail");
    if (quiet && soundFrames(source, wave.threshold, quiet.end, source.frames) >= SR * MIN_EXTRA_SOUND_MS / 1000) {
      const cut = Math.floor((quiet.start + quiet.end) / 2);
      plan.bodyEndFrame = cut; plan.preserved.push({ side: "tail", startFrame: cut, endFrame: source.frames, kind: "unclassified" });
    }
  }
  if (plan.bodyEndFrame <= plan.bodyStartFrame || !normalize(plan.bodyTextJp) || !normalize(plan.bodyTextZh))
    return noop("清理不能留下可靠非空正文，不做清理");
  let bodyPeak = 0, bodyActivityFrames = 0;
  if (plan.preserved.length) {
    for (let i = plan.bodyStartFrame; i < plan.bodyEndFrame; i++)
      bodyPeak = Math.max(bodyPeak, Math.abs(source.payload.readInt16LE(i * 2)));
    // Use the body's own amplitude, so a loud retained laugh does not turn
    // genuine weak body speech into "silence". A zero body or isolated spike
    // cannot become a clone reference even if ASR hallucinated a matching word.
    const bodyThreshold = Math.max(1, Math.min(wave.threshold, bodyPeak * QUIET_RATIO));
    bodyActivityFrames = soundFrames(source, bodyThreshold, plan.bodyStartFrame, plan.bodyEndFrame);
    if (bodyActivityFrames < SR * MIN_BODY_ACTIVITY_MS / 1000)
      return noop("清理后的正文缺少非孤立PCM活动，不做清理");
  }
  plan.enabled = plan.preserved.length > 0;
  plan.reason = plan.enabled ? "字轴正文闭合并有独立低能量切口，仅保留确认的首尾原声" : plan.reason;
  plan.evidence = { ...plan.evidence, bodyWordStart: firstWord, bodyWordEnd: lastWord, sourceWordCount: words.length,
    matchedReferenceText: true, matchedAsrAxis: true, allowUnclassifiedEdges: input.allowUnclassifiedEdges === true, threshold: wave.threshold,
    bodyPeak, bodyActivityFrames, minBodyActivityMs: MIN_BODY_ACTIVITY_MS };
  return plan;
}

function validateSource(originalWav: Buffer, plan: CasualAudioCleanupPlan) {
  const source = pcm(originalWav);
  if (source.frames !== plan.sourceFrames || hash(source.payload) !== plan.sourcePcmSha256
    || plan.sampleRate !== SR || !Number.isSafeInteger(plan.bodyStartFrame) || !Number.isSafeInteger(plan.bodyEndFrame)
    || plan.bodyStartFrame < 0 || plan.bodyEndFrame > source.frames || plan.bodyEndFrame <= plan.bodyStartFrame)
    throw new Error("原声或清理帧区间与证据不一致");
  return source;
}

export function extractCasualBodyReference(originalWav: Buffer, plan: CasualAudioCleanupPlan): Buffer {
  const source = validateSource(originalWav, plan);
  return plan.enabled ? wavFromPcm(source.payload.subarray(plan.bodyStartFrame * 2, plan.bodyEndFrame * 2)) : Buffer.from(originalWav);
}

export function restoreCasualScript(plan: CasualAudioCleanupPlan, bodyDraft: string): string {
  if (!bodyDraft.trim()) throw new Error("普通正文稿为空");
  return plan.enabled ? plan.removedChinesePrefix + bodyDraft + plan.removedChineseSuffix : bodyDraft;
}

export function assembleCasualOriginalEdges(originalWav: Buffer, ttsBodyWav: Buffer, plan: CasualAudioCleanupPlan) {
  const source = validateSource(originalWav, plan), body = pcm(ttsBodyWav);
  const budget = plan.bodyEndFrame - plan.bodyStartFrame;
  if (body.frames > budget + Math.ceil(SR * .001)) throw new Error("中文正文超过扣除原声后的总长上限，不能剪正文或缩放原声");
  const head = source.payload.subarray(0, plan.bodyStartFrame * 2), tail = source.payload.subarray(plan.bodyEndFrame * 2);
  const payload = Buffer.concat([head, body.payload, tail]), outputFrames = payload.length / 2;
  if (outputFrames > source.frames + Math.ceil(SR * .001)) throw new Error("回拼成品超过原声总长上限");
  const audio = wavFromPcm(payload);
  if (!audio.subarray(44, 44 + head.length).equals(head) || !audio.subarray(audio.length - tail.length).equals(tail))
    throw new Error("保留首尾原声PCM字节验证失败");
  const preserved = plan.preserved.map(edge => ({ ...edge, frames: edge.endFrame - edge.startFrame,
    sha256: hash(source.payload.subarray(edge.startFrame * 2, edge.endFrame * 2)),
    outputStartFrame: edge.side === "head" ? 0 : plan.bodyStartFrame + body.frames,
    outputEndFrame: edge.side === "head" ? plan.bodyStartFrame : outputFrames }));
  return { audio, metadata: { version: 1, pcmExact: true, sourcePcmSha256: plan.sourcePcmSha256,
    sourceFrames: source.frames, outputFrames, sampleRate: SR, bodyStartFrame: plan.bodyStartFrame, bodyEndFrame: plan.bodyEndFrame,
    bodyFrames: body.frames, preserved } };
}
