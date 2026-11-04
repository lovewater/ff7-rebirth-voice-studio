import { readFileSync, writeFileSync } from "node:fs";

function parseWavPcm16(buffer) {
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
    if (kind === "fmt " && size >= 16) {
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
  return {
    sampleRate,
    channels,
    blockAlign,
    dataOffset,
    frames: Math.floor(dataBytes / blockAlign),
  };
}

function timing(buffer) {
  const wav = parseWavPcm16(buffer);
  const duration = wav.frames / wav.sampleRate;
  let peak = 0;
  const samples = new Float64Array(wav.frames);
  for (let frame = 0; frame < wav.frames; frame += 1) {
    let sum = 0;
    for (let ch = 0; ch < wav.channels; ch += 1) {
      sum += buffer.readInt16LE(wav.dataOffset + frame * wav.blockAlign + ch * 2) / 32768;
    }
    samples[frame] = sum / wav.channels;
    peak = Math.max(peak, Math.abs(samples[frame]));
  }
  const threshold = peak * 0.1;
  let first = 0;
  while (first < wav.frames && Math.abs(samples[first]) < threshold) first += 1;
  let last = wav.frames - 1;
  while (last >= first && Math.abs(samples[last]) < threshold) last -= 1;
  return {
    start: first / wav.sampleRate,
    end: (last + 1) / wav.sampleRate,
    duration,
    speech: (last + 1 - first) / wav.sampleRate,
    wav,
  };
}

const path = process.argv[2];
const buf = readFileSync(path);
const before = timing(buf);
const wav = before.wav;
const endFrame = Math.max(1, Math.ceil(before.end * wav.sampleRate));
if (endFrame >= wav.frames) {
  console.log(JSON.stringify({ skipped: true, ...before }));
  process.exit(0);
}
const keepBytes = endFrame * wav.blockAlign;
const out = Buffer.alloc(wav.dataOffset + keepBytes);
buf.copy(out, 0, 0, wav.dataOffset + keepBytes);
out.writeUInt32LE(out.length - 8, 4);
out.writeUInt32LE(keepBytes, wav.dataOffset - 4);
writeFileSync(path, out);
const after = timing(out);
console.log(JSON.stringify({ before, after: { start: after.start, end: after.end, duration: after.duration, speech: after.speech } }));
