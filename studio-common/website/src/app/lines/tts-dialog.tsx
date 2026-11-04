"use client";

import { TtsReviewAction } from "@/components/tts-review-action";

import { reportTtsPlayback } from "@/lib/tts-play-count";

import { effectiveTtsSubtitle, ttsSubtitleDisplay } from "@/lib/tts-subtitle-display";

import { preferredTtsVersion } from "@/lib/tts-version-tree";
import { TtsVersionTree } from "@/components/tts-version-tree";

import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { notifyTtsChanged, TTS_CHANGED, TTS_SUBTITLE_AUTOFILLED } from "@/app/line/[stem]/versions";

import {
  langShort,
  parseTtsDefaults,
  sourceLangLabel,
  type EmoRef,
  type SeedVcRef,
  type TtsDefaults,
} from "@/lib/tts-defaults";
import { firstLine } from "@/lib/text";
import { BeatCount } from "./beat-count";
import { AutoRewriteButton } from "./rewrite-dialog";

type VoiceVersion = {
  id: number;
  source_lang: "jp" | "cn" | "en";
  gpu_speaker_key: string;
  created_at: string;
  engine_precision: string | null;
  engine_device: string | null;
};

type History = {
  parent_tts_id?: string | null;
  conversion_meta: {
    source_id?: number;
    reference_lang?: string;
    model?: string;
    reference_kind?: string;
    reference_mode?: string;
    jp_duration_s?: number;
    pipeline?: string;
    timbre_stem?: string;
    prompt_stem?: string;
    prompt_lang?: string;
    prompt_note?: string;
    chosen_factor?: number;
    timing_issue?: boolean;
  } | null;
  raw_audio_path: string | null;
  id: string;
  voice_version_id: number | null;
  voice_gpu_key: string;
  tts_text: string;
  spoken_text: string;
  subtitle_text: string | null;
  duration_factor: number;
  emo_alpha: number;
  audio_bytes: number | null;
  start_s: number | null;
  end_s: number | null;
  dur_s: number | null;
  speech_s: number | null;
  review_state: "candidate" | "locked" | "abnormal";
  status: "building" | "ready" | "failed";
  error: string | null;
  engine_precision: string | null;
  engine_device: string | null;
  created_at: string;
};

type Payload = {
  line: {
    stem: string;
    speaker: string | null;
    speaker_name: string | null;
    text_jp: string | null;
    text_zh: string | null;
    kind: string | null;
    subtitle_italic: boolean | null;
    dialogue_mode: "scene" | "field" | "mixed" | "unknown" | null;
  };
  versions: VoiceVersion[];
  history: History[];
  pauseSyntax: string;
  defaults: TtsDefaults;
  timbreRefs?: { id?: number; stem: string; jp_dur_s: number | null; text_jp: string | null; text_zh: string | null; note: string }[];
  nearbyRefs?: {
    id?: number;
    stem: string;
    offset: number;
    text_jp: string | null;
    text_zh: string | null;
    has_jp: boolean;
    has_cn: boolean;
  }[];
  hasEn?: boolean;
  hasJp?: boolean;
};

const LEGACY_EMBEDDING_TTS = false;

function dateText(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function durationText(value: number | null) {
  return value == null ? "—" : `${value.toFixed(2)}s`;
}

function quoteLabel(text: string | null | undefined, fallback: string) {
  return firstLine(text) || fallback;
}

function presetOptionLabel(id: number | undefined, lang: "jp" | "cn", note: string | null | undefined, stem: string) {
  const tag = lang === "cn" ? "中" : "日";
  const num = id != null ? `#${id} ` : "";
  return `${num}(${tag}):${quoteLabel(note, stem)}`;
}

function nearbyOptionLabel(id: number | undefined, offset: number, lang: "jp" | "cn", text: string | null, stem: string) {
  const n = offset > 0 ? `+${offset}` : String(offset);
  const tag = lang === "cn" ? "中" : "日";
  const num = id != null ? `#${id} ` : "";
  return `${num}${n} ·(${tag}):${quoteLabel(text, stem)}`;
}

function promptSearchHit(
  query: string,
  row: { id?: number; stem: string; note?: string | null; text_jp?: string | null; text_zh?: string | null },
) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const idq = q.replace(/^#/, "");
  return (
    (row.id != null && String(row.id) === idq) ||
    (row.id != null && `#${row.id}`.includes(q)) ||
    row.stem.toLowerCase().includes(q) ||
    (row.note ?? "").toLowerCase().includes(q) ||
    (row.text_jp ?? "").toLowerCase().includes(q) ||
    (row.text_zh ?? "").toLowerCase().includes(q)
  );
}

const DURATION_STEPS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2] as const;

