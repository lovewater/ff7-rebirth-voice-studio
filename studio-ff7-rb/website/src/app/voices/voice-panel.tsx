"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PlayBtn } from "./play-btn";
import { parseTtsDefaults, sourceLangLabel, TTS_DEFAULTS, type EmoRef, type SeedVcRef, type TtsDefaults } from "@/lib/tts-defaults";

type Clip = {
  stem: string;
  selected: boolean;
  recommended: boolean;
  text_zh: string | null;
  text_jp: string | null;
  region: string | null;
  region_name: string | null;
  jp_dur_s: number | null;
  cn_dur_s: number | null;
  en_dur_s: number | null;
  jp_speech_s: number | null;
};

type Bank = { id: number; kind: string; slot: number; name: string | null };
type Version = {
  id: number;
  created_at: string;
  completed_at: string | null;
  status: "building" | "ready" | "failed";
  source_lang: "jp" | "cn" | "en";
  n_clips: number;
  total_dur_s: number | null;
  batch_count: number | null;
  similarity_min: number | null;
  similarity_mean: number | null;
  similarity_max: number | null;
  result_dir: string | null;
  embedding_path: string | null;
  reference_wav_path: string | null;
  source_wav_path: string | null;
  manifest_path: string | null;
  example_stem: string | null;
  example_emo_alpha: number | null;
  example_text_zh: string | null;
  example_text_jp: string | null;
  error: string | null;
  engine_model_version: string | null;
  engine_model_revision: string | null;
  engine_source_revision: string | null;
  engine_package_version: string | null;
  engine_precision: string | null;
  engine_device: string | null;
  engine_url: string | null;
};

/** 旧 embedding 制作界面。效果回滚时改为 true。 */
const LEGACY_EMBEDDING_UI = false;

type TimbreClip = {
  id: number;
  stem: string;
  text_zh: string | null;
  text_jp: string | null;
  region: string | null;
  region_name: string | null;
  jp_dur_s: number | null;
  en_dur_s: number | null;
  timbre: boolean;
  note: string | null;
};

