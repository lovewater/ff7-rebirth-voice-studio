/** Browser-side PCM edits for generated TTS clips. */

import { alignmentDetectionSignal } from "./alignment-transients";
import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";
import { stretchBrowserSamples } from "./rubberband-browser";

export function mixMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  if (channels === 1) {
    out.set(buffer.getChannelData(0));
    return out;
  }
  for (let c = 0; c < channels; c += 1) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i += 1) out[i] += ch[i] / channels;
  }
  return out;
}

export function bufferFromMono(ctx: AudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const out = ctx.createBuffer(1, samples.length, sampleRate);
  out.getChannelData(0).set(samples);
  return out;
}

function clampIndex(n: number, len: number) {
  if (n < 0) return 0;
  if (n > len) return len;
  return n | 0;
}

/** 对时首末边界：先忽略符合约定的孤立微弱凸起，再按原峰值5%定位；end不含。 */
export function speechBounds(samples: Float32Array, sampleRate?: number): { start: number; end: number } | null {
  const signal = alignmentDetectionSignal(samples, sampleRate ?? 0);
  samples = signal.samples;
  const peak = signal.peak;
  if (peak <= 1e-8) return null;
  const threshold = peak * ALIGN_SILENCE_RATIO;
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  let last = samples.length - 1;
  while (last >= first && Math.abs(samples[last]) < threshold) last -= 1;
  if (last < first) return null;
  return { start: first, end: last + 1 };
}

/** Park speech at JP 起. Pad/trim trailing silence to JP 长; if speech overruns, drop only the tail silence. */
export function alignToJpSlot(
  ctx: AudioContext,
  buffer: AudioBuffer,
  slot: { start: number; dur: number },
): AudioBuffer {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const bounds = speechBounds(src, sr);
  if (!bounds) throw new Error("成品里听不到说话，无法对齐");
  const lead = Math.max(0, Math.round(slot.start * sr));
  const body = src.subarray(bounds.start);
  const speechLen = bounds.end - bounds.start;
  let next = new Float32Array(lead + body.length);
  next.set(body, lead);
  const target = Math.max(1, Math.round(slot.dur * sr));
  const speechEnd = lead + speechLen;
  if (next.length < target) {
    const padded = new Float32Array(target);
    padded.set(next);
    next = padded;
  } else if (next.length > target) {
    next = speechEnd <= target ? next.subarray(0, target) : next.subarray(0, speechEnd);
  }
  return bufferFromMono(ctx, next, sr);
}

export function insertSilence(ctx: AudioContext, buffer: AudioBuffer, atSec: number, durSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const at = clampIndex(Math.round(atSec * sr), src.length);
  const extra = Math.max(0, Math.round(durSec * sr));
  if (!extra) return bufferFromMono(ctx, src, sr);
  const next = new Float32Array(src.length + extra);
  next.set(src.subarray(0, at), 0);
  next.set(src.subarray(at), at + extra);
  return bufferFromMono(ctx, next, sr);
}

function resampleMono(src: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return src;
  const n = Math.max(1, Math.round((src.length * toRate) / fromRate));
  const out = new Float32Array(n);
  const last = src.length - 1;
  for (let i = 0; i < n; i += 1) {
    const x = (i * fromRate) / toRate;
    const i0 = Math.min(last, Math.floor(x));
    const i1 = Math.min(last, i0 + 1);
    const t = x - i0;
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
}

export function sliceClip(ctx: AudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const a = clampIndex(Math.round(Math.min(startSec, endSec) * sr), src.length);
  const b = clampIndex(Math.round(Math.max(startSec, endSec) * sr), src.length);
  if (b - a < 8) throw new Error("选区太短");
  return bufferFromMono(ctx, src.subarray(a, b), sr);
}

export function insertClip(ctx: AudioContext, dest: AudioBuffer, atSec: number, clip: AudioBuffer): AudioBuffer {
  const sr = dest.sampleRate;
  const dst = mixMono(dest);
  let src = mixMono(clip);
  if (clip.sampleRate !== sr) src = resampleMono(src, clip.sampleRate, sr);
  const at = clampIndex(Math.round(atSec * sr), dst.length);
  const next = new Float32Array(dst.length + src.length);
  next.set(dst.subarray(0, at), 0);
  next.set(src, at);
  next.set(dst.subarray(at), at + src.length);
  return bufferFromMono(ctx, next, sr);
}

export function scaleGain(
  ctx: AudioContext,
  buffer: AudioBuffer,
  gain: number,
  startSec?: number,
  endSec?: number,
): AudioBuffer {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const next = new Float32Array(src);
  let a = 0;
  let b = src.length;
  if (startSec != null && endSec != null) {
    a = clampIndex(Math.round(Math.min(startSec, endSec) * sr), src.length);
    b = clampIndex(Math.round(Math.max(startSec, endSec) * sr), src.length);
  }
  const g = Number.isFinite(gain) ? gain : 1;
  for (let i = a; i < b; i += 1) {
    const x = src[i] * g;
    next[i] = x > 1 ? 1 : x < -1 ? -1 : x;
  }
  return bufferFromMono(ctx, next, sr);
}

export function deleteRange(ctx: AudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const a = clampIndex(Math.round(Math.min(startSec, endSec) * sr), src.length);
  const b = clampIndex(Math.round(Math.max(startSec, endSec) * sr), src.length);
  if (b - a < 8) return bufferFromMono(ctx, src, sr);
  const next = new Float32Array(src.length - (b - a));
  next.set(src.subarray(0, a), 0);
  next.set(src.subarray(b), a);
  return bufferFromMono(ctx, next, sr);
}

/** G / Rubber Band R3 short-window, without pitch shift. ratio = output/input duration. */
export async function stretchRange(
  ctx: AudioContext,
  buffer: AudioBuffer,
  ratio: number,
  startSec: number,
  endSec: number,
): Promise<AudioBuffer> {
  const sr = buffer.sampleRate;
  const src = mixMono(buffer);
  const a = clampIndex(Math.round(Math.min(startSec, endSec) * sr), src.length);
  const b = clampIndex(Math.round(Math.max(startSec, endSec) * sr), src.length);
  if (b - a < 8) throw new Error("选区太短");
  const stretched = mixMono(await stretchDuration(ctx, bufferFromMono(ctx, src.subarray(a, b), sr), ratio));
  const next = new Float32Array(a + stretched.length + (src.length - b));
  next.set(src.subarray(0, a), 0);
  next.set(stretched, a);
  next.set(src.subarray(b), a + stretched.length);
  return bufferFromMono(ctx, next, sr);
}

export async function stretchDuration(ctx: AudioContext, buffer: AudioBuffer, ratio: number): Promise<AudioBuffer> {
  const sr = buffer.sampleRate;
  const input = mixMono(buffer);
  const output = await stretchBrowserSamples(input, sr, ratio);
  return bufferFromMono(ctx, output, sr);
}

export async function stretchToSeconds(ctx: AudioContext, buffer: AudioBuffer, targetSec: number): Promise<AudioBuffer> {
  if (!(targetSec > 0.05)) throw new Error("目标时长太短");
  return stretchDuration(ctx, buffer, targetSec / buffer.duration);
}

export function encodeWavPcm16(buffer: AudioBuffer): ArrayBuffer {
  const samples = mixMono(buffer);
  const sr = buffer.sampleRate;
  const n = samples.length;
  const bytes = n * 2;
  const out = new ArrayBuffer(44 + bytes);
  const view = new DataView(out);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    o += 2;
  }
  return out;
}

export function wavToBase64(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
