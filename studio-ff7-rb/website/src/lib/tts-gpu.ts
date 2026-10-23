import { spawn } from "node:child_process";
import { ALIGN_SILENCE_RATIO } from "./auto-run-rules";
import { prepareTtsPronunciationBody } from "./tts-pronunciation-db";

export const TTS_URL = process.env.TTS_URL ?? "http://tts-proxy:8810";
// Website limits outstanding requests; Nginx alone manages GPU hosts and capacity.
export const TTS_URLS = (process.env.TTS_URLS ?? TTS_URL)
  .split(",").map((item) => item.trim()).filter(Boolean);
const ttsInflight = new Map<string, number>();
const ttsWaiters: Array<() => void> = [];
const configuredTtsLimit = Number(process.env.TTS_MAX_INFLIGHT ?? 8);
const ttsMaxInflight = Number.isSafeInteger(configuredTtsLimit) && configuredTtsLimit > 0
  ? configuredTtsLimit : 8;

export async function withTts<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const allowed = urls.length ? urls : TTS_URLS;
  if (!allowed.length) throw new Error("请配置 TTS_URL 或 TTS_URLS");
  for (;;) {
    const inflight = [...ttsInflight.values()].reduce((sum, count) => sum + count, 0);
    const url = inflight < ttsMaxInflight
      ? [...allowed].sort((a, b) => (ttsInflight.get(a) ?? 0) - (ttsInflight.get(b) ?? 0))[0]
      : undefined;
    if (url) {
      ttsInflight.set(url, (ttsInflight.get(url) ?? 0) + 1);
      try {
        return await fn(url);
      } finally {
        ttsInflight.set(url, (ttsInflight.get(url) ?? 1) - 1);
        ttsWaiters.shift()?.();
      }
    }
    await new Promise<void>((resolve) => ttsWaiters.push(resolve));
  }
}
export const PAUSE_RE = /\[停顿=(\d{1,4})\]/g;
export const PROMPT_TAIL_SILENCE_S = 0.3;