function dur(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}s`;
}

function score(n: number | null | undefined) {
  return n == null ? "—" : n.toFixed(4);
}

function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function speakerQs(speakers: string[], slot: number) {
  const u = new URLSearchParams();
  for (const s of speakers) u.append("speaker", s);
  u.set("slot", String(slot));
  return `/voices?${u.toString()}`;
}

export function VoicePanel({
  speaker,
  name,
  slot,
  speakers,
}: {
  speaker: string;
  name: string;
  slot: number;
  speakers: string[];
}) {
  const router = useRouter();
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [activity, setActivity] = useState<"scan" | "build" | "bank" | null>(null);
  const [deletingVersion, setDeletingVersion] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [scanNote, setScanNote] = useState("");
  const [sourceLang, setSourceLang] = useState<"jp" | "cn" | "en">("cn");
  const [defaults, setDefaults] = useState<TtsDefaults>(TTS_DEFAULTS);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [timbreClips, setTimbreClips] = useState<TimbreClip[] | null>(null);
  const [timbreQuery, setTimbreQuery] = useState("");
  const [noteModal, setNoteModal] = useState<{ stem: string; existing: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const busy = activity !== null || deletingVersion !== null;

  const load = useCallback(async () => {
    const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}?slot=${slot}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    setClips(d.clips ?? []);
    setBanks(d.banks ?? []);
    setVersions(d.versions ?? []);
    setDefaults(parseTtsDefaults(d.tts_defaults));
    setTimbreClips(d.timbre_clips ?? []);
  }, [speaker, slot]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/voices/${encodeURIComponent(speaker)}?slot=${slot}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data;
      })
      .then((data) => {
        if (!active) return;
        setClips(data.clips ?? []);
        setBanks(data.banks ?? []);
        setVersions(data.versions ?? []);
        setDefaults(parseTtsDefaults(data.tts_defaults));
        setTimbreClips(data.timbre_clips ?? []);
      })
      .catch((error) => {
        if (active) setErr(String(error));
      });
    return () => {
      active = false;
    };
  }, [speaker, slot]);

  const picked = useMemo(() => (clips ?? []).filter((c) => c.selected), [clips]);
  const sourceDuration = (clip: Clip) =>
    sourceLang === "jp" ? (clip.jp_dur_s ?? 0) : sourceLang === "en" ? (clip.en_dur_s ?? 0) : (clip.cn_dur_s ?? 0);
  const totalDur = picked.reduce((sum, clip) => sum + sourceDuration(clip), 0);
  const displayedClips = useMemo(
    () => [...(clips ?? [])].sort((a, b) =>
      Number(b.recommended) - Number(a.recommended)
      || sourceDuration(b) - sourceDuration(a)
      || a.stem.localeCompare(b.stem)),
    [clips, sourceLang],
  );

  async function scan() {
    setActivity("scan");
    setErr("");
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      const manualTail = `；另列出 ${Math.max(0, d.total - d.n)} 条供人工补选`;
      if (d.minDur === 3) {
        setScanNote(`按时长勾选 3 秒以上 ${d.n} 条、合计 ${d.dur}s${manualTail}`);
      } else if (d.minDur === 2) {
        setScanNote(
          `3 秒以上 ${d.n3} 条、${d.dur3}s，不足 60s，已纳入 2 秒以上（共 ${d.n} 条、${d.dur}s）${manualTail}`,
        );
      } else if (d.shortfall) {
        setScanNote(
          `2 秒以上仍不足 60s（${d.dur2}s），已纳入 1.5 秒以上（共 ${d.n} 条、${d.dur}s）${manualTail}`,
        );
      } else {
        setScanNote(
          `2 秒以上仍不足 60s，已纳入 1.5 秒以上（共 ${d.n} 条、${d.dur}s）${manualTail}`,
        );
      }
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setActivity(null);
    }
  }

  async function setTimbre(stems: string[], selected: boolean, note?: string) {
    const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}/timbre`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stems, selected, note }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(d.error || r.statusText);
      await load();
      return false;
    }
    await load();
    return true;
  }

  async function confirmTimbreNote() {
    if (!noteModal) return;
    setErr("");
    const ok = await setTimbre([noteModal.stem], true, noteDraft);
    if (ok) {
      setNoteModal(null);
      setNoteDraft("");
    }
  }

  async function setSelected(stems: string[], selected: boolean) {
    setClips((prev) =>
      (prev ?? []).map((c) => (stems.includes(c.stem) ? { ...c, selected } : c)),
    );
    const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}/clips`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, stems, selected }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error || r.statusText);
      await load();
    }
  }

  async function addBank() {
    setActivity("bank");
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}/banks`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      router.push(speakerQs(speakers, d.slot));
    } catch (e) {
      setErr(String(e));
    } finally {
      setActivity(null);
    }
  }

  async function buildEmbedding() {
    if (totalDur > 15) { setErr("已选音源总时长不能超过 15 秒，请取消部分勾选"); return; }
    setActivity("build");
    setErr("");
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, sourceLang }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      setScanNote(`第 ${d.versionId} 版制作完成`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setActivity(null);
    }
  }

  async function saveDefaults() {
    setSavingDefaults(true);
    setErr("");
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(speaker)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tts_defaults: defaults }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      setDefaults(parseTtsDefaults(d.tts_defaults));
      setScanNote("人物 TTS 默认已保存，详情页生成时会自动带上");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingDefaults(false);
    }
  }

  async function deleteVersion(version: Version) {
    const confirmed = window.confirm(
      `确定删除版本 #${version.id}？\n\n数据库记录和目录 ${version.result_dir ?? "（无产物目录）"} 都会被删除，无法恢复。`,
    );
    if (!confirmed) return;
    setDeletingVersion(version.id);
    setErr("");
    try {
      const r = await fetch(`/api/voices/versions/${version.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      setVersions((current) => current.filter((item) => item.id !== version.id));
      setScanNote(`版本 #${version.id} 及对应文件已删除`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setDeletingVersion(null);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg text-zinc-100">{name}</h2>
        <span className="font-mono text-xs text-zinc-500">{speaker}</span>
      </div>

      <section className="rounded-lg border border-zinc-800 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <span className="text-sm text-zinc-200">参考音色</span>
          <span className="text-xs text-zinc-500">
            已标 {(timbreClips ?? []).filter((c) => c.timbre).length} 条 · TTS 下拉可选用日文或中文版 zero-shot
          </span>
        </div>
        <p className="mb-3 text-[11px] text-zinc-600">
          可多选。勾选必须写备注。详情页下拉会出现「备注 - 日 / 备注 - 中」。建议 3–8 秒、声线有特色。列表里听到不错的，用编号搜索即可。
        </p>
        <input
          value={timbreQuery}
          onChange={(event) => setTimbreQuery(event.target.value)}
          placeholder="搜 #编号 / 备注 / 字幕 / stem"
          className="mb-3 w-full max-w-md rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
        />
        {err ? <p className="mb-2 text-xs text-red-400">{err}</p> : null}
        {timbreClips == null ? (
          <p className="text-sm text-zinc-600">加载中…</p>
        ) : timbreClips.length === 0 ? (
          <p className="text-sm text-zinc-600">这个人物没有带时长的日文台词。</p>
        ) : (
          <div className="max-h-[32rem] overflow-y-auto rounded border border-zinc-900">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
                <tr>
                  <th className="w-8 px-2 py-1"></th>
                  <th className="w-16 px-2 py-1">编号</th>
                  <th className="px-2 py-1">日长</th>
                  <th className="px-2 py-1">备注</th>
                  <th className="px-2 py-1">区域</th>
                  <th className="px-2 py-1">字幕</th>
                  <th className="px-2 py-1">试听</th>
                </tr>
              </thead>
              <tbody>
                {timbreClips
                  .filter((c) => {
                    const q = timbreQuery.trim().toLowerCase();
                    if (!q) return true;
                    const idq = q.replace(/^#/, "");
                    return (
                      String(c.id) === idq ||
                      `#${c.id}`.toLowerCase().includes(q) ||
                      c.stem.toLowerCase().includes(q) ||
                      (c.note ?? "").toLowerCase().includes(q) ||
                      (c.text_zh ?? "").toLowerCase().includes(q) ||
                      (c.text_jp ?? "").toLowerCase().includes(q) ||
                      (c.region_name ?? "").toLowerCase().includes(q)
                    );
                  })
                  .map((c) => (
                  <tr
                    key={c.stem}
                    className={
                      c.timbre
                        ? "border-t border-sky-900 bg-sky-950/70 shadow-[inset_3px_0_0_0_rgb(56,189,248)]"
                        : "border-t border-zinc-900"
                    }
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={c.timbre}
                        disabled={busy}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNoteModal({ stem: c.stem, existing: c.note ?? "" });
                            setNoteDraft(c.note ?? "");
                          } else {
                            void setTimbre([c.stem], false);
                          }
                        }}
                        className="accent-sky-300"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-400">#{c.id}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-400">
                      {dur(c.jp_dur_s)}
                    </td>
                    <td className="max-w-48 px-2 py-1.5 text-zinc-300">
                      {c.timbre ? (
                        <button
                          type="button"
                          className="text-left text-sky-300 hover:underline"
                          onClick={() => {
                            setNoteModal({ stem: c.stem, existing: c.note ?? "" });
                            setNoteDraft(c.note ?? "");
                          }}
                        >
                          {c.note || "补写备注"}
                        </button>
                      ) : (
                        <span className="text-zinc-700">勾选时写</span>
                      )}
                    </td>
                    <td className="max-w-32 px-2 py-1.5 text-zinc-500">
                      <div>{c.region_name ?? c.region ?? "—"}</div>
                      <div className="font-mono text-[10px] text-zinc-700">{c.stem}</div>
                    </td>
                    <td className="max-w-md px-2 py-1.5">
                      <div className="text-zinc-500">{c.text_jp}</div>
                      <div className="text-zinc-300">{c.text_zh}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <div className="flex gap-1">
                        <PlayBtn src={`/api/audio/jp/${encodeURIComponent(c.stem)}`} label="日" />
                        <PlayBtn src={`/api/audio/cn/${encodeURIComponent(c.stem)}`} label="中" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* embedding 制作已停用，zero-shot 不再走这条
      <EmbedWizard
        speaker={speaker}
        slot={slot}
        clips={enSourceClips}
        busy={busy}
        onBusy={setWizardBusy}
        onDone={(versionId) => {
          setScanNote(`第 ${versionId} 版已入库（英音色的地道中文）`);
          void load();
        }}
        onError={setErr}
      />
      */}

      <section className="rounded-lg border border-zinc-800 p-3">
        <div className="text-sm text-zinc-200">已入库 embedding</div>
        <div className="mt-3 flex flex-col gap-3 text-xs text-zinc-500">
          {versions.length === 0 ? (
            <span>还没有入库的版本</span>
          ) : (
            versions.map((v) => (
              <article key={v.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="text-zinc-200">版本 #{v.id}</strong>
                  <span>{when(v.created_at)}</span>
                  <span
                    className={
                      v.status === "ready"
                        ? "text-emerald-400"
                        : v.status === "failed"
                          ? "text-red-400"
                          : "text-amber-400"
                    }
                  >
                    {v.status === "ready" ? "完成" : v.status === "failed" ? "失败" : "制作中"}
                  </span>
                  <span>{v.n_clips} 条</span>
                  <span>{dur(v.total_dur_s)}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                    {sourceLangLabel(v.source_lang)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteVersion(v)}
                    className="ml-auto whitespace-nowrap rounded border border-red-950 px-2 py-0.5 text-[11px] text-red-400 hover:border-red-800 hover:bg-red-950/40 disabled:opacity-40"
                  >
                    {deletingVersion === v.id ? "删除中…" : "删除版本"}
                  </button>
                </div>
                {v.error ? <p className="mt-2 text-red-400">{v.error}</p> : null}
              </article>
            ))
          )}
        </div>
      </section>

      {noteModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 p-4">
            <div className="text-sm text-zinc-200">日文参考音色备注</div>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">{noteModal.stem}</p>
            <audio
              className="mt-2 h-9 w-full"
              controls
              preload="none"
              src={`/api/audio/jp/${encodeURIComponent(noteModal.stem)}`}
            />
            <label className="mt-3 block text-xs text-zinc-400">
              备注（必填，2–80 字）
              <input
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="例如：平声、气声少、很像爱丽丝本色"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
              />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
                onClick={() => {
                  setNoteModal(null);
                  setNoteDraft("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded bg-sky-700 px-3 py-1.5 text-sm text-white hover:bg-sky-600"
                onClick={() => void confirmTimbreNote()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {LEGACY_EMBEDDING_UI ? (
      <>
      <section className="rounded-lg border border-zinc-800 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500">基准音色</span>
          {banks.map((b) => (
            <a
              key={b.id}
              href={speakerQs(speakers, b.slot)}
              className={`rounded border px-2 py-0.5 text-xs ${
                b.slot === slot
                  ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {b.name || `基准 ${b.slot}`}
            </a>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void addBank()}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            新增基准
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          每次制作都会保留独立版本、完整素材清单、embedding 和中日示例，不限制版本数量。
        </p>
        <div className="mt-3 flex flex-col gap-3 text-xs text-zinc-500">
          {versions.length === 0 ? (
            <span>还没有制作过 embedding</span>
          ) : (
            versions.map((v) => (
              <article key={v.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="text-zinc-200">版本 #{v.id}</strong>
                  <span>{when(v.created_at)}</span>
                  <span
                    className={
                      v.status === "ready"
                        ? "text-emerald-400"
                        : v.status === "failed"
                          ? "text-red-400"
                          : "text-amber-400"
                    }
                  >
                    {v.status === "ready" ? "完成" : v.status === "failed" ? "失败" : "制作中"}
                  </span>
                  <span>{v.n_clips} 条</span>
                  <span>{v.batch_count ?? "—"} 组</span>
                  <span>{dur(v.total_dur_s)}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                    {sourceLangLabel(v.source_lang)}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteVersion(v)}
                    className="ml-auto whitespace-nowrap rounded border border-red-950 px-2 py-0.5 text-[11px] text-red-400 hover:border-red-800 hover:bg-red-950/40 disabled:opacity-40"
                  >
                    {deletingVersion === v.id ? "删除中…" : "删除版本"}
                  </button>
                </div>
                {v.status === "ready" ? (
                  <>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-600">
                      <span>相似度 {score(v.similarity_min)} / {score(v.similarity_mean)} / {score(v.similarity_max)}</span>
                      <span>
                        IndexTTS {v.engine_model_version ?? "?"} · {v.engine_precision ?? "未知精度"} · {v.engine_device ?? "未知设备"}
                      </span>
                      <span>目录 {v.result_dir}</span>
                      <span>embedding {v.embedding_path}</span>
                    </div>
                    <div className="mt-3 rounded border border-zinc-900 p-2">
                      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap">
                        <span className="text-zinc-300">示例 · 情绪 0.5 / 0.5</span>
                        <PlayBtn src={`/api/voices/versions/${v.id}/audio/zh`} label="生成中文" />
                        {v.source_wav_path ? <PlayBtn src={`/api/voices/versions/${v.id}/audio/source`} label="拼接音源" /> : null}
                        <PlayBtn src={`/api/voices/versions/${v.id}/audio/ja`} label="原始日文" />
                      </div>
                      <div className="mt-2 text-zinc-500">{v.example_text_jp}</div>
                      <div className="text-zinc-300">{v.example_text_zh}</div>
                      <div className="mt-1 font-mono text-[10px] text-zinc-700">{v.example_stem}</div>
                    </div>
                  </>
                ) : v.error ? (
                  <p className="mt-2 text-red-400">{v.error}</p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 p-3">
        <div className="mb-2 text-xs text-zinc-500">TTS 默认（详情页自动带上，可当场改）</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-zinc-400">
            Embedding
            <select
              value={defaults.voice_version_id ?? ""}
              onChange={(event) =>
                setDefaults((cur) => ({
                  ...cur,
                  voice_version_id: event.target.value ? Number(event.target.value) : null,
                }))
              }
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="">最新一版</option>
              {versions.filter((v) => v.status === "ready").map((v) => (
                <option key={v.id} value={v.id}>
                  #{v.id} · {sourceLangLabel(v.source_lang)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400">
              时长倍率
              <input
                type="number"
                min="0.5"
                max="2"
                step="0.05"
                value={defaults.duration_factor}
                onChange={(event) =>
                  setDefaults((cur) => ({ ...cur, duration_factor: Number(event.target.value) }))
                }
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
              />
            </label>
            <label className="text-xs text-zinc-400">
              情绪强度
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={defaults.emo_alpha}
                onChange={(event) =>
                  setDefaults((cur) => ({ ...cur, emo_alpha: Number(event.target.value) }))
                }
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
              />
            </label>
          </div>
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
                  onClick={() => setDefaults((cur) => ({ ...cur, emo_ref: id as EmoRef }))}
                  className={`flex-1 rounded px-2 py-1 text-xs ${
                    defaults.emo_ref === id ? "bg-zinc-200 text-zinc-950" : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
                  onClick={() => setDefaults((cur) => ({ ...cur, seed_vc_ref: id as SeedVcRef }))}
                  className={`flex-1 rounded px-2 py-1 text-xs ${
                    defaults.seed_vc_ref === id ? "bg-zinc-200 text-zinc-950" : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={busy || savingDefaults}
          onClick={() => void saveDefaults()}
          className="mt-3 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          {savingDefaults ? "保存中…" : "保存默认"}
        </button>
      </section>

      <section className="rounded-lg border border-zinc-800 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void scan()}
            className="rounded border border-zinc-500 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            {activity === "scan" ? "刷新中…" : "刷新可用音源"}
          </button>
          {clips && clips.length > 0 ? (
            <>
              <div className="flex items-center rounded border border-zinc-700 p-0.5 text-xs">
                <span className="px-2 text-zinc-500">embedding 音源</span>
                {(["jp", "cn", "en"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    disabled={busy}
                    onClick={() => setSourceLang(lang)}
                    className={`rounded px-2 py-1 ${sourceLang === lang ? "bg-zinc-200 text-zinc-950" : "text-zinc-400 hover:bg-zinc-800"}`}
                  >
                    {lang === "jp" ? "日文" : lang === "en" ? "英文" : "中文"}
                  </button>
                ))}
              </div>
              <span className="text-sm text-zinc-300">
                已选 {picked.length} / {clips.length} · {sourceLang === "jp" ? "日文" : sourceLang === "en" ? "英文" : "中文"}总长 {totalDur.toFixed(2)}s / 15s{totalDur > 15 ? "（超限，请减少选择）" : ""}
              </span>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-zinc-200"
                onClick={() => void setSelected(clips.map((c) => c.stem), true)}
              >
                全选
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-zinc-200"
                onClick={() => void setSelected(clips.map((c) => c.stem), false)}
              >
                全不选
              </button>
              <button
                type="button"
                disabled={busy || picked.length === 0 || totalDur > 15}
                onClick={() => void buildEmbedding()}
                className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
              >
                {activity === "build" ? "制作 embedding 和示例中…" : "制作 embedding"}
              </button>
            </>
          ) : null}
        </div>
        <p className="mt-2 text-[11px] text-zinc-600">
          刷新按时长勾选候选，勾选结果立即保存。
          其余台词按当前音源语言的时长从长到短列在后面、默认不勾选。制作时读取开关指定的日文、中文或英文音频：已选原音频总长最多 15 秒，超过不能制作。英文 embedding 的 Seed-VC「自动/原文」走英文；中文或日文 embedding 的自动/原文仍走日文。
        </p>
        {scanNote ? <p className="mt-2 text-xs text-zinc-400">{scanNote}</p> : null}
        {err ? <p className="mt-2 text-xs text-red-400">{err}</p> : null}

        {clips === null ? (
          <p className="mt-4 text-sm text-zinc-600">加载中…</p>
        ) : clips.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">还没查找。点上面按钮按时长筛音源。</p>
        ) : (
          <div className="mt-3 max-h-[32rem] overflow-y-auto rounded border border-zinc-900">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
                <tr>
                  <th className="w-8 px-2 py-1"></th>
                  <th className="px-2 py-1">{sourceLang === "jp" ? "日长" : sourceLang === "en" ? "英长" : "中长"}</th>
                  <th className="px-2 py-1">区域</th>
                  <th className="px-2 py-1">字幕</th>
                  <th className="px-2 py-1">试听</th>
                </tr>
              </thead>
              <tbody>
                {displayedClips.map((c) => (
                  <tr
                    key={c.stem}
                    className={
                      c.selected
                        ? "border-t border-sky-900 bg-sky-950/70 shadow-[inset_3px_0_0_0_rgb(56,189,248)]"
                        : "border-t border-zinc-900"
                    }
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={c.selected}
                        onChange={(e) => void setSelected([c.stem], e.target.checked)}
                        className="accent-zinc-200"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-400">
                      <div>{dur(sourceDuration(c))}</div>
                      <div className={c.recommended ? "text-emerald-500" : "text-zinc-700"}>
                        {c.recommended ? "优先" : "补选"}
                      </div>
                    </td>
                    <td className="max-w-32 px-2 py-1.5 text-zinc-500">
                      <div>{c.region_name ?? c.region ?? "—"}</div>
                      <div className="font-mono text-[10px] text-zinc-700">{c.region}</div>
                    </td>
                    <td className="max-w-md px-2 py-1.5">
                      <div className="text-zinc-500">{c.text_jp}</div>
                      <div className="text-zinc-300">{c.text_zh}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <div className="flex gap-1">
                        <PlayBtn src={`/api/audio/jp/${encodeURIComponent(c.stem)}`} label="日" />
                        <PlayBtn src={`/api/audio/cn/${encodeURIComponent(c.stem)}`} label="中" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>
      ) : null}
    </div>
  );
}
