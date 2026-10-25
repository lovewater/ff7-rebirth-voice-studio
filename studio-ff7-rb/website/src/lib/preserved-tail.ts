import { createHash } from "node:crypto";
import { refinePerformanceBoundaries, type SegmentSpan } from "./speech-segmentation";
import { decodeWavMono, encodeWavMono } from "./wav-stretch";
import type { SeedAsrResult } from "./seed-asr";

export type PreservedTail = { version: 1; startMs: number; endMs: number; bodyWordCount: number;
  bodyStartMs?: number; bodyWordStart?: number; headBoundary?: string;
  bodyEndMs: number; firstTailEvidenceMs: number; boundary: string; unclassified: true };
const normalize = (s: string) => s.normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")
  .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** 原字幕必须唯一、完整对应一段连续ASR词；头尾未分类声音分别整体保留。
 * 两侧都须真实>=250ms静音确认切口。正文内部未知声音仍交原流程，不跨过它猜切口。
 * 保留旧字段名兼容尾部历史记录：startMs是正文槽终点，bodyStartMs是其起点。
 */
export function locatePreservedTail(input: { samples: Float32Array; sampleRate: number;
  textJp: string; words: SeedAsrResult["words"]; blocks: SegmentSpan[] }): PreservedTail | null {
  const text = normalize(input.textJp), words = input.words;
  const duration = input.samples.length / input.sampleRate * 1000;
  if (!text || !words.length || !(input.sampleRate > 0) || !Number.isFinite(duration)) return null;
  if (words.some((w, i) => !normalize(w.text) || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start
    || w.start < 0 || w.end > duration || (i > 0 && w.start < words[i - 1].end))) return null;
  const matches: {start:number;end:number}[] = [];
  for (let start=0;start<words.length;start++) {
    let body="";
    for(let end=start;end<words.length;end++) {
      body+=normalize(words[end].text);
      if(body===text){matches.push({start,end:end+1});break;}
      if(!text.startsWith(body))break;
    }
  }
  if(matches.length!==1)return null;
  const {start,end}=matches[0], firstBody=words[start].start, lastBody=words[end-1].end;
  if(input.blocks.some(b=>b.startMs<lastBody && b.endMs>firstBody))return null;
  const headEvidence=[...input.blocks.filter(b=>b.endMs<=firstBody).map(b=>b.endMs),...words.slice(0,start).map(w=>w.end)];
  const tailEvidence=[...input.blocks.filter(b=>b.startMs>=lastBody).map(b=>b.startMs),...words.slice(end).map(w=>w.start)];
  if(!headEvidence.length&&!tailEvidence.length)return null;
  const cut=(left:SegmentSpan,right:SegmentSpan)=>{
    const r=refinePerformanceBoundaries({...input,onomatopoeia:[],subtitleClauses:[left,right]}).adjustments[0];
    return r?.reason==='silence-interval' && r.silence && r.silence.endMs-r.silence.startMs>=250
      && Math.min(r.silence.endMs,right.startMs)-Math.max(r.silence.startMs,left.endMs)>=250
      && r.cutMs>=left.endMs && r.cutMs<right.startMs
      && r.cutMs>r.silence.startMs && r.cutMs<r.silence.endMs ? r : null;
  };
  let bodyStart=0,bodyEnd=duration,headBoundary:string|undefined,tailBoundary='file-end';
  if(headEvidence.length){
    const last=Math.max(...headEvidence);
    const r=cut({startMs:0,endMs:last},{startMs:firstBody,endMs:lastBody});
    if(!r)return null;
    bodyStart=r.cutMs;headBoundary=r.reason;
  }
  if(tailEvidence.length){
    const first=Math.min(...tailEvidence);
    const r=cut({startMs:firstBody,endMs:lastBody},{startMs:first,endMs:duration});
    if(!r)return null;
    bodyEnd=r.cutMs;tailBoundary=r.reason;
  }
  return {version:1,startMs:bodyEnd,endMs:duration,bodyWordCount:end-start,
    ...(bodyStart ? {bodyStartMs:bodyStart,bodyWordStart:start,headBoundary} : {}),
    bodyEndMs:lastBody,firstTailEvidenceMs:tailEvidence.length?Math.min(...tailEvidence):duration,
    boundary:tailBoundary,unclassified:true};
}
export function preservedBodyDurationMs(edges: PreservedTail) { return edges.startMs-(edges.bodyStartMs??0); }