function linePieces(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isFlattenedLines(text: string, source: string) {
  const lines = linePieces(source);
  if (lines.length < 2) return false;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact === lines.join(" ") || compact === lines.join("") || compact === source.replace(/\s+/g, " ").trim();
}

/** Turn visual line breaks (or the space they collapsed into) into 句号. Keep one line for the GPU. */
export function punctuateLineBreaks(text: string, source?: string) {
  const raw = source && isFlattenedLines(text, source) ? source : text;
  const lines = linePieces(raw);
  if (lines.length < 2) return text.trim();
  return lines
    .map((line, i) => {
      if (i === lines.length - 1) return line;
      if (/[。！？，、；：…,.!?;:]$/.test(line)) return line;
      if (/\[停顿=\d{1,4}\]$/.test(line)) return line;
      return `${line}。`;
    })
    .join("");
}

export function normalizeScript(value: unknown, sourceZh?: string) {
  const ttsText = punctuateLineBreaks(typeof value === "string" ? value.trim() : "", sourceZh);
  if (!ttsText || ttsText.length > 2000) throw new Error("TTS 文字长度必须在 1 到 2000 字之间");
  let match: RegExpExecArray | null;
  PAUSE_RE.lastIndex = 0;
  while ((match = PAUSE_RE.exec(ttsText))) {
    const milliseconds = Number(match[1]);
    if (milliseconds < 50 || milliseconds > 5000) {
      throw new Error("停顿必须在 50 到 5000 毫秒之间");
    }
  }
  const textWithoutPauses = ttsText.replace(PAUSE_RE, "");
  const spokenText = textWithoutPauses.trim();
  if (!spokenText) throw new Error("TTS 文字不能只有停顿");
  if (textWithoutPauses.includes("[停顿")) {
    throw new Error("停顿格式应为 [停顿=500]");
  }
  return { ttsText, spokenText };
}

export function parseWavPcm16(buffer: Buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("TTS 返回的不是 RIFF WAV");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const kind = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (kind === "fmt " && size >= 16 && offset + 8 + size <= buffer.length) {
      audioFormat = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      blockAlign = buffer.readUInt16LE(offset + 20);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (kind === "data") {
      dataOffset = offset + 8;
      dataBytes = Math.min(size, buffer.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 1 || blockAlign < 2) {
    throw new Error("TTS WAV 必须是 PCM16");
  }
  return {
    sampleRate,
    channels,
    blockAlign,
    dataOffset,
    dataBytes,
    frames: Math.floor(dataBytes / blockAlign),
  };
}

export function wavTiming(buffer: Buffer, peakRatio = ALIGN_SILENCE_RATIO) {
  const wav = parseWavPcm16(buffer);
  const duration = wav.frames / wav.sampleRate;
  if (!wav.frames) return { start: 0, end: 0, duration, speech: 0 };

  const samples = new Float64Array(wav.frames);
  let peak = 0;
  for (let frame = 0; frame < wav.frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      sum += buffer.readInt16LE(wav.dataOffset + frame * wav.blockAlign + channel * 2) / 32768;
    }
    const sample = sum / wav.channels;
    samples[frame] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak <= 1e-8) return { start: 0, end: 0, duration, speech: 0 };
  const threshold = peak * peakRatio;
  let first = 0;
  while (first < wav.frames && Math.abs(samples[first]) < threshold) first += 1;
  let last = wav.frames - 1;
  while (last >= first && Math.abs(samples[last]) < threshold) last -= 1;
  if (last < first) return { start: 0, end: 0, duration, speech: 0 };
  const start = first / wav.sampleRate;
  const end = (last + 1) / wav.sampleRate;
  return { start, end, duration, speech: end - start };
}

/** 自动演出候选只裁整体首尾，不改发声和句间停顿，也不补静音。
 * 两端分别以实际送入 TTS 的日文正文参考为上限，不能用游戏槽或含拟声的整句。
 * 使用与参考细裁相同的 0.5% 门槛，保护弱起音/尾音；有效时长检查仍用既有 5% 波形口径。
 */
export function limitWavEdgeSilence(audio: Buffer, reference: Buffer) {
  const pcm = parseWavPcm16(audio);
  const before = wavTiming(audio, 0.005);
  const jp = wavTiming(reference, 0.005);
  if (!(before.speech > 0) || !(jp.speech > 0)) throw new Error("首尾裁静音失败：候选或日文参考没有有效发声");
  const leadingLimit = jp.start;
  const trailingLimit = Math.max(0, jp.duration - jp.end);
  const first = Math.max(0, Math.ceil((before.start - leadingLimit) * pcm.sampleRate - 1e-7));
  const last = Math.min(pcm.frames, Math.floor((before.end + trailingLimit) * pcm.sampleRate + 1e-7));
  const trimmed = first > 0 || last < pcm.frames;
  const result = trimmed ? Buffer.concat([
    audio.subarray(0, pcm.dataOffset),
    audio.subarray(pcm.dataOffset + first * pcm.blockAlign, pcm.dataOffset + last * pcm.blockAlign),
  ]) : Buffer.from(audio);
  if (trimmed) {
    result.writeUInt32LE(result.length - 8, 4);
    result.writeUInt32LE((last - first) * pcm.blockAlign, pcm.dataOffset - 4);
  }
  return { audio: result, meta: {
    version: "jp-reference-edge-cap-v1", leadingLimit, trailingLimit,
    trimmedLeading: first / pcm.sampleRate, trimmedTrailing: (pcm.frames - last) / pcm.sampleRate,
    before, after: wavTiming(result, 0.005),
  } };
}

function isRiffWav(buffer: Buffer) {
  return buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

function ffmpegToWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-f", "wav", "pipe:1"],
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

/** If speech-end to file-end is shorter than needSec, append silence. Same 10% peak rule as wavTiming. */
export function padWavTrailingSilence(buffer: Buffer, needSec = PROMPT_TAIL_SILENCE_S): Buffer {
  const wav = parseWavPcm16(buffer);
  const timing = wavTiming(buffer);
  const tail = Math.max(0, timing.duration - timing.end);
  const extra = needSec - tail;
  if (extra <= 0.001) return buffer;
  const extraBytes = Math.max(wav.blockAlign, Math.round(extra * wav.sampleRate) * wav.blockAlign);
  const out = Buffer.alloc(wav.dataOffset + wav.dataBytes + extraBytes);
  buffer.copy(out, 0, 0, wav.dataOffset + wav.dataBytes);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(wav.dataBytes + extraBytes, wav.dataOffset - 4);
  return out;
}

export async function ensurePromptTailSilence(input: Buffer, needSec = PROMPT_TAIL_SILENCE_S): Promise<Buffer> {
  const wav = isRiffWav(input) ? input : await ffmpegToWav(input);
  return padWavTrailingSilence(wav, needSec);
}

function absMonoFrames(buffer: Buffer): Float64Array {
  const wav = parseWavPcm16(buffer);
  const out = new Float64Array(wav.frames);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      sum += Math.abs(buffer.readInt16LE(wav.dataOffset + frame * wav.blockAlign + channel * 2) / 32768);
    }
    out[frame] = sum / wav.channels;
  }
  return out;
}

const ZERO_AMP = 1 / 32768;

function voicedAmps(buffer: Buffer): number[] {
  const abs = absMonoFrames(buffer);
  const voiced: number[] = [];
  for (let i = 0; i < abs.length; i += 1) {
    if (abs[i] > ZERO_AMP) voiced.push(abs[i]);
  }
  return voiced;
}

/** Mean of the loudest 10% of non-silent |samples|. Zeros are dropped first. */
export function peak10Mean(buffer: Buffer): number {
  const voiced = voicedAmps(buffer);
  if (!voiced.length) return 0;
  voiced.sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(voiced.length * 0.1));
  let sum = 0;
  for (let i = 0; i < k; i += 1) sum += voiced[i];
  return sum / k;
}

