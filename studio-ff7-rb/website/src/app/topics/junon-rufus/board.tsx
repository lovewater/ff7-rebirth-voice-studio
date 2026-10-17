"use client";

import { reportTtsPlaybackSource } from "@/lib/tts-play-count";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBeats } from "@/app/lines/beat-count";
import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";
import { RATIO_HI, RATIO_LO, TARGET_RATIO, TOPIC_SECTIONS } from "@/lib/topics/junon-rufus";

export type TopicAudio = {
  id: string;
  text: string;
  speech: number | null;
  dur: number | null;
  start: number | null;
  factor: number | null;
  used: boolean;
};

export type TopicLine = {
  stem: string;
  speaker: string;
  name: string;
  section: string;
  textJp: string;
  textZh: string;
  italic: boolean;
  mode: string | null;
  jpStart: number | null;
  jpSpeech: number | null;
  jpDur: number | null;
  cnSpeech: number | null;
  draft: string;
  rewritten: boolean;
  latest: TopicAudio | null;
  used: { id: string; text: string; speech: number | null; factor: number | null } | null;
};

type HistoryRow = {
  id: number | string;
  tts_text: string | null;
  speech_s: number | null;
  dur_s: number | null;
  start_s: number | null;
  duration_factor: number | null;
  is_used: boolean | null;
  status: string;
};

let playing: HTMLAudioElement | null = null;

function compact(text: string) {
  return text.replace(/[\s\p{P}]+/gu, "");
}

function fmt(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "—" : value.toFixed(2);
}

function ratioClass(ratio: number | null) {
  if (ratio == null) return "text-zinc-500";
  return ratio >= RATIO_LO && ratio <= RATIO_HI ? "text-emerald-300" : Math.abs(ratio - TARGET_RATIO) <= 0.15 ? "text-amber-300" : "text-red-400";
}

function deltaClass(delta: number | null) {
  if (delta == null) return "text-zinc-500";
  const abs = Math.abs(delta);
  return abs <= 0.2 ? "text-emerald-300" : abs <= 0.4 ? "text-amber-300" : "text-red-400";
}

function play(src: string) {
  const url = new URL(src, location.href).href;
  if (playing && playing.src === url && !playing.paused) {
    playing.pause();
    return;
  }
  playing?.pause();
  const audio = new Audio(src);
  playing = audio;
  reportTtsPlaybackSource(src);
  void audio.play();
}

function WavePair({
  jpSrc,
  ttsSrc,
  jpStart,
  jpSpeech,
  jpDur,
  ttsStart,
  ttsSpeech,
  ttsDur,
}: {
  jpSrc: string;
  ttsSrc: string | null;
  jpStart: number | null;
  jpSpeech: number | null;
  jpDur: number | null;
  ttsStart: number | null;
  ttsSpeech: number | null;
  ttsDur: number | null;
}) {
  const [error, setError] = useState("");
  const jpRef = useRef<HTMLCanvasElement>(null);
  const ttsRef = useRef<HTMLCanvasElement>(null);
  const scale = Math.max(jpDur ?? 0, ttsDur ?? 0, 0.1);

  async function draw(src: string, canvas: HTMLCanvasElement, start: number | null, speech: number | null) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`音频 ${response.status}`);
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    await ctx.close();
    const data = buffer.getChannelData(0);
    const width = canvas.width;
    const height = canvas.height;
    const paint = canvas.getContext("2d");
    if (!paint) return;
    paint.clearRect(0, 0, width, height);
    paint.fillStyle = "#27272a";
    paint.fillRect(0, 0, width, height);
    if (start != null && speech != null && speech > 0) {
      const x = (start / scale) * width;
      const w = (speech / scale) * width;
      paint.fillStyle = "rgba(56,189,248,0.28)";
      paint.fillRect(x, 0, w, height);
    }
    paint.strokeStyle = "#e4e4e7";
    paint.beginPath();
    const samplesPerPx = Math.max(1, Math.floor((scale / width) * buffer.sampleRate));
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor((x / width) * scale * buffer.sampleRate);
      let peak = 0;
      for (let i = 0; i < samplesPerPx; i += 1) peak = Math.max(peak, Math.abs(data[from + i] ?? 0));
      const y = peak * (height / 2 - 2);
      paint.moveTo(x + 0.5, height / 2 - y);
      paint.lineTo(x + 0.5, height / 2 + y);
    }
    paint.stroke();
  }

  useEffect(() => {
    let active = true;
    setError("");
    void (async () => {
      try {
        if (jpRef.current) await draw(jpSrc, jpRef.current, jpStart, jpSpeech);
        if (!active) return;
        if (ttsSrc && ttsRef.current) await draw(ttsSrc, ttsRef.current, ttsStart, ttsSpeech);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "波形加载失败");
      }
    })();
    return () => { active = false; };
  }, [jpSrc, ttsSrc, jpStart, jpSpeech, ttsStart, ttsSpeech, scale]);

  return (
    <div className="mt-3 space-y-2">
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <p className="text-[11px] text-zinc-500">青底是测到的说话段。两条横轴按较长的一条对齐。</p>
      <div>
        <div className="mb-1 text-[11px] text-zinc-500">日文</div>
        <canvas ref={jpRef} width={900} height={72} className="h-16 w-full rounded bg-zinc-800" />
      </div>
      <div>
        <div className="mb-1 text-[11px] text-zinc-500">新稿</div>
        <canvas ref={ttsRef} width={900} height={72} className="h-16 w-full rounded bg-zinc-800" />
      </div>
    </div>
  );
}

