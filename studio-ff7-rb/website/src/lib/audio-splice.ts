import { spawn } from "node:child_process";
import { ALIGN_SILENCE_RATIO, AMBIENT_MIN_MS, AMBIENT_PEAK, AMBIENT_VAD_MS, FX_HI, FX_LO, LENGTH_SLACK_S, SCALE_HI, SCALE_LO, SILENCE_MAX_RATIO, SILENCE_MIN_RATIO } from "./auto-run-rules";
import { decodeWavMono, encodeWavMono, stretchWav } from "./wav-stretch";
import type { OnoPlan, SplicePiece, TimeSpan } from "./auto-run-onomatopoeia";

const FADE_S = 0.03;

function isRiffWav(buffer: Buffer) {
  return buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

function ffmpegToWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "24000", "-f", "wav", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk) => chunks.push(chunk as Buffer));
    proc.stderr.on("data", (chunk) => errChunks.push(chunk as Buffer));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(errChunks).toString("utf8") || `ffmpeg ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export async function audioToMonoWav(input: Buffer): Promise<Buffer> {
  if (isRiffWav(input)) {
    const { sampleRate, samples } = decodeWavMono(input);
    if (sampleRate === 24000) return encodeWavMono(sampleRate, samples);
  }
  return ffmpegToWav(input);
}

export function sliceWav(buffer: Buffer, startS: number, endS: number): Buffer {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const from = Math.max(0, Math.round(startS * sampleRate));
  const to = Math.min(samples.length, Math.round(Math.max(startS, endS) * sampleRate));
  if (to <= from) return encodeWavMono(sampleRate, new Float32Array(Math.max(1, Math.round(0.02 * sampleRate))));
  return encodeWavMono(sampleRate, samples.subarray(from, to));
}

export function silenceWav(sampleRate: number, seconds: number): Buffer {
  const n = Math.max(1, Math.round(Math.max(0, seconds) * sampleRate));
  return encodeWavMono(sampleRate, new Float32Array(n));
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const outLen = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(outLen);
  const scale = samples.length / outLen;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * scale;
    const i0 = Math.min(samples.length - 1, Math.floor(pos));
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

export function concatWavs(parts: Buffer[], fadeSec = FADE_S): Buffer {
  if (!parts.length) throw new Error("没有可拼接的音频");
  const decoded = parts.map((part) => decodeWavMono(part));
  const sr = decoded[0].sampleRate;
  const waves = decoded.map((row) => resampleLinear(row.samples, row.sampleRate, sr));
  const fade = Math.max(0, Math.round(fadeSec * sr));
  let total = 0;
  for (let i = 0; i < waves.length; i += 1) {
    total += waves[i].length;
    if (i > 0) total -= Math.min(fade, waves[i - 1].length, waves[i].length);
  }
  const out = new Float32Array(Math.max(1, total));
  let at = 0;
  for (let i = 0; i < waves.length; i += 1) {
    const cur = waves[i];
    const overlap = i === 0 ? 0 : Math.min(fade, cur.length, waves[i - 1].length, at);
    if (overlap > 0) at -= overlap;
    for (let k = 0; k < cur.length; k += 1) {
      const dst = at + k;
      if (k < overlap && overlap > 0) {
        const w = k / overlap;
        out[dst] = out[dst] * (1 - w) + cur[k] * w;
      } else {
        out[dst] = cur[k];
      }
    }
    at += cur.length;
  }
  return encodeWavMono(sr, out);
}

export function padOrKeep(buffer: Buffer, durationSec: number): Buffer {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const need = Math.max(1, Math.round(durationSec * sampleRate));
  if (samples.length >= need) return buffer;
  const next = new Float32Array(need);
  next.set(samples);
  return encodeWavMono(sampleRate, next);
}

/** Pad on the left so the mix ends on the JP slot. Longer mixes keep the tail. */
export function alignEnd(buffer: Buffer, durationSec: number): Buffer {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const need = Math.max(1, Math.round(durationSec * sampleRate));
  if (samples.length === need) return buffer;
  if (samples.length > need) return buffer;
  const next = new Float32Array(need);
  next.set(samples, need - samples.length);
  return encodeWavMono(sampleRate, next);
}

export function wavDuration(buffer: Buffer) {
  const { sampleRate, samples } = decodeWavMono(buffer);
  return samples.length / sampleRate;
}

function overlapsMs(a: TimeSpan, b: TimeSpan) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function filePeak(samples: Float32Array) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

function voicedRunsIn(samples: Float32Array, sampleRate: number, from: number, to: number, peak: number) {
  if (peak <= 1e-8 || to <= from) return [];
  const thr = peak * AMBIENT_PEAK;
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  const hang = Math.max(1, Math.round((AMBIENT_VAD_MS / 1000) * sampleRate));
  const minFrames = Math.max(1, Math.round((AMBIENT_MIN_MS / 1000) * sampleRate));
  const startFrame = Math.floor(from / frame);
  const endFrame = Math.ceil(to / frame);
  const active: boolean[] = [];
  for (let f = startFrame; f < endFrame; f += 1) {
    const a = Math.max(from, f * frame);
    const b = Math.min(to, (f + 1) * frame);
    let framePeak = 0;
    for (let i = a; i < b; i += 1) framePeak = Math.max(framePeak, Math.abs(samples[i]));
    active.push(framePeak >= thr);
  }
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < active.length) {
    if (!active[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < active.length) {
      if (active[j]) {
        j += 1;
        continue;
      }
      let k = j;
      while (k < active.length && !active[k]) k += 1;
      if (k < active.length && (k - j) * frame < hang) {
        j = k;
        continue;
      }
      break;
    }
    const start = Math.max(from, (startFrame + i) * frame);
    const end = Math.min(to, (startFrame + j) * frame);
    if (end - start >= minFrames) {
      const last = runs[runs.length - 1];
      if (last && start - last.end < hang) last.end = end;
      else runs.push({ start, end });
    }
    i = j;
  }
  return runs;
}

/** Keep 气口, drop leading/trailing true silence inside a planned cut. */
export function tightenVoicedSpan(buffer: Buffer, span: TimeSpan): TimeSpan | null {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const from = Math.max(0, Math.round((span.startMs / 1000) * sampleRate));
  const to = Math.min(samples.length, Math.round((span.endMs / 1000) * sampleRate));
  const runs = voicedRunsIn(samples, sampleRate, from, to, filePeak(samples));
  if (!runs.length) return null;
  return {
    ...span,
    startMs: Math.round((runs[0].start / sampleRate) * 1000),
    endMs: Math.round((runs[runs.length - 1].end / sampleRate) * 1000),
  };
}

function touchesOccupied(span: TimeSpan, occupied: TimeSpan[]) {
  return occupied.some((block) => (
    Math.abs(span.endMs - block.startMs) <= AMBIENT_MIN_MS
    || Math.abs(span.startMs - block.endMs) <= AMBIENT_MIN_MS
  ));
}

function keepAmbient(span: TimeSpan, occupied: TimeSpan[]) {
  const dur = span.endMs - span.startMs;
  if (dur >= AMBIENT_VAD_MS) return true;
  return dur >= AMBIENT_MIN_MS && touchesOccupied(span, occupied);
}

/** Voiced runs using the ambient VAD: ≥10% file peak, 200ms unless touching occupied. */
export function detectVoiced(buffer: Buffer, occupied: TimeSpan[], window?: TimeSpan, label = "环境音"): TimeSpan[] {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const peak = filePeak(samples);
  if (peak <= 1e-8) return [];
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const from = window ? Math.max(0, Math.round((window.startMs / 1000) * sampleRate)) : 0;
  const to = window ? Math.min(samples.length, Math.round((window.endMs / 1000) * sampleRate)) : samples.length;
  const runs = voicedRunsIn(samples, sampleRate, from, to, peak);
  const lo = window?.startMs ?? 0;
  const hi = window?.endMs ?? durationMs;
  return runs.flatMap((run) => {
    const span: TimeSpan = {
      startMs: Math.max(lo, Math.round((run.start / sampleRate) * 1000)),
      endMs: Math.min(hi, Math.round((run.end / sampleRate) * 1000)),
      text: window?.text || label,
    };
    const clipped = occupied.reduce((cur, block) => {
      return cur.flatMap((piece) => {
        if (!overlapsMs(piece, block)) return [piece];
        const out: TimeSpan[] = [];
        if (piece.startMs < block.startMs) out.push({ ...piece, endMs: block.startMs });
        if (piece.endMs > block.endMs) out.push({ ...piece, startMs: block.endMs });
        return out.filter((row) => keepAmbient(row, occupied));
      });
    }, [span] as TimeSpan[]);
    return clipped.filter((row) => (
      row.endMs > row.startMs
      && row.startMs >= lo - 20
      && row.endMs <= hi + 20
      && keepAmbient(row, occupied)
    ));
  });
}

export function detectAmbient(buffer: Buffer, occupied: TimeSpan[]): TimeSpan[] {
  return detectVoiced(buffer, occupied);
}

export type MixSeg = {
  id: string;
  kind: string;
  buffer: Buffer;
  duration: number;
  scale: number;
  origDuration?: number;
};

export type MixFitStep = {
  name: "identity" | "silence" | "fx" | "speech";
  predicted: number;
  scales: Record<string, number>;
};

export type MixFit = {
  ok: boolean;
  step: MixFitStep["name"];
  scales: Record<string, number>;
  predicted: number;
  packed: number;
  target: number;
  slack: number;
  steps: MixFitStep[];
};

function audioClamp(value: number) {
  return Math.min(SCALE_HI, Math.max(SCALE_LO, value));
}

function fxClamp(value: number) {
  return Math.min(FX_HI, Math.max(FX_LO, value));
}

function clampForKind(kind: string, value: number) {
  if (kind === "edge-silence") return 1;
  if (kind === "onomatopoeia" || kind === "ambient") return fxClamp(value);
  return audioClamp(value);
}

function silenceFloor(seg: MixSeg) {
  return Math.max(0, (seg.origDuration ?? seg.duration) * SILENCE_MIN_RATIO);
}

function silenceCeil(seg: MixSeg) {
  return Math.max(silenceFloor(seg), (seg.origDuration ?? seg.duration) * SILENCE_MAX_RATIO);
}

function clampSilence(seg: MixSeg, duration: number) {
  return Math.min(silenceCeil(seg), Math.max(silenceFloor(seg), duration));
}

function indexesOf(segs: MixSeg[], kind: (seg: MixSeg) => boolean) {
  return segs.flatMap((seg, index) => (kind(seg) ? [index] : []));
}

/** Silence same-ratio 30%–400%, then FX 70%–130%, then speech 90%–110%. No LLM. */
export function fitMixToTarget(segs: MixSeg[], targetS: number, fitToleranceS = LENGTH_SLACK_S): MixFit {
  const base = segs.map((seg) => Math.max(seg.duration > 0 ? seg.duration : wavDuration(seg.buffer), 1e-6));
  const durs = base.slice();
  const packed = durs.reduce((sum, value) => sum + value, 0);
  const steps: MixFitStep[] = [];
  const scalesNow = () => Object.fromEntries(segs.map((seg, index) => [seg.id, durs[index] / base[index]]));
  const predicted = () => durs.reduce((sum, value) => sum + value, 0);
  const within = () => Math.abs(predicted() - targetS) <= fitToleranceS;
  const push = (name: MixFitStep["name"]) => {
    steps.push({ name, predicted: predicted(), scales: scalesNow() });
  };
  const done = (step: MixFitStep["name"]): MixFit => ({
    ok: within(),
    step,
    scales: scalesNow(),
    predicted: predicted(),
    packed,
    target: targetS,
    slack: LENGTH_SLACK_S,
    steps,
  });

  push("identity");
  if (!(targetS > 0) || !segs.length) return done("identity");

  const sil = indexesOf(segs, (seg) => seg.kind === "silence");
  if (sil.length) {
    const audioSum = durs.reduce((sum, value, index) => (segs[index].kind === "silence" ? sum : sum + value), 0);
    const origSum = sil.reduce((sum, index) => sum + (segs[index].origDuration ?? base[index]), 0);
    const k = origSum > 1e-9
      ? Math.min(SILENCE_MAX_RATIO, Math.max(SILENCE_MIN_RATIO, (targetS - audioSum) / origSum))
      : 1;
    for (const index of sil) {
      const orig = segs[index].origDuration ?? base[index];
      durs[index] = Math.min(orig * SILENCE_MAX_RATIO, Math.max(orig * SILENCE_MIN_RATIO, orig * k));
    }
  }
  push("silence");
  if (within()) return done("silence");

  const fx = indexesOf(segs, (seg) => seg.kind === "onomatopoeia" || seg.kind === "ambient");
  if (fx.length) {
    const fxSum = fx.reduce((sum, index) => sum + durs[index], 0);
    const k = fxSum > 1e-9
      ? fxClamp((targetS - (predicted() - fxSum)) / fxSum)
      : 1;
    for (const index of fx) durs[index] = base[index] * k;
  }
  push("fx");
  if (within()) return done("fx");

  const speech = indexesOf(segs, (seg) => seg.kind === "speech");
  if (speech.length) {
    const speechSum = speech.reduce((sum, index) => sum + durs[index], 0);
    const k = speechSum > 1e-9
      ? audioClamp((targetS - (predicted() - speechSum)) / speechSum)
      : 1;
    for (const index of speech) durs[index] = base[index] * k;
  }
  push("speech");
  return done("speech");
}

export function applyScales(segs: MixSeg[], scales: Record<string, number>) {
  return segs.map((seg) => {
    if (seg.kind === "silence") {
      const { sampleRate } = decodeWavMono(seg.buffer);
      const asked = (scales[seg.id] ?? seg.scale ?? 1) * seg.duration;
      const duration = clampSilence(seg, asked);
      return { ...seg, scale: duration / Math.max(seg.duration, 1e-6), buffer: silenceWav(sampleRate, duration), duration };
    }
    const scale = clampForKind(seg.kind, scales[seg.id] ?? seg.scale ?? 1);
    if (scale === 1) return { ...seg, scale };
    return { ...seg, scale, buffer: stretchWav(seg.buffer, scale), duration: seg.duration * scale };
  });
}

function clipForPiece(jpWav: Buffer, ttsWav: Buffer, plan: OnoPlan, piece: SplicePiece) {
  const ttsInfo = decodeWavMono(ttsWav);
  const ttsDurMs = Math.round((ttsInfo.samples.length / ttsInfo.sampleRate) * 1000);
  if (piece.src === "ono") {
    const span = plan.onomatopoeia[piece.index];
    return span ? sliceWav(jpWav, span.startMs / 1000, span.endMs / 1000) : null;
  }
  if (piece.src === "env") {
    const span = plan.ambient[piece.index];
    return span ? sliceWav(jpWav, span.startMs / 1000, span.endMs / 1000) : null;
  }
  return sliceWav(ttsWav, piece.startMs / 1000, (piece.endMs == null ? ttsDurMs : piece.endMs) / 1000);
}

function pieceJpRange(plan: OnoPlan, pieces: SplicePiece[], piece: SplicePiece, jpDurMs: number) {
  if (piece.src === "ono") {
    const span = plan.onomatopoeia[piece.index];
    return { startMs: span?.startMs ?? 0, endMs: span?.endMs ?? 0 };
  }
  if (piece.src === "env") {
    const span = plan.ambient[piece.index];
    return { startMs: span?.startMs ?? 0, endMs: span?.endMs ?? 0 };
  }
  const speechStart = plan.speech[0]?.startMs ?? 0;
  const speechEnd = plan.speech[plan.speech.length - 1]?.endMs ?? jpDurMs;
  const ttsPieces = pieces.filter((row) => row.src === "tts");
  const index = Math.max(0, ttsPieces.indexOf(piece));
  const n = Math.max(1, ttsPieces.length);
  return {
    startMs: Math.round(speechStart + (speechEnd - speechStart) * index / n),
    endMs: Math.round(speechStart + (speechEnd - speechStart) * (index + 1) / n),
  };
}

export function speechBoundsSamples(samples: Float32Array, peakRatio = ALIGN_SILENCE_RATIO) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak <= 1e-8) return null;
  const threshold = peak * peakRatio;
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  let last = samples.length - 1;
  while (last >= first && Math.abs(samples[last]) < threshold) last -= 1;
  if (last < first) return null;
  return { start: first, end: last + 1, peak, threshold };
}

export function jpEdgeSilence(jpWav: Buffer, slotS?: number) {
  const { sampleRate, samples } = decodeWavMono(jpWav);
  const bounds = speechBoundsSamples(samples);
  const durS = samples.length / sampleRate;
  const slot = slotS && slotS > 0 ? slotS : durS;
  if (!bounds) return { leadS: 0, tailS: Math.max(0, slot), startS: 0, endS: 0, durS, slotS: slot };
  const startS = bounds.start / sampleRate;
  const endS = Math.min(bounds.end / sampleRate, slot);
  return {
    leadS: startS,
    tailS: Math.max(0, slot - endS),
    startS,
    endS,
    durS,
    slotS: slot,
  };
}

/** Strip leading silence, then put `leadS` of silence in front. Keeps the rest of the clip. */
export function setLeadWav(buffer: Buffer, leadS: number) {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const bounds = speechBoundsSamples(samples);
  const body = bounds ? samples.subarray(bounds.start) : samples;
  const lead = Math.max(0, Math.round(Math.max(0, leadS) * sampleRate));
  const out = new Float32Array(lead + body.length);
  out.set(body, lead);
  return encodeWavMono(sampleRate, out);
}

/** Strip trailing silence, then put `tailS` of silence at the end. Keeps the rest of the clip. */
export function setTailWav(buffer: Buffer, tailS: number) {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const bounds = speechBoundsSamples(samples);
  const body = bounds ? samples.subarray(0, bounds.end) : samples;
  const tail = Math.max(0, Math.round(Math.max(0, tailS) * sampleRate));
  const out = new Float32Array(body.length + tail);
  out.set(body, 0);
  return encodeWavMono(sampleRate, out);
}

/** Same as the editor's 自动对齐: park first sound at `leadS`, pad/trim to `durS`. */
export function alignWavToSlot(buffer: Buffer, leadS: number, durS: number) {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const bounds = speechBoundsSamples(samples);
  if (!bounds) throw new Error("成品里听不到说话，无法对齐");
  const lead = Math.max(0, Math.round(Math.max(0, leadS) * sampleRate));
  const body = samples.subarray(bounds.start);
  const speechLen = bounds.end - bounds.start;
  let next = new Float32Array(lead + body.length);
  next.set(body, lead);
  const target = Math.max(1, Math.round(Math.max(0, durS) * sampleRate));
  const speechEnd = lead + speechLen;
  if (next.length < target) {
    const padded = new Float32Array(target);
    padded.set(next);
    next = padded;
  } else if (next.length > target) {
    next = speechEnd <= target ? next.subarray(0, target) : next.subarray(0, speechEnd);
  }
  return encodeWavMono(sampleRate, next);
}

/** First lead / last tail match JP edges, then middle gaps stay at original JP silence. */
export function mixSegments(jpWav: Buffer, ttsWav: Buffer, plan: OnoPlan, pieces: SplicePiece[], jpDurS: number): MixSeg[] {
  const { sampleRate } = decodeWavMono(jpWav);
  const jpDurMs = Math.round(jpDurS * 1000);
  const edge = jpEdgeSilence(jpWav, jpDurS);
  if (!plan.onomatopoeia.length && !plan.ambient.length && pieces.length && pieces.every((piece) => piece.src === "tts")) {
    // 无拟声同样必须经过最终时长校正。整段正文只保留一次，不能先补齐总长静音，
    // 否则 fitMixToTarget 会误以为已经对齐，从而跳过实际发声的 90%–110% 微调。
    // 首尾只恢复日文原有的静音，固定不缩放；内部停顿留在正文中，不凭 ASR 空档造静音。
    const decoded = decodeWavMono(ttsWav);
    const bounds = speechBoundsSamples(decoded.samples, 0.005);
    if (!bounds) throw new Error("正文成品没有有效发声，无法校正时长");
    const body = encodeWavMono(decoded.sampleRate, decoded.samples.subarray(bounds.start, bounds.end));
    const result: MixSeg[] = [];
    if (edge.leadS > 0) result.push({ id: "edge-lead", kind: "edge-silence", buffer: silenceWav(decoded.sampleRate, edge.leadS), duration: edge.leadS, scale: 1 });
    result.push({ id: "tts-whole", kind: "speech", buffer: body, duration: wavDuration(body), scale: 1 });
    if (edge.tailS > 0) result.push({ id: "edge-tail", kind: "edge-silence", buffer: silenceWav(decoded.sampleRate, edge.tailS), duration: edge.tailS, scale: 1 });
    return result;
  }
  const events = pieces.flatMap((piece, index) => {
    const clip = clipForPiece(jpWav, ttsWav, plan, piece);
    if (!clip) return [];
    const jp = pieceJpRange(plan, pieces, piece, jpDurMs);
    const kind = piece.src === "tts" ? "speech" : piece.src === "env" ? "ambient" : "onomatopoeia";
    return [{
      index,
      jp,
      fromJp: piece.src !== "tts",
      audio: {
        id: `${piece.src}-${index}`,
        kind,
        buffer: clip,
        duration: wavDuration(clip),
        scale: 1,
      } satisfies MixSeg,
    }];
  });
  if (!events.length) return [];
  const first = events[0];
  const last = events[events.length - 1];
  const origFirstEnd = first.jp.endMs;
  if (first === last) {
    first.audio.buffer = alignWavToSlot(first.audio.buffer, edge.leadS, jpDurS);
  } else {
    if (first.fromJp) {
      const from = edge.startS;
      const to = Math.max(from + 0.02, origFirstEnd / 1000);
      first.audio.buffer = sliceWav(jpWav, from, to);
    }
    first.audio.buffer = setLeadWav(first.audio.buffer, edge.leadS);
    last.audio.buffer = setTailWav(last.audio.buffer, edge.tailS);
  }
  first.audio.duration = wavDuration(first.audio.buffer);
  last.audio.duration = wavDuration(last.audio.buffer);
  first.jp.startMs = 0;
  last.jp.endMs = jpDurMs;
  const segs: MixSeg[] = [];
  events.forEach((event, index) => {
    segs.push(event.audio);
    if (index >= events.length - 1) return;
    const orig = Math.max(0, (events[index + 1].jp.startMs - events[index].jp.endMs) / 1000);
    if (orig <= 0.0005) return;
    segs.push({
      id: `sil-${index + 1}`,
      kind: "silence",
      buffer: silenceWav(sampleRate, orig),
      duration: orig,
      scale: 1,
      origDuration: orig,
    });
  });
  return segs;
}

export function spliceMix(jpWav: Buffer, ttsWav: Buffer, plan: OnoPlan, pieces: SplicePiece[], jpDurS: number) {
  const edge = jpEdgeSilence(jpWav, jpDurS);
  const packed = mixSegments(jpWav, ttsWav, plan, pieces, jpDurS);
  if (!packed.length) throw new Error("拼接结果是空的");
  // 纯正文选定后的编辑要实际尽量对齐，不能因候选已经落在 ±200ms 内就跳过拉伸。
  // 此处只收紧编辑目标，不改变编辑前的候选标准，也不由编辑结果触发 TTS 重试。
  const wholeSpeech = packed.some((seg) => seg.id === "tts-whole");
  const fitted = fitMixToTarget(packed, jpDurS, wholeSpeech ? 1 / decodeWavMono(ttsWav).sampleRate : LENGTH_SLACK_S);
  const segs = applyScales(packed, fitted.scales);
  const actual = segs.reduce((sum, seg) => sum + seg.duration, 0);
  const audio = concatWavs(segs.map((seg) => seg.buffer), 0);
  const wavS = wavDuration(audio);
  const ok = Math.abs(actual - jpDurS) <= LENGTH_SLACK_S && Math.abs(wavS - jpDurS) <= LENGTH_SLACK_S;
  return {
    // 纯正文不再用额外尾静音补足余差，保留真实的最终文件长度供检查与试听。
    audio: (plan.onomatopoeia.length || plan.ambient.length) && ok && wavS < jpDurS ? padOrKeep(audio, jpDurS) : audio,
    ok,
    fit: {
      ...fitted,
      actual_s: actual,
      wav_s: wavS,
      align_silence_ratio: ALIGN_SILENCE_RATIO,
      jp_lead_s: edge.leadS,
      jp_tail_s: edge.tailS,
      jp_start_s: edge.startS,
      jp_end_s: edge.endS,
      silence_min_ratio: SILENCE_MIN_RATIO,
      silence_max_ratio: SILENCE_MAX_RATIO,
      fx_lo: FX_LO,
      fx_hi: FX_HI,
      speech_lo: SCALE_LO,
      speech_hi: SCALE_HI,
      silences: packed.filter((seg) => seg.kind === "silence").map((seg) => ({
        id: seg.id,
        orig_s: seg.origDuration,
        packed_s: seg.duration,
        scale: fitted.scales[seg.id] ?? 1,
      })),
      segments: packed.map((seg) => ({
        id: seg.id,
        kind: seg.kind,
        packed_s: Number(seg.duration.toFixed(4)),
        scale: Number((fitted.scales[seg.id] ?? 1).toFixed(4)),
      })),
    },
  };
}