function scaleWavPcm16(buffer: Buffer, scale: number): Buffer {
  const wav = parseWavPcm16(buffer);
  const out = Buffer.from(buffer);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    for (let channel = 0; channel < wav.channels; channel += 1) {
      const offset = wav.dataOffset + frame * wav.blockAlign + channel * 2;
      let sample = (out.readInt16LE(offset) / 32768) * scale;
      if (sample > 1) sample = 1;
      if (sample < -1) sample = -1;
      out.writeInt16LE(Math.round(sample * 32767), offset);
    }
  }
  return out;
}

/** Match generated loudness to reference using top-10% mean; then cap peak so it does not clip. */
export function matchPeak10Loudness(generated: Buffer, reference: Buffer): Buffer {
  const refP = peak10Mean(reference);
  const genP = peak10Mean(generated);
  if (refP <= 1e-8 || genP <= 1e-8) return generated;
  let scale = refP / genP;
  const voiced = voicedAmps(generated);
  let genMax = 0;
  for (let i = 0; i < voiced.length; i += 1) if (voiced[i] > genMax) genMax = voiced[i];
  if (genMax * scale > 0.99) scale = 0.99 / genMax;
  if (scale > 4) scale = 4;
  if (scale < 0.05) scale = 0.05;
  if (Math.abs(scale - 1) < 0.01) return generated;
  return scaleWavPcm16(generated, scale);
}

/** Cut trailing silence so 长 ≈ 止. */
export function trimWavToSpeechEnd(buffer: Buffer): Buffer {
  const wav = parseWavPcm16(buffer);
  const timing = wavTiming(buffer);
  const endFrame = Math.max(1, Math.ceil(timing.end * wav.sampleRate));
  if (endFrame >= wav.frames) return buffer;
  const keepBytes = endFrame * wav.blockAlign;
  const out = Buffer.alloc(wav.dataOffset + keepBytes);
  buffer.copy(out, 0, 0, wav.dataOffset + keepBytes);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(keepBytes, wav.dataOffset - 4);
  return out;
}

export async function gpuJsonAt<T>(url: string, endpoint: string, body?: unknown, timeout = 1_200_000): Promise<T> {
  const response = await fetch(`${url}${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(await prepareTtsPronunciationBody(endpoint, body)),
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  const data = (await response.json().catch(() => ({}))) as T & { detail?: string; message?: string };
  if (!response.ok) throw new Error(data.detail || data.message || `GPU HTTP ${response.status}`);
  return data;
}

export async function gpuJson<T>(endpoint: string, body?: unknown, timeout = 1_200_000): Promise<T> {
  return gpuJsonAt(TTS_URL, endpoint, body, timeout);
}
