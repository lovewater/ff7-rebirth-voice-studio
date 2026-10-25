import { createHash } from "node:crypto";
import { refinePerformanceBoundaries, type SegmentSpan } from "./speech-segmentation";
import { decodeWavMono, encodeWavMono } from "./wav-stretch";
import type { SeedAsrResult } from "./seed-asr";

export type PreservedTail = { version: 1; startMs: number; endMs: number; bodyWordCount: number;
  bodyEndMs: number; firstTailEvidenceMs: number; boundary: string; unclassified: true };
const normalize = (s: string) => s.normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")
  .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** 只认原字幕完整覆盖ASR前缀、且落在真实词边界；不凭字数/时间比例猜正文终点。
 * 正文后直到文件末尾都是未分类原声；不限制波形块数，不推断其语义或补字幕。
 */
export function locatePreservedTail(input: { samples: Float32Array; sampleRate: number;
  textJp: string; words: SeedAsrResult["words"]; blocks: SegmentSpan[] }): PreservedTail | null {
  const text = normalize(input.textJp), words = input.words;
  const duration = input.samples.length / input.sampleRate * 1000;
  if (!text || !words.length || !(input.sampleRate > 0) || !Number.isFinite(duration)) return null;
  if (words.some((w, i) => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start
    || w.start < 0 || (i > 0 && w.start < words[i - 1].start))) return null;
  let body = "", count = 0;
  for (const word of words) {
    body += normalize(word.text); count++;
    if (body === text) break;
    if (!text.startsWith(body)) return null;
  }
  if (body !== text) return null;
  const end = words[count - 1].end;
  if (end >= duration || input.blocks.some(b => b.startMs < end)) return null;
  const evidence = [...input.blocks.map(b => b.startMs), ...words.slice(count).map(w => w.start)]
    .filter(ms => ms > end && ms < duration);
  if (!evidence.length) return null;
  const first = Math.min(...evidence);
  const refined = refinePerformanceBoundaries({ ...input, onomatopoeia: [], subtitleClauses: [
    { startMs: words[0].start, endMs: end }, { startMs: first, endMs: duration },
  ] }).adjustments[0];
  // 必须有完整>=250ms真实静音；不将字轴空档或零交叉当作分界。
  if (!refined || refined.reason !== "silence-interval" || !refined.silence
    || refined.silence.endMs - refined.silence.startMs < 250
    || refined.cutMs < end || refined.cutMs >= first) return null;
  return { version: 1, startMs: refined.cutMs, endMs: duration, bodyWordCount: count,
    bodyEndMs: end, firstTailEvidenceMs: first, boundary: refined.reason, unclassified: true };
}

export function tailBodyAsr(asr: SeedAsrResult, tail: PreservedTail): SeedAsrResult {
  const all = asr.words.length ? asr.words : asr.utterances.flatMap(u => u.words);
  const words = all.slice(0, tail.bodyWordCount), text = words.map(w => w.text).join("");
  return { ...asr, text, words, durationMs: tail.startMs,
    utterances: [{ text, start: words[0].start, end: words.at(-1)!.end, words }] };
}

export function tailBodyAudio(jp: Buffer, tail: PreservedTail): Buffer {
  const d = decodeWavMono(jp), end = Math.round(tail.startMs * d.sampleRate / 1000);
  if (end <= 0 || end >= d.samples.length) throw new Error("尾段切口超出原音频");
  return encodeWavMono(d.sampleRate, d.samples.subarray(0, end));
}

/** 正文在自己的槽内装配；尾部从原PCM直接拷贝，起点/采样率/样本与原音一致。
 * 不允许裁发声凑槽，正文过长返回错误；偏短只在正文槽末补静音，尾声绝不变速。
 */
export function appendPreservedTail(jp: Buffer, body: Buffer, tail: PreservedTail) {
  const original = decodeWavMono(jp), generated = decodeWavMono(body), sr = original.sampleRate;
  const cut = Math.round(tail.startMs * sr / 1000);
  const frames = Math.round(generated.samples.length * sr / generated.sampleRate);
  let n = frames;
  if (frames > cut) {
    let peak = 0, excessPeak = 0;
    for (const sample of generated.samples) peak = Math.max(peak, Math.abs(sample));
    for (let i = Math.floor(cut * generated.sampleRate / sr); i < generated.samples.length; i++)
      excessPeak = Math.max(excessPeak, Math.abs(generated.samples[i]));
    if (frames - cut > Math.ceil(.05 * sr) || excessPeak > peak * .005)
      throw new Error("正文成品超过尾部原声固定起点，不能剪正文或移动尾段");
    n = cut; // 仅移除50ms内的已验证低电平舍入/尾部留白，不截正文发声。
  }
  const samples = original.samples.slice(); samples.fill(0, 0, cut);
  for (let i = 0; i < n; i++) {
    const position = i * generated.sampleRate / sr;
    const left = Math.min(generated.samples.length - 1, Math.floor(position));
    const right = Math.min(generated.samples.length - 1, left + 1), t = position - left;
    samples[i] = generated.samples[left] * (1 - t) + generated.samples[right] * t;
  }
  const audio = encodeWavMono(sr, samples);
  // 编码为PCM16后与原JP编码的同区间逐字节一致，连尾部留白也保留。
  let offset = 12, payload: Buffer | null = null;
  while (offset + 8 <= jp.length) {
    const size = jp.readUInt32LE(offset + 4);
    if (jp.toString("ascii", offset, offset + 4) === "data") {
      payload = jp.subarray(offset + 8, Math.min(jp.length, offset + 8 + size)); break;
    }
    offset += 8 + size + size % 2;
  }
  if (!payload || payload.length !== original.samples.length * 2) throw new Error("尾段原音必须是单声道PCM16");
  const sourceTail = payload.subarray(cut * 2);
  sourceTail.copy(audio, 44 + cut * 2);
  const savedTail = audio.subarray(44 + cut * 2), output = decodeWavMono(audio);
  if (!sourceTail.equals(savedTail)) throw new Error("保留尾段PCM校验失败");
  return { audio, metadata: { ...tail, sampleRate: sr, startFrame: cut,
    tailSha256: createHash("sha256").update(sourceTail).digest("hex"), pcmExact: true,
    originalFrames: original.samples.length, outputFrames: output.samples.length, trimmedQuietFrames: frames - n } };
}
