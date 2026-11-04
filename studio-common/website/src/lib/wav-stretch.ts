import { alignmentDetectionSignal } from "./alignment-transients";
import { parseWavPcm16 } from "./tts-gpu";

import { stretchSamples } from "./rubberband-server";
export { stretchSamples } from "./rubberband-server";

export function decodeWavMono(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
  const wav = parseWavPcm16(buffer);
  const samples = new Float32Array(wav.frames);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      sum += buffer.readInt16LE(wav.dataOffset + frame * wav.blockAlign + channel * 2) / 32768;
    }
    samples[frame] = sum / wav.channels;
  }
  return { sampleRate: wav.sampleRate, samples };
}

/** 对齐/拉伸专用时序，忽略孤立微弱凸起。不可替换净语速使用的wavTiming。 */
export function wavAlignmentTiming(buffer: Buffer) {
  const wave = decodeWavMono(buffer);
  const { samples, peak } = alignmentDetectionSignal(wave.samples, wave.sampleRate);
  const duration = samples.length / wave.sampleRate;
  let first = 0, end = samples.length;
  if (peak <= 1e-8) return { start: 0, end: 0, duration, speech: 0 };
  while (first < end && Math.abs(samples[first]) < peak * .05) first++;
  while (end > first && Math.abs(samples[end - 1]) < peak * .05) end--;
  return { start: first / wave.sampleRate, end: end / wave.sampleRate, duration, speech: (end - first) / wave.sampleRate };
}

export function encodeWavMono(sampleRate: number, samples: Float32Array): Buffer {
  const n = samples.length;
  const bytes = n * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(bytes, 40);
  for (let i = 0; i < n; i += 1) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(x < 0 ? x * 0x8000 : x * 0x7fff, 44 + i * 2);
  }
  return out;
}

export function stretchWav(buffer: Buffer, ratio: number): Buffer {
  if (ratio === 1) return buffer;
  const { sampleRate, samples } = decodeWavMono(buffer);
  return encodeWavMono(sampleRate, stretchSamples(samples, sampleRate, ratio));
}

export function padWavToDuration(buffer: Buffer, durationSec: number): Buffer {
  if (!(durationSec > 0)) return buffer;
  const { sampleRate, samples } = decodeWavMono(buffer);
  const need = Math.round(durationSec * sampleRate);
  if (need <= samples.length) return buffer;
  const next = new Float32Array(need);
  next.set(samples);
  return encodeWavMono(sampleRate, next);
}

/** Stretch only the spoken region, park it at JP 起, pad silence to JP 长. */
export function layoutSpeechWav(
  buffer: Buffer,
  speech: { start: number; end: number },
  stretch: number,
  slot: { start: number | null; dur: number | null },
): Buffer {
  const { sampleRate, samples } = decodeWavMono(buffer);
  const from = Math.max(0, Math.floor(speech.start * sampleRate));
  const to = Math.min(samples.length, Math.ceil(speech.end * sampleRate));
  if (to - from < sampleRate * 0.04) {
    let fallback = stretch === 1 ? buffer : stretchWav(buffer, stretch);
    if (slot.dur != null && slot.dur > 0) fallback = padWavToDuration(fallback, slot.dur);
    return fallback;
  }
  let body = samples.subarray(from, to);
  if (stretch !== 1) {
    body = stretchSamples(Float32Array.from(body), sampleRate, stretch);
  }
  const lead = Math.max(0, Math.round((slot.start ?? speech.start) * sampleRate));
  const slotFrames = slot.dur != null && slot.dur > 0 ? Math.round(slot.dur * sampleRate) : 0;
  const total = Math.max(lead + body.length, slotFrames, 1);
  const out = new Float32Array(total);
  const at = Math.min(lead, Math.max(0, total - body.length));
  out.set(body, at);
  return encodeWavMono(sampleRate, out);
}

function snap02(n: number) {
  return Math.round(n * 50) / 50;
}

function rangeSteps(from: number, to: number) {
  const lo = snap02(Math.min(from, to));
  const hi = snap02(Math.max(from, to));
  const steps: number[] = [];
  for (let x = lo; x <= hi + 1e-9; x += 0.02) steps.push(snap02(x));
  return steps;
}

/** Window is [hand-0.2, hand+0.2], step 0.02. 1 = already ok. */
export function pickSpeechStretch(got: number, target: number, okSlack = 0.2, hand = 1): number {
  if (!(got > 0) || !(target > 0)) return 1;
  if (Math.abs(got - target) <= okSlack) return 1;
  const center = Number.isFinite(hand) && hand > 0 ? hand : 1;
  const lo = Math.max(0.5, snap02(center - 0.2));
  const hi = Math.min(2, snap02(center + 0.2));
  const steps = got > target ? rangeSteps(lo, Math.min(1, hi)) : rangeSteps(Math.max(1, lo), hi);
  const list = steps.length ? steps : [got > target ? lo : hi];
  let best = list[0];
  let bestErr = Infinity;
  for (const step of list) {
    const err = Math.abs(got * step - target);
    if (err < bestErr) {
      bestErr = err;
      best = step;
    }
  }
  return best;
}