export function tailBodyAsr(asr: SeedAsrResult, tail: PreservedTail): SeedAsrResult {
  const all = asr.words.length ? asr.words : asr.utterances.flatMap(u => u.words);
  const offset=tail.bodyStartMs??0, start=tail.bodyWordStart??0;
  const words = all.slice(start, start+tail.bodyWordCount).map(w=>({...w,start:w.start-offset,end:w.end-offset})), text = words.map(w => w.text).join("");
  return { ...asr, text, words, durationMs: preservedBodyDurationMs(tail),
    utterances: [{ text, start: words[0].start, end: words.at(-1)!.end, words }] };
}

export function tailBodyAudio(jp: Buffer, tail: PreservedTail): Buffer {
  const d = decodeWavMono(jp), end = Math.round(tail.startMs * d.sampleRate / 1000), start=Math.round((tail.bodyStartMs??0)*d.sampleRate/1000);
  if (start<0 || end<=start || end>d.samples.length) throw new Error("尾段切口超出原音频");
  return encodeWavMono(d.sampleRate, d.samples.subarray(start, end));
}

/** 正文在自己的槽内装配；头尾从原PCM直接拷贝，起点/采样率/样本与原音一致。
 * 不允许裁发声凑槽，正文过长返回错误；偏短只在正文槽末补静音，尾声绝不变速。
 */
export function appendPreservedTail(jp: Buffer, body: Buffer, tail: PreservedTail) {
  const original = decodeWavMono(jp), generated = decodeWavMono(body), sr = original.sampleRate;
  const cut = Math.round(tail.startMs * sr / 1000), start=Math.round((tail.bodyStartMs??0)*sr/1000), slot=cut-start;
  if(start<0||slot<=0||cut>original.samples.length)throw new Error("原声头尾正文槽无效");
  const frames = Math.round(generated.samples.length * sr / generated.sampleRate);
  let n = frames;
  if (frames > slot) {
    let peak = 0, excessPeak = 0;
    for (const sample of generated.samples) peak = Math.max(peak, Math.abs(sample));
    for (let i = Math.floor(slot * generated.sampleRate / sr); i < generated.samples.length; i++)
      excessPeak = Math.max(excessPeak, Math.abs(generated.samples[i]));
    if (frames - slot > Math.ceil(.05 * sr) || excessPeak > peak * .005)
      throw new Error("正文成品超过原声头尾固定正文槽，不能剪正文或移动原声");
    n = slot; // 仅移除50ms内的已验证低电平舍入/尾部留白，不截正文发声。
  }
  const samples = original.samples.slice(); samples.fill(0, start, cut);
  for (let i = 0; i < n; i++) {
    const position = i * generated.sampleRate / sr;
    const left = Math.min(generated.samples.length - 1, Math.floor(position));
    const right = Math.min(generated.samples.length - 1, left + 1), t = position - left;
    samples[start+i] = generated.samples[left] * (1 - t) + generated.samples[right] * t;
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
  const sourceHead=payload.subarray(0,start*2);
  sourceHead.copy(audio,44);
  const sourceTail = payload.subarray(cut * 2);
  sourceTail.copy(audio, 44 + cut * 2);
  const savedTail = audio.subarray(44 + cut * 2), output = decodeWavMono(audio);
  if (!sourceHead.equals(audio.subarray(44,44+start*2)) || !sourceTail.equals(savedTail)) throw new Error("保留尾段PCM校验失败");
  return { audio, metadata: { ...tail, sampleRate: sr, startFrame: cut,
    bodyStartFrame:start, headSha256:createHash("sha256").update(sourceHead).digest("hex"),
    tailSha256: createHash("sha256").update(sourceTail).digest("hex"), pcmExact: true,
    originalFrames: original.samples.length, outputFrames: output.samples.length, trimmedQuietFrames: frames - n } };
}
