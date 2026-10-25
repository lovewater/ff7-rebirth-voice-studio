export type ReferenceSpan = { startMs: number; endMs: number };
export type PcmLayout = { sampleRate: number; blockAlign: number; dataOffset: number; dataBytes: number };
export type KeptFrames = { sourceStart: number; sourceEnd: number; targetStart: number; targetEnd: number };
// 仅用于参考音频首尾裁静音。低于对时用的 5% 门槛，尽量保留弱起音/尾音。
const REFERENCE_EDGE_PEAK_RATIO = 0.005;

/**
 * 自动运行参考音频：删除已确认的拟声、环境音，再裁首尾静音。
 * 其他 PCM 帧原样、按原顺序保留。正文之间的静音是原始节奏的一部分：
 * 不按“正文列表”重建、不造零静音、不估算停顿、不淡化或重编码。
 * 输出帧数严格等于原帧数减去删除区间并集及首尾裁量，未删样本逐字节不变。
 * 输入必须先由调用方解析为 PCM WAV；这里保留其采样率、声道和头。
 */
export function buildSpeechReference(wav: Buffer, pcm: PcmLayout, remove: {
  onomatopoeia: ReferenceSpan[];
  ambient: ReferenceSpan[];
  preservedTail?: ReferenceSpan;
  speech?: ReferenceSpan[];
}) {
  const { sampleRate, blockAlign, dataOffset, dataBytes } = pcm;
  if (!(sampleRate > 0) || !(blockAlign > 0) || blockAlign % 2 !== 0 || dataOffset < 8 || dataBytes % blockAlign !== 0
    || dataOffset + dataBytes > wav.length) throw new Error("参考音频不是有效的 PCM WAV");
  const frames = dataBytes / blockAlign;
  const cuts = [...remove.onomatopoeia, ...remove.ambient, ...(remove.preservedTail ? [remove.preservedTail] : [])].map((span) => {
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.endMs <= span.startMs) {
      throw new Error("参考音频删除区间无效");
    }
    return {
      start: Math.max(0, Math.min(frames, Math.round(span.startMs * sampleRate / 1000))),
      end: Math.max(0, Math.min(frames, Math.round(span.endMs * sampleRate / 1000))),
    };
  }).filter((span) => span.end > span.start).sort((a, b) => a.start - b.start);
  // 先合并重叠区间，避免拟声和环境音交叠时重复扣除同一段。
  const merged: typeof cuts = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else merged.push({ ...cut });
  }
  const kept: KeptFrames[] = [];
  let cursor = 0;
  let outputFrames = 0;
  const keep = (end: number) => {
    if (end <= cursor) return;
    kept.push({ sourceStart: cursor, sourceEnd: end, targetStart: outputFrames, targetEnd: outputFrames + end - cursor });
    outputFrames += end - cursor;
  };
  for (const cut of merged) {
    keep(cut.start);
    cursor = cut.end;
  }
  keep(frames);
  if (!outputFrames) throw new Error("去掉拟声和环境音后参考音频为空");
  const payload = Buffer.concat(kept.map((span) => wav.subarray(
    dataOffset + span.sourceStart * blockAlign, dataOffset + span.sourceEnd * blockAlign,
  )));
  const framePeak = (frame: number) => {
    let peak = 0;
    for (let channelOffset = 0; channelOffset < blockAlign; channelOffset += 2) {
      peak = Math.max(peak, Math.abs(payload.readInt16LE(frame * blockAlign + channelOffset)));
    }
    return peak;
  };
  // 分段已经明确的首尾静音可能带有底噪，不能因底噪非零而留在参考头尾。
  // 先限定到首段正文至末段正文的外包络，再保守细裁其中的首尾余静音。
  // 只用正文的首尾边界，绝不据此删掉正文之间的静音。
  const body = remove.speech?.length ? {
    start: Math.round(Math.min(...remove.speech.map((span) => span.startMs)) * sampleRate / 1000),
    end: Math.round(Math.max(...remove.speech.map((span) => span.endMs)) * sampleRate / 1000),
  } : { start: 0, end: frames };
  const bodyRanges = kept.flatMap((part) => {
    const start = Math.max(body.start, part.sourceStart);
    const end = Math.min(body.end, part.sourceEnd);
    return end > start ? [{ start: part.targetStart + start - part.sourceStart, end: part.targetStart + end - part.sourceStart }] : [];
  });
  if (!bodyRanges.length) throw new Error("参考音频没有保留的正文");
  let first = bodyRanges[0].start;
  let last = bodyRanges[bodyRanges.length - 1].end;
  let peak = 0;
  for (let frame = first; frame < last; frame += 1) peak = Math.max(peak, framePeak(frame));
  if (!peak) throw new Error("参考音频没有可用的正文声音");
  const threshold = Math.max(1, peak * REFERENCE_EDGE_PEAK_RATIO);
  while (first < last && framePeak(first) < threshold) first += 1;
  while (last > first && framePeak(last - 1) < threshold) last -= 1;
  // 只裁整体首尾，绝不扫描、替换或压缩正文之间的静音。
  const retained = kept.flatMap((part) => {
    const start = Math.max(first, part.targetStart);
    const end = Math.min(last, part.targetEnd);
    return end > start ? [{
      sourceStart: part.sourceStart + start - part.targetStart,
      sourceEnd: part.sourceStart + end - part.targetStart,
      targetStart: start - first, targetEnd: end - first,
    }] : [];
  });
  const changed = merged.length > 0 || first > 0 || last < outputFrames;
  const audio = changed ? Buffer.concat([
    wav.subarray(0, dataOffset), payload.subarray(first * blockAlign, last * blockAlign),
  ]) : Buffer.from(wav);
  if (changed) {
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.writeUInt32LE((last - first) * blockAlign, dataOffset - 4);
  }
  return {
    audio, kept: retained, sourceFrames: frames, outputFrames: last - first,
    removedFrames: frames - outputFrames, trimmedLeadingFrames: first, trimmedTrailingFrames: outputFrames - last,
  };
}

/** 把正文时间映射到删段后的参考轴；不能沿用含已删除拟声的原时间跨度。 */
export function mapReferenceSpeech(speech: ReferenceSpan[], kept: KeptFrames[], sampleRate: number) {
  return speech.flatMap((span) => kept.flatMap((part) => {
    const start = Math.max(Math.round(span.startMs * sampleRate / 1000), part.sourceStart);
    const end = Math.min(Math.round(span.endMs * sampleRate / 1000), part.sourceEnd);
    return end > start ? [{
      startMs: (part.targetStart + start - part.sourceStart) * 1000 / sampleRate,
      endMs: (part.targetStart + end - part.sourceStart) * 1000 / sampleRate,
    }] : [];
  }));
}

/** 模型只做删除，不得借“去拟声”改写正文。忽略排版空白，保留标点检查。 */
export function requireDeletionOnlyScript(source: string, cleaned: unknown) {
  if (typeof cleaned !== "string" || !cleaned.trim()) throw new Error("模型没有返回去拟声后的中文正文");
  const original = [...source.normalize("NFKC").replace(/\s/gu, "")];
  const target = [...cleaned.normalize("NFKC").replace(/\s/gu, "")];
  let cursor = 0;
  for (const char of target) {
    while (cursor < original.length && original[cursor] !== char) cursor += 1;
    if (cursor === original.length) throw new Error("去拟声时模型改写了中文稿，只允许删除拟声及其关联标点");
    cursor += 1;
  }
  return cleaned.trim();
}
