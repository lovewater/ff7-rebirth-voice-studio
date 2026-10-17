"use client";

import { AudioPlayButton as MiniPlay } from "@/components/audio-play-button";

import { reportTtsPlayback } from "@/lib/tts-play-count";
import type { TtsReviewState } from "@/lib/tts-review-state";
import { TtsReviewAction } from "@/components/tts-review-action";

import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";

import { useEffect, useState, type ReactNode } from "react";
import { healthCaption, timingMarks, type Mark, type Timing } from "@/lib/timing";
import { isLockedFlag, useTtsSnapshot } from "./tts-snapshot";
import { BeatRatio, beatHealth, useBeats } from "./beat-count";
import { NetRatio } from "./net-ratio";

function fmt(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

function markClass(m: Mark) {
  if (m === "err") return "text-red-400";
  if (m === "warn") return "text-amber-300";
  return "text-zinc-400";
}


const extraBtn = "inline-flex min-h-11 items-center rounded px-3 text-sm md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]";

function Part({
  name,
  value,
  mark,
  hint,
}: {
  name: string;
  value: number | null;
  mark: Mark;
  hint: string;
}) {
  return (
    <span className={markClass(mark)} title={hint}>
      {name} {fmt(value)}
    </span>
  );
}


function LangPlay({
  label,
  src,
  timing,
  marks,
  health,
  ignored,
  extra,
  ratio,
}: {
  label: string;
  src: string;
  timing: Timing;
  marks: { start: Mark; end: Mark; dur: Mark; speech: Mark };
  health?: { flag: Mark; text: string } | null;
  ignored?: boolean;
  extra?: ReactNode;
  ratio?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="w-4 text-zinc-500">{label}</span>
      <MiniPlay src={src} />
      <span className="min-w-0 basis-full font-mono leading-5 md:basis-auto">
        <Part name="起" value={timing.start} mark={marks.start} hint="实际开始，日/中差 >100ms 黄，>150ms 红" />
        <span className="text-zinc-600"> · </span>
        <Part name="止" value={timing.end} mark={marks.end} hint="实际结束，日/中差 >200ms 黄，>400ms 红" />
        <span className="text-zinc-600"> · </span>
        <Part name="长" value={timing.dur} mark={marks.dur} hint="音频长度，日/中差 >200ms 黄，>400ms 红" />
        <span className="text-zinc-600"> · </span>
        <Part name="说" value={timing.speech} mark={marks.speech} hint="实际说话，日/中差 >200ms 黄，>400ms 红" />
        {ratio}
      </span>
      {health ? (
        <span
          className={
            health.flag === "err"
              ? "inline-block min-w-14 rounded bg-red-950 px-1.5 py-0.5 font-mono text-[11px] text-red-200"
              : health.flag === "warn"
                ? "inline-block min-w-14 rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[11px] text-amber-200"
                : "inline-block min-w-14 rounded bg-emerald-950 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300"
          }
          title="相对日文"
        >
          {health.text}
        </span>
      ) : null}
      {ignored ? <IgnoreTag /> : null}
      {extra}
    </div>
  );
}

function IgnoreTag() {
  return (
    <span className="inline-block rounded bg-emerald-950 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300" title="已锁原中文">
      原中文已锁
    </span>
  );
}

function pingTtsChanged() {
  window.dispatchEvent(new Event("ff7-tts-changed"));
  try {
    const channel = new BroadcastChannel("ff7-tts-changed");
    channel.postMessage({ at: Date.now() });
    channel.close();
  } catch {
    /* ignore */
  }
}

export function ModifiedPlay({
  stem,
  id,
  timing,
  jp,
  kind,
  timingExempt = false,
  jpText,
  ttsText,
  beatsEnabled = false,
  warn,
  err,
  locked = false,
  reviewState = locked ? "locked" : "candidate",
  lockReplacesEdit = false,
  jpLock = false,
  ignored = false,
  isNew = false,
  autoRunPassed = false,
  autoRunFailed = false,
  autoRunError = null,
  actions,
}: {
  stem: string;
  id: string;
  timing: Timing;
  jp: Timing;
  kind?: string | null;
  timingExempt?: boolean;
  jpText?: string | null;
  ttsText?: string | null;
  beatsEnabled?: boolean;
  warn: number;
  err: number;
  locked?: boolean;
  reviewState?: TtsReviewState;
  lockReplacesEdit?: boolean;
  jpLock?: boolean;
  ignored?: boolean;
  isNew?: boolean;
  autoRunPassed?: boolean;
  autoRunFailed?: boolean;
  autoRunError?: string | null;
  actions?: ReactNode;
}) {
  const [fresh, setFresh] = useState(isNew);
  const [locking, setLocking] = useState(false);
  const [adopted, setAdopted] = useState(locked);
  const [review, setReview] = useState(reviewState);
  useEffect(() => {
    setReview(reviewState);
    if (locked) {
      setAdopted(true);
      return;
    }
    setAdopted(false);
    setFresh(isNew);
  }, [isNew, id, locked, reviewState]);

  const manualAbnormal = review === "abnormal";
  const isLocked = review === "locked" || adopted;
  const approved = timingExempt || isLocked || ignored;
  const { current: beats } = useBeats(jpText, ttsText, beatsEnabled && !jpLock);
  const marks = timingMarks(jp, timing, kind ?? undefined, warn, err, approved);
  const health = manualAbnormal ? { flag: "err" as const, text: "异常（人工）" }
    : beatHealth(healthCaption(jp, timing, kind ?? undefined, warn, err, approved), beats?.result, approved);
  const tag =
    health.flag === "err"
      ? "inline-block min-w-14 rounded bg-red-950 px-1.5 py-0.5 font-mono text-[11px] text-red-200"
      : health.flag === "warn"
        ? "inline-block min-w-14 rounded bg-amber-950 px-1.5 py-0.5 font-mono text-[11px] text-amber-200"
        : "inline-block min-w-14 rounded bg-emerald-950 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300";
  const shownLocked = isLocked && (lockReplacesEdit || jpLock);
  const pendingAuto = autoRunPassed && !shownLocked && !jpLock && !manualAbnormal;
  // 异常仅替换未试听候选的“新”；已试听后恢复“改”，失败日志仍保留。
  const mark = shownLocked ? "锁" : manualAbnormal ? "异" : pendingAuto || !fresh ? "改" : autoRunFailed ? "异" : "新";
  const markClass = shownLocked
    ? "w-4 font-medium text-emerald-400"
    : mark === "异" ? "w-4 font-medium text-red-400"
      : mark === "新" ? "w-4 font-medium text-amber-300"
        : "w-4 font-medium text-sky-400";

  function lockNow() {
    setLocking(true);
    void patchTtsWithConfirmation(stem, id, { reviewState: "locked" })
      .then((result) => {
        if (!result) return;
        setAdopted(true);
        pingTtsChanged();
      })
      .catch((error) => window.alert(error instanceof Error ? error.message : "锁定失败"))
      .finally(() => setLocking(false));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {pendingAuto ? (
          <button
            type="button"
            disabled={locking}
            title={`锁定 #${id}`}
            onClick={lockNow}
            className={`${markClass} hover:text-sky-100 disabled:opacity-40`}
          >
            {locking ? "…" : "改"}
          </button>
        ) : (
          <span className={markClass} title={mark === "异" ? autoRunError || "自动运行未通过，待试听" : undefined}>{mark}</span>
        )}
        <MiniPlay
          src={`/api/lines/${encodeURIComponent(stem)}/tts/${id}/audio`}
          accent
          onPlayRequest={() => {
            const wasFresh = fresh;
            // 已听过、已锁定也每次上报。点击即计数，不等待 audio.play() 的结果。
            setFresh(false);
            void reportTtsPlayback(stem, id).then((ok) => { if (!ok) setFresh(wasFresh); });
          }}
        />
        {jpLock ? <span className="font-mono text-zinc-400">（使用日文原音）</span> : null}
        <span className="min-w-0 basis-full font-mono leading-5 md:basis-auto">
          <Part name="起" value={timing.start} mark={marks.start} hint="相对日文开始，差 >100ms 黄，>150ms 红" />
          <span className="text-zinc-600"> · </span>
          <Part name="止" value={timing.end} mark={marks.end} hint="相对日文结束，差 >200ms 黄，>400ms 红" />
          <span className="text-zinc-600"> · </span>
          <Part name="长" value={timing.dur} mark={marks.dur} hint="相对日文总长，差 >200ms 黄，>400ms 红" />
          <span className="text-zinc-600"> · </span>
          <Part name="说" value={timing.speech} mark={marks.speech} hint="相对日文说话，差 >200ms 黄，>400ms 红" />
          <BeatRatio jp={jpText} cn={ttsText} enabled={beatsEnabled && !jpLock} approved={approved} />
          <NetRatio stem={stem} id={id} enabled={beatsEnabled && !jpLock} />
        </span>
        <span className={tag} title="相对日文：起/止/长里绝对值最大的 ±ms">
          {health.text}
        </span>
        {ignored ? <IgnoreTag /> : null}
        <span className="font-mono text-[11px] text-zinc-600">#{id}</span>
        {/* 列表始终提供锁定入口，是否新音频/已试听/自动运行通过都不影响可锁性。 */}
        {lockReplacesEdit && !isLocked ? (
          <button
            type="button"
            disabled={locking}
            onClick={lockNow}
            className={`${extraBtn} bg-emerald-900 text-emerald-100 hover:bg-emerald-800 disabled:opacity-40`}
          >
            {locking ? "…" : "锁定"}
          </button>
        ) : null}
        {isLocked && !lockReplacesEdit ? <span className="text-[11px] text-sky-400">锁</span> : null}
        {isLocked && lockReplacesEdit ? null : actions}
        <TtsReviewAction stem={stem} id={id} state={isLocked ? "locked" : review}
          onChanged={(state) => { setReview(state); setAdopted(false); }} />
    </div>
  );
}

export function PlayCell({
  stem,
  jp,
  cn,
  kind,
  modified,
  warn = 0.15,
  err = 0.3,
  lockReplacesEdit = false,
  skipTiming = false,
  timingExempt = false,
  beatTexts,
  beatsEnabled = false,
  autoRunPassed = false,
  autoRunFailedTtsId = null,
  autoRunError = null,
  cnExtra,
}: {
  stem: string;
  jp: Timing;
  cn: Timing;
  en?: Timing | null;
  kind?: string | null;
  modified?: { id: string; reviewState: "candidate" | "locked" | "abnormal"; timing: Timing; jpLock?: boolean; isNew?: boolean } | null;
  warn?: number;
  err?: number;
  lockReplacesEdit?: boolean;
  skipTiming?: boolean;
  timingExempt?: boolean;
  beatTexts?: { jp: string | null; cn: string | null; modified?: string | null };
  beatsEnabled?: boolean;
  autoRunPassed?: boolean;
  autoRunFailedTtsId?: string | null;
  autoRunError?: string | null;
  cnExtra?: ReactNode;
}) {
  const live = useTtsSnapshot(stem);
  const skip = live?.skipTiming ?? skipTiming;
  const [busy, setBusy] = useState<"skip" | "jp" | null>(null);
  const shown =
    live === undefined
      ? modified
        ? { ...modified, reviewState: modified.reviewState }
        : null
      : live.id == null || live.timing == null
        ? null
        : { id: live.id, reviewState: live.reviewState, timing: live.timing, jpLock: live.jpLock, isNew: live.isNew };
  const locked = isLockedFlag(shown?.reviewState);
  const exempt = skip || timingExempt || locked;
  const { current: beats } = useBeats(beatTexts?.jp, beatTexts?.cn, beatsEnabled);
  const marks = timingMarks(jp, cn, kind ?? undefined, warn, err, exempt);
  const okMarks = { start: "ok" as const, end: "ok" as const, dur: "ok" as const, speech: "ok" as const };
  const lineHealth = beatHealth(healthCaption(jp, cn, kind ?? undefined, warn, err, exempt), beats?.result, exempt);
  const originalIssue = lineHealth.flag === "warn" || lineHealth.flag === "err";
  const listFix = lockReplacesEdit && originalIssue && !locked && !skip;
  async function skipTimingNow() {
    setBusy("skip");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/flags`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skipTiming: true }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      pingTtsChanged();
    } catch {
      /* keep button */
    } finally {
      setBusy(null);
    }
  }
  async function lockJpNow() {
    setBusy("jp");
    try {
      const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/lock-jp`, { method: "POST" });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      pingTtsChanged();
    } catch {
      /* keep button */
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 md:min-w-72">
      <LangPlay
        label="日"
        src={`/api/audio/jp/${encodeURIComponent(stem)}`}
        timing={jp}
        marks={okMarks}
        extra={
          listFix ? (
            <button
              type="button"
              disabled={busy != null}
              onClick={() => void lockJpNow()}
              className={`${extraBtn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40`}
            >
              {busy === "jp" ? "…" : "锁日文原声"}
            </button>
          ) : null
        }
      />
      <LangPlay
        label="中"
        src={`/api/audio/cn/${encodeURIComponent(stem)}`}
        timing={cn}
        marks={marks}
        ratio={<><BeatRatio jp={beatTexts?.jp} cn={beatTexts?.cn} enabled={beatsEnabled} approved={exempt} /><NetRatio stem={stem} enabled={beatsEnabled} /></>}
        health={!locked || originalIssue ? lineHealth : null}
        ignored={skip && !locked}
        extra={
          <>
            {listFix ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => void skipTimingNow()}
                className={`${extraBtn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40`}
              >
                {busy === "skip" ? "…" : "锁原中文"}
              </button>
            ) : null}
            {cnExtra}
          </>
        }
      />
      {shown ? (
        <ModifiedPlay
          key={shown.id}
          stem={stem}
          id={shown.id}
          timing={shown.timing}
          jp={jp}
          kind={kind}
          timingExempt={exempt}
          jpText={beatTexts?.jp}
          ttsText={live?.ttsText ?? beatTexts?.modified}
          beatsEnabled={beatsEnabled}
          warn={warn}
          err={err}
          locked={shown.reviewState === "locked"}
          reviewState={shown.reviewState}
          lockReplacesEdit={lockReplacesEdit}
          jpLock={Boolean(shown.jpLock)}
          isNew={Boolean(shown.isNew) && shown.reviewState !== "locked"}
          ignored={skip && locked}
          autoRunPassed={autoRunPassed}
          autoRunFailed={shown.id === autoRunFailedTtsId}
          autoRunError={autoRunError}
        />
      ) : null}
    </div>
  );
}