function factorLabel(n: number) {
  return n.toFixed(2).replace(/0$/, "").replace(/\.$/, ".0");
}

export function TtsPanel({ stem }: { stem: string }) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptAudioRef = useRef<HTMLAudioElement | null>(null);
  const initialized = useRef(false);
  const [data, setData] = useState<Payload | null>(null);
  const [ttsText, setTtsText] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [voiceVersionId, setVoiceVersionId] = useState("");
  const [durationFactor, setDurationFactor] = useState("1");
  const [emoAlpha, setEmoAlpha] = useState("0.4");
  const [emoRef, setEmoRef] = useState<EmoRef>("jp");
  const [seedVcRef, setSeedVcRef] = useState<SeedVcRef>("auto");
  const [promptKey, setPromptKey] = useState("current");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [promptQuery, setPromptQuery] = useState("");

  async function load() {
    const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts`, { cache: "no-store" });
    const next = (await response.json()) as Payload & { error?: string };
    if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
    setData(next);
    if (!initialized.current) {
      initialized.current = true;
      const defaults = parseTtsDefaults(next.defaults);
      setTtsText(preferredTtsVersion(next.history)?.tts_text ?? next.line.text_zh ?? "");
      const preferred = defaults.voice_version_id;
      const hasPreferred = preferred != null && next.versions.some((row) => row.id === preferred);
      setVoiceVersionId(String(hasPreferred ? preferred : next.versions[0]?.id ?? ""));
      setDurationFactor(String(defaults.duration_factor));
      setEmoAlpha(String(defaults.emo_alpha));
      setEmoRef(defaults.emo_ref);
      setSeedVcRef(defaults.seed_vc_ref);
      const used = preferredTtsVersion(next.history);
      setSubtitleText(used?.subtitle_text ?? "");
    }
  }

  useEffect(() => {
    initialized.current = false;
    setPromptKey("current");
    let active = true;
    load()
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    function onChanged() {
      void load().catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    }
    function onSubtitleAutofilled(event: Event) {
      const detail = (event as CustomEvent<{ stem?: string; text?: string }>).detail;
      if (detail?.stem === stem && typeof detail.text === "string") {
        setSubtitleText(detail.text);
      }
    }
    window.addEventListener(TTS_CHANGED, onChanged);
    window.addEventListener(TTS_SUBTITLE_AUTOFILLED, onSubtitleAutofilled);
    return () => {
      active = false;
      window.removeEventListener(TTS_CHANGED, onChanged);
      window.removeEventListener(TTS_SUBTITLE_AUTOFILLED, onSubtitleAutofilled);
      const audio = promptAudioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
    };
  }, [stem]);

  function promptAudioSrc(key: string) {
    if (key === "current") return `/api/audio/jp/${encodeURIComponent(stem)}`;
    const [promptStem, promptLang] = key.split("|");
    return `/api/audio/${promptLang === "cn" ? "cn" : "jp"}/${encodeURIComponent(promptStem)}`;
  }

  function pickPrompt(key: string) {
    setPromptKey(key);
    const audio = promptAudioRef.current;
    if (!audio) return;
    if (key === "current" && data && !data.hasJp) return;
    audio.pause();
    audio.src = promptAudioSrc(key);
    audio.load();
    void audio.play().catch(() => {});
  }

  function insertPause(milliseconds: number) {
    const marker = `[停顿=${milliseconds}]`;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? ttsText.length;
    const end = el?.selectionEnd ?? start;
    const next = `${ttsText.slice(0, start)}${marker}${ttsText.slice(end)}`;
    setTtsText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + marker.length, start + marker.length);
    });
  }

  // async function generateEmbed() { ... embedding + Seed-VC, kept for rollback }

  async function generateClone() {
    const liveText = textareaRef.current?.value ?? ttsText;
    setTtsText(liveText);
    setBusy(true);
    setError("");
    const [promptStem, promptLang] = promptKey === "current"
      ? ["", "jp"]
      : promptKey.split("|");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/clone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ttsText: liveText,
          durationFactor: Number(durationFactor),
          promptStem: promptStem || undefined,
          promptLang: promptLang === "cn" ? "cn" : "jp",
        }),
      });
      const result = (await response.json()) as { error?: string; ids?: string[] };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setSavedNote(`已生成 ${result.ids?.length ?? 1} 条待选`);
      notifyTtsChanged();
      await load();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    const liveText = textareaRef.current?.value ?? ttsText;
    setTtsText(liveText);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voiceVersionId: Number(voiceVersionId),
          ttsText: liveText,
          durationFactor: Number(durationFactor),
          emoAlpha: Number(emoAlpha),
          emoRef,
          seedVcRef,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      notifyTtsChanged();
      await load();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function setUsed(record: History, checked: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await patchTtsWithConfirmation(stem, record.id, { reviewState: checked ? "locked" : "candidate" });
      if (!result) return;
      notifyTtsChanged();
      await load();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveSubtitle() {
    const target = preferredTtsVersion(data?.history ?? []);
    if (!target) {
      setError("先生成一版再保存字幕。字幕改写挂在某一版「改」上，不会单独存一条空记录。");
      return;
    }
    setBusy(true);
    setError("");
    setSavedNote("");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/${target.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subtitleText: subtitleText.trim() ? subtitleText : null }),
      });
      const result = (await response.json()) as { error?: string; record?: { subtitle_text: string | null } };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (result.record) setSubtitleText(result.record.subtitle_text ?? "");
      notifyTtsChanged();
      await load();
      router.refresh();
      setSavedNote(target.review_state === "locked" ? `已写入锁定的 #${target.id}` : `没有锁定版本，已写入最新的 #${target.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: History) {
    if (!window.confirm(`删除 TTS 记录 #${record.id} 及对应音频？`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/lines/${encodeURIComponent(stem)}/tts/${record.id}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      notifyTtsChanged();
      await load();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="tts" className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
        <h2 className="mb-4 text-lg font-semibold">逐句 TTS</h2>
        {!data ? <p className="text-sm text-zinc-500">加载中…</p> : (
          <>
            <section className="mt-4 rounded-lg border border-zinc-800 p-4">
              <p className="text-xs text-zinc-500">
                默认用本句日文 zero-shot。下拉先是人物页勾选，下面是前后同人物原版日/中。选中即播。embedding / Seed-VC 已停用。
              </p>
              <div className="mt-3 grid items-start gap-4 lg:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-2 flex h-8 items-center">
                    <div className="text-sm font-medium text-zinc-200">参考音色</div>
                  </div>
                    <input
                      value={promptQuery}
                      onChange={(event) => setPromptQuery(event.target.value)}
                      placeholder="搜 #编号 / 备注 / 字幕"
                      className="mb-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
                    />
                    <select
                      value={promptKey}
                      onChange={(event) => pickPrompt(event.target.value)}
                      className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                    >
                      <option value="current">当前</option>
                      {(data.timbreRefs ?? []).some((row) => promptSearchHit(promptQuery, row)) ? (
                        <optgroup label="人物页预设">
                          {(data.timbreRefs ?? [])
                            .filter((row) => promptSearchHit(promptQuery, row) || promptKey === `${row.stem}|jp` || promptKey === `${row.stem}|cn`)
                            .flatMap((row) => [
                            <option key={`${row.stem}|jp`} value={`${row.stem}|jp`}>
                              {presetOptionLabel(row.id, "jp", row.note, row.stem)}
                            </option>,
                            <option key={`${row.stem}|cn`} value={`${row.stem}|cn`}>
                              {presetOptionLabel(row.id, "cn", row.note, row.stem)}
                            </option>,
                          ])}
                        </optgroup>
                      ) : null}
                      {(data.nearbyRefs ?? []).some((row) => promptSearchHit(promptQuery, row)) ? (
                        <optgroup label="邻近原版日/中">
                          {(data.nearbyRefs ?? [])
                            .filter((row) => promptSearchHit(promptQuery, row) || promptKey === `${row.stem}|jp` || promptKey === `${row.stem}|cn`)
                            .flatMap((row) => {
                            const options = [];
                            if (row.has_jp) {
                              options.push(
                                <option key={`${row.stem}|jp`} value={`${row.stem}|jp`}>
                                  {nearbyOptionLabel(row.id, row.offset, "jp", row.text_jp, row.stem)}
                                </option>,
                              );
                            }
                            if (row.has_cn) {
                              options.push(
                                <option key={`${row.stem}|cn`} value={`${row.stem}|cn`}>
                                  {nearbyOptionLabel(row.id, row.offset, "cn", row.text_zh, row.stem)}
                                </option>,
                              );
                            }
                            return options;
                          })}
                        </optgroup>
                      ) : null}
                    </select>
                    <audio
                      ref={promptAudioRef}
                      className="mt-1 h-8 w-full"
                      controls
                      preload="none"
                      src={promptKey === "current" ? (data.hasJp ? promptAudioSrc("current") : undefined) : promptAudioSrc(promptKey)}
                    />
                    {promptKey === "current" && !data.hasJp ? (
                      <p className="mt-1 text-amber-300">这句没有日文配音。</p>
                    ) : (
                      <p className="mt-1 text-[11px] text-zinc-500">
                        {promptKey === "current" ? "用本句日文 zero-shot" : "用选中的参考音频 zero-shot"}
                      </p>
                    )}
                    {!data.timbreRefs?.length ? (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        还可去{" "}
                        <a className="text-sky-400 underline" href={`/voices?speaker=${encodeURIComponent(data.line.speaker || "")}`}>
                          人物页
                        </a>{" "}
                        勾选预设。邻近原版日/中会列在下拉后半段。
                      </p>
                    ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">时长倍率</span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                      {DURATION_STEPS.map((step) => {
                        const active = Math.abs(Number(durationFactor) - step) < 0.001;
                        return (
                          <button
                            key={step}
                            type="button"
                            onClick={() => setDurationFactor(String(step))}
                            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded px-2 text-sm md:min-h-0 md:min-w-0 md:py-1 md:text-xs ${
                              active
                                ? "bg-sky-800 text-sky-100"
                                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                            }`}
                          >
                            {factorLabel(step)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium text-zinc-200" htmlFor={`tts-${stem}`}>实际 TTS 文字</label>
                      <AutoRewriteButton stem={stem} text={ttsText} onSelect={setTtsText}
                        enabled={!busy && (data.line.kind === "对话" || data.line.kind === "talk") && data.line.dialogue_mode === "scene" && !data.line.subtitle_italic} />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="mr-1 text-xs text-zinc-500">停顿</span>
                      {[200, 500, 1000].map((ms) => (
                        <button
                          key={ms}
                          type="button"
                          onClick={() => insertPause(ms)}
                          className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-300 hover:bg-zinc-700 md:min-h-0 md:px-2 md:py-1 md:text-xs"
                        >
                          {ms}ms
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea
                    id={`tts-${stem}`}
                    ref={textareaRef}
                    rows={6}
                    value={ttsText}
                    onChange={(event) => setTtsText(event.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 p-3 text-sm leading-6 outline-none focus:border-sky-700"
                  />
                  <p className="mt-1 text-xs text-zinc-500">可写 陆[LIU4]号街道 指定前一字读音；注音不计入校字或拍数。</p>
                  <BeatCount enabled={(data.line.kind === "对话" || data.line.kind === "talk") && data.line.dialogue_mode === "scene" && !data.line.subtitle_italic} jp={data.line.text_jp} cn={ttsText} label="当前 TTS 拍数" />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void generateClone()}
                  disabled={busy || !ttsText.trim() || (promptKey === "current" && !data.hasJp)}
                  className="inline-flex min-h-11 items-center rounded bg-sky-700 px-4 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? "生成中…" : "Zero-shot 生成"}
                </button>

              </div>
            </section>
            {LEGACY_EMBEDDING_TTS ? (
            <section className="mt-4 rounded-lg border border-zinc-800 p-4">
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="text-sm font-medium text-zinc-200" htmlFor={`tts-${stem}`}>实际 TTS 文字</label>
                    <div className="flex items-center gap-1">
                      <span className="mr-1 text-xs text-zinc-500">停顿</span>
                      {[200, 500, 1000].map((ms) => (
                        <button
                          key={ms}
                          type="button"
                          onClick={() => insertPause(ms)}
                          className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-300 hover:bg-zinc-700 md:min-h-0 md:px-2 md:py-1 md:text-xs"
                        >
                          {ms}ms
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea
                    id={`tts-${stem}`}
                    ref={textareaRef}
                    rows={6}
                    value={ttsText}
                    onChange={(event) => setTtsText(event.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 p-3 text-sm leading-6 outline-none focus:border-sky-700"
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    停顿格式 {data.pauseSyntax}，50–5000ms。可写 陆[LIU4] 指定读音；生成语音不会改字幕。
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={generate}
                      disabled={busy || !voiceVersionId || !ttsText.trim()}
                      className="inline-flex min-h-11 items-center rounded bg-sky-700 px-4 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? "生成并修复中…" : "生成并修复音色"}
                    </button>
                    <span className="text-xs text-zinc-500">新记录默认不锁定，试听后在上方卡片锁定。</span>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <label className="text-xs text-zinc-400">
                    Embedding
                    <select
                      value={voiceVersionId}
                      onChange={(event) => setVoiceVersionId(event.target.value)}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                    >
                      {data.versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          #{version.id} · {sourceLangLabel(version.source_lang)} · {version.engine_precision || "未知精度"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div>
                    <div className="text-xs text-zinc-400">情绪参考</div>
                    <div className="mt-1 flex rounded border border-zinc-700 p-0.5">
                      {([
                        ["jp", "日文"],
                        ["en", "英文"],
                        ["cn", "中文"],
                      ] as const).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setEmoRef(id)}
                          className={`flex-1 rounded px-2 py-1.5 text-xs ${
                            emoRef === id ? "bg-zinc-200 text-zinc-950" : "text-zinc-400 hover:bg-zinc-800"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-600">
                      IndexTTS 用本句{langShort(emoRef)}文原音的情绪，和下面填补互不影响。
                    </p>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Seed-VC 音色填补</div>
                    <div className="mt-1 flex flex-wrap rounded border border-zinc-700 p-0.5">
                      {([
                        ["auto", "自动"],
                        ["jp", "日文"],
                        ["en", "英文"],
                        ["cn", "中文"],
                        ["native", "本色"],
                      ] as const).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setSeedVcRef(id)}
                          className={`flex-1 rounded px-2 py-1.5 text-xs ${
                            seedVcRef === id ? "bg-zinc-200 text-zinc-950" : "text-zinc-400 hover:bg-zinc-800"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-600">
                      {seedVcRef === "native"
                        ? "始终用制作 embedding 时的拼接音源。"
                        : seedVcRef === "auto"
                          ? `用当前情绪参考（${langShort(emoRef)}文）满 1.5 秒则用它，否则用本色。`
                          : `始终用本句${langShort(seedVcRef)}文原音做音色填补。`}
                    </p>
                  </div>
                  <label className="text-xs text-zinc-400">
                    时长倍率
                    <input
                      type="number" min="0.5" max="2" step="0.05"
                      value={durationFactor}
                      onChange={(event) => setDurationFactor(event.target.value)}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                    />
                  </label>
                  <label className="text-xs text-zinc-400">
                    情绪强度
                    <input
                      type="number" min="0" max="1" step="0.05"
                      value={emoAlpha}
                      onChange={(event) => setEmoAlpha(event.target.value)}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                    />
                  </label>
                </div>
              </div>
            </section>
            ) : null}
            <section className="mt-4 rounded-lg border border-zinc-800 p-4">
              <label className="block text-sm font-medium text-zinc-200" htmlFor={`subtitle-${stem}`}>
                字幕改写
              </label>
              <p className="mt-1 text-xs text-zinc-500">独立保存，不触发生成。写入已锁定的版本；没有锁定则写入最新一版。</p>
              <textarea
                id={`subtitle-${stem}`}
                rows={3}
                value={subtitleText}
                onChange={(event) => {
                  setSubtitleText(event.target.value);
                  setSavedNote("");
                }}
                placeholder="留空表示不修改游戏字幕"
                className="mt-2 w-full max-w-xl rounded border border-zinc-700 bg-zinc-900 p-3 text-sm leading-6 outline-none focus:border-sky-700"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveSubtitle()}
                  disabled={busy}
                  className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-4 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                >
                  保存字幕
                </button>
                {savedNote ? <span className="text-xs text-emerald-400">{savedNote}</span> : null}
              </div>
            </section>

            <section className="mt-5">
              <h3 className="mb-2 text-sm font-medium text-zinc-200">生成历史</h3>
              {!data.history.length ? (
                <p className="rounded border border-dashed border-zinc-800 p-4 text-sm text-zinc-600">还没有生成记录。</p>
              ) : (
                <div className="space-y-3">
                  <TtsVersionTree rows={data.history} renderRow={(record, toggle) => {
                    // 历史主文字必须是这条音频实际生效的字幕。最终字幕恢复拟声后若与原文
                    // 相同，覆盖字段会被清空；此时继承原字幕，不能再显示去拟声后的朗读稿。
                    const subtitleInput = { subtitle: record.subtitle_text, original: data.line.text_zh };
                    const subtitle = effectiveTtsSubtitle(subtitleInput);
                    const subtitleChanged = ttsSubtitleDisplay(subtitleInput) !== null;
                    return (
                    <article id={`tts-${record.id}`} key={record.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <strong className="text-zinc-200">#{record.id}</strong>
                          {record.review_state === "abnormal" ? <span className="text-red-400">异常（人工）</span> : null}
                          <span className="text-zinc-500">音色 #{record.voice_version_id ?? "已删除"}</span>
                          <span className="text-zinc-500">{record.engine_precision || "未知精度"}</span>
                          <span className="text-zinc-600">{dateText(record.created_at)}</span>
                          {record.status === "failed" ? <span className="rounded bg-red-950 px-1.5 py-0.5 text-red-300">失败</span> : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <TtsReviewAction stem={stem} id={String(record.id)} state={record.review_state}
                            disabled={busy || record.status !== "ready"} />
                          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
                            <input
                              type="checkbox"
                              checked={record.review_state === "locked"}
                              disabled={busy || record.status !== "ready"}
                              onChange={(event) => void setUsed(record, event.target.checked)}
                              className="h-4 w-4 accent-sky-500"
                            />
                            用于模组
                          </label>
                          <button
                            type="button"
                            disabled={busy || record.status === "building"}
                            onClick={() => void remove(record)}
                            className="inline-flex min-h-11 items-center px-2 text-sm text-red-400 hover:text-red-300 disabled:opacity-40"
                          >
                            删除
                          </button>
                          {toggle}
                        </div>
                      </div>
                      {record.status === "ready" ? (
                        <audio
                          className="mt-3 h-9 w-full"
                          controls
                          preload="none"
                          src={`/api/lines/${encodeURIComponent(stem)}/tts/${record.id}/audio`}
                          onClick={() => { void reportTtsPlayback(stem, record.id); }}
                        />
                      ) : null}
                      {record.conversion_meta ? (
                        <div className="mt-2 text-xs text-sky-300">
                          {record.conversion_meta.pipeline === "jp-zeroshot"
                            ? `Zero-shot · ${record.conversion_meta.prompt_lang === "cn" ? "中" : "日"}${
                                record.conversion_meta.prompt_note
                                  ? ` · ${record.conversion_meta.prompt_note}`
                                  : record.conversion_meta.prompt_stem && record.conversion_meta.prompt_stem !== stem
                                    ? ` · ${record.conversion_meta.prompt_stem}`
                                    : " · 当前"
                              }`
                            : record.conversion_meta.pipeline === "en-clone-seedvc-v2"
                              ? "英文克隆 → Seed-VC"
                              : "embedding + 英情绪 → Seed-VC"}
                        </div>
                      ) : null}
                      <div className="mt-2">
                        <div className={`text-xs ${subtitleChanged ? "text-amber-300" : "text-zinc-500"}`}>
                          {subtitleChanged ? "字幕（已修改）" : "字幕（沿用原文）"}
                        </div>
                        <div className="whitespace-pre-wrap text-sm text-zinc-300">{subtitle || "（无中文字幕）"}</div>
                      </div>
                      {record.tts_text !== subtitle ? (
                        <div className="mt-2 whitespace-pre-wrap text-xs text-zinc-500">朗读稿：{record.tts_text}</div>
                      ) : null}
                      {record.voice_gpu_key !== "jp-lock" && record.conversion_meta?.pipeline !== "jp-lock" ? (

                  <BeatCount enabled={(data.line.kind === "对话" || data.line.kind === "talk") && data.line.dialogue_mode === "scene" && !data.line.subtitle_italic} jp={data.line.text_jp} cn={record.tts_text} label={`#${record.id} 朗读稿拍数`} />
                      ) : null}
                      <div className="mt-1 text-xs text-zinc-500">
                        起 {durationText(record.start_s)} · 止 {durationText(record.end_s)} · 长 {durationText(record.dur_s)} · 说 {durationText(record.speech_s)}
                        <span className="ml-2">时长倍率 {record.duration_factor.toFixed(2)} · 情绪 {record.emo_alpha.toFixed(2)}</span>
                      </div>
                      {record.error ? <div className="mt-2 text-xs text-red-400">{record.error}</div> : null}
                    </article>
                    );
                  }} />
                </div>
              )}
            </section>
          </>
        )}
        {error ? <div className="mt-4 rounded bg-red-950/70 px-3 py-2 text-sm text-red-200">{error}</div> : null}
    </section>
  );
}