function LineCard({
  line,
  text,
  audio,
  busy,
  error,
  onText,
  onGenerate,
  onAudio,
}: {
  line: TopicLine;
  text: string;
  audio: TopicAudio | null;
  busy: boolean;
  error: string;
  onText: (value: string) => void;
  onGenerate: () => void;
  onAudio: (audio: TopicAudio) => void;
}) {
  const { current } = useBeats(line.textJp, text, true);
  const ratio = current?.result?.normalizedRatio ?? null;
  const jpUnits = current?.result?.jp.units;
  const cnUnits = current?.result?.cn.units;
  const matched = audio != null && compact(audio.text) === compact(text);
  const speechDelta = matched && line.jpSpeech != null && audio.speech != null ? audio.speech - line.jpSpeech : null;
  const [wave, setWave] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState("");
  const [locked, setLocked] = useState(line.used);
  const lockedThis = Boolean(audio?.used && matched);
  const staleLock = !lockedThis && locked != null && compact(locked.text) !== compact(text);

  async function lock() {
    if (!audio) return;
    setLocking(true);
    setLockError("");
    try {
      const result = await patchTtsWithConfirmation(line.stem, audio.id, { isUsed: true });
      if (result) {
        onAudio({ ...audio, used: true });
        setLocked({ id: audio.id, text: audio.text, speech: audio.speech, factor: audio.factor });
      }
    } catch (reason) {
      setLockError(reason instanceof Error ? reason.message : "锁定失败");
    } finally {
      setLocking(false);
    }
  }

  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="font-medium text-zinc-200">{line.name}</span>
        <span>{line.mode === "field" ? "普通对话" : "场景演出"}</span>
        <Link href={`/line/${line.stem}`} target="_blank" className="hover:text-zinc-200">{line.stem}</Link>
      </div>
      <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-500 ${line.italic ? "italic" : ""}`}>{line.textJp || "（无日文）"}</p>
      <p className={`mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-400 ${line.italic ? "italic" : ""}`}>原中文：{line.textZh || "（空）"}</p>
      {locked ? (
        <p className={`mt-1 whitespace-pre-wrap text-sm leading-6 text-amber-100/90 ${line.italic ? "italic" : ""}`}>锁定：{locked.text || "（空）"}</p>
      ) : null}
      <textarea
        value={text}
        onChange={(event) => onText(event.target.value)}
        rows={Math.min(6, Math.max(2, text.split("\n").length + 1))}
        className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none focus:border-sky-600"
        aria-label={`${line.name}的 TTS 文字`}
      />
      <p className="mt-2 text-xs">
        <span className={ratioClass(ratio)}>
          比 {ratio == null ? (current?.error ? "—" : jpUnits == null && current?.result ? "短句" : "…") : ratio.toFixed(2)}
        </span>
        <span className="text-zinc-500"> · 目标 {TARGET_RATIO.toFixed(2)} · 日 {jpUnits ?? "—"} 拍 · 中 {cnUnits ?? "—"} 拍</span>
      </p>
      <p className="mt-1 text-xs text-zinc-400">
        说 日 {fmt(line.jpSpeech)} / 新 {matched ? fmt(audio?.speech) : "—"}
        <span className={deltaClass(speechDelta)}> · 差 {speechDelta == null ? "—" : `${speechDelta > 0 ? "+" : ""}${(speechDelta * 1000).toFixed(0)}ms`}</span>
        <span> · 拉伸 {matched ? fmt(audio?.factor) : "—"}</span>
        <span> · 长 日 {fmt(line.jpDur)} / 新 {matched ? fmt(audio?.dur) : "—"}</span>
      </p>
      {staleLock ? <p className="mt-1 text-xs text-amber-300">当前锁定的还是旧稿，听完新稿再锁定。</p> : null}
      {lockedThis ? <p className="mt-1 text-xs text-emerald-300">这版新稿已经锁定。</p> : null}
      {error || lockError ? <p className="mt-1 text-xs text-red-400">{error || lockError}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => play(`/api/audio/jp/${line.stem}`)} className="min-h-11 rounded bg-zinc-800 px-3 text-sm md:min-h-0 md:py-1 md:text-xs">日文</button>
        <button type="button" onClick={() => play(`/api/audio/cn/${line.stem}`)} className="min-h-11 rounded bg-zinc-800 px-3 text-sm md:min-h-0 md:py-1 md:text-xs">原中文</button>
        <button type="button" disabled={!locked} onClick={() => locked && play(`/api/lines/${line.stem}/tts/${locked.id}/audio`)} className="min-h-11 rounded bg-zinc-800 px-3 text-sm disabled:opacity-40 md:min-h-0 md:py-1 md:text-xs">锁定稿</button>
        <button type="button" disabled={!matched} onClick={() => matched && play(`/api/lines/${line.stem}/tts/${audio.id}/audio`)} className="min-h-11 rounded bg-zinc-800 px-3 text-sm disabled:opacity-40 md:min-h-0 md:py-1 md:text-xs">新稿</button>
        <button type="button" disabled={busy || !text.trim()} onClick={onGenerate} className="min-h-11 rounded bg-sky-800 px-3 text-sm text-white disabled:opacity-40 md:min-h-0 md:py-1 md:text-xs">{busy ? "生成中" : "生成"}</button>
        <button type="button" disabled={!matched || audio?.used || locking} onClick={() => void lock()} className="min-h-11 rounded bg-emerald-900 px-3 text-sm text-emerald-100 disabled:opacity-40 md:min-h-0 md:py-1 md:text-xs">{locking ? "锁定中" : "锁定"}</button>
        <button type="button" onClick={() => setWave((open) => !open)} className="min-h-11 rounded bg-zinc-800 px-3 text-sm md:min-h-0 md:py-1 md:text-xs">{wave ? "收起波形" : "波形"}</button>
      </div>
      {wave ? (
        <WavePair
          jpSrc={`/api/audio/jp/${line.stem}`}
          ttsSrc={matched ? `/api/lines/${line.stem}/tts/${audio.id}/audio` : null}
          jpStart={line.jpStart}
          jpSpeech={line.jpSpeech}
          jpDur={line.jpDur}
          ttsStart={audio?.start ?? null}
          ttsSpeech={audio?.speech ?? null}
          ttsDur={audio?.dur ?? null}
        />
      ) : null}
    </article>
  );
}

export function Board({ lines }: { lines: TopicLine[] }) {
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((line) => [line.stem, line.draft])));
  const [audios, setAudios] = useState<Record<string, TopicAudio | null>>(() => Object.fromEntries(lines.map((line) => [line.stem, line.latest])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [speaker, setSpeaker] = useState("全部");
  const [busyStem, setBusyStem] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const running = useRef(false);
  const names = useMemo(() => ["全部", ...Array.from(new Set(lines.map((line) => line.name)))], [lines]);

  async function generateOne(stem: string) {
    const line = lines.find((item) => item.stem === stem);
    const text = texts[stem] ?? "";
    setErrors((old) => ({ ...old, [stem]: "" }));
    const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttsText: text, durationFactor: 1 }),
      signal: AbortSignal.timeout(420000),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const historyResponse = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts`, { cache: "no-store" });
    const historyPayload = await historyResponse.json() as { history?: HistoryRow[]; error?: string };
    if (!historyResponse.ok) throw new Error(historyPayload.error || "读生成结果失败");
    const readyRows = (historyPayload.history ?? []).filter((item) => item.status === "ready" && compact(item.tts_text ?? "") === compact(text));
    const pool = readyRows.length ? readyRows : (historyPayload.history ?? []).filter((item) => item.status === "ready");
    const row = pool.reduce<HistoryRow | null>((best, item) => {
      if (!best) return item;
      const target = line?.jpSpeech;
      if (target == null || item.speech_s == null || best.speech_s == null) return best;
      return Math.abs(item.speech_s - target) < Math.abs(best.speech_s - target) ? item : best;
    }, null);
    if (!row) throw new Error("生成完成但没有可播放的版本");
    const audio: TopicAudio = {
      id: String(row.id),
      text: row.tts_text ?? text,
      speech: row.speech_s,
      dur: row.dur_s,
      start: row.start_s,
      factor: row.duration_factor,
      used: row.is_used === true,
    };
    setAudios((old) => ({ ...old, [stem]: audio }));
    if (compact(audio.text) !== compact(text)) setTexts((old) => ({ ...old, [stem]: audio.text }));
  }

  async function run(stems: string[]) {
    if (running.current || !stems.length) return;
    running.current = true;
    try {
      for (let index = 0; index < stems.length; index += 1) {
        const stem = stems[index];
        setBusyStem(stem);
        setProgress(`正在生成 ${index + 1}/${stems.length}`);
        try {
          await generateOne(stem);
        } catch (reason) {
          setErrors((old) => ({ ...old, [stem]: reason instanceof Error ? reason.message : "生成失败" }));
        }
      }
    } finally {
      running.current = false;
      setBusyStem(null);
      setProgress("");
    }
  }

  const pending = lines.filter((line) => {
    const text = texts[line.stem] ?? "";
    const audio = audios[line.stem];
    return text.trim() && (!audio || compact(audio.text) !== compact(text));
  }).map((line) => line.stem);

  const visible = speaker === "全部" ? lines : lines.filter((line) => line.name === speaker);

  return (
    <div className="mt-6">
      <div className="-mx-1 flex gap-1 overflow-x-auto pb-2">
        {names.map((name) => (
          <button key={name} type="button" onClick={() => setSpeaker(name)}
            className={`shrink-0 rounded-full px-3 py-2 text-sm ${speaker === name ? "bg-zinc-100 text-zinc-950" : "bg-zinc-900 text-zinc-300"}`}>
            {name}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" disabled={!!busyStem || !pending.length} onClick={() => void run(pending)}
          className="min-h-11 rounded bg-sky-700 px-4 text-sm text-white disabled:opacity-40">
          生成还没做的 {pending.length} 句
        </button>
        {progress ? <span className="text-sm text-sky-300">{progress}</span> : null}
      </div>
      {TOPIC_SECTIONS.map((section) => {
        const rows = visible.filter((line) => line.section === section.id);
        if (!rows.length) return null;
        return (
          <section key={section.id} id={section.id} className="mt-8 scroll-mt-4">
            <h2 className="text-lg font-medium">{section.title}</h2>
            <p className="mt-1 text-sm text-zinc-500">{section.blurb}</p>
            <div className="mt-3 space-y-3">
              {rows.map((line) => (
                <LineCard
                  key={line.stem}
                  line={line}
                  text={texts[line.stem] ?? ""}
                  audio={audios[line.stem] ?? null}
                  busy={busyStem === line.stem}
                  error={errors[line.stem] ?? ""}
                  onText={(value) => setTexts((old) => ({ ...old, [line.stem]: value }))}
                  onGenerate={() => void run([line.stem])}
                  onAudio={(audio) => setAudios((old) => ({ ...old, [line.stem]: audio }))}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
