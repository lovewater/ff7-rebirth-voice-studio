"use client";

import { useState, type ReactNode } from "react";
import { AudioPlayButton } from "./audio-play-button";
import { reportTtsPlayback } from "@/lib/tts-play-count";
import { useTtsSnapshot } from "@/app/lines/tts-snapshot";

/** 手机列表只试听；所有锁定/异常/编辑动作统一进入独立审核页。 */
export function MobileListAudio({ stem, initialId, children }: { stem: string; initialId: string | null; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  const buttonClass = "inline-flex min-h-12 min-w-16 items-center justify-center rounded-lg px-4 text-sm";
  const live = useTtsSnapshot(stem);
  const id = live === undefined ? initialId : live.id;
  return <><div className="mt-2 flex flex-wrap gap-1.5">
    <AudioPlayButton className={buttonClass} src={`/api/audio/jp/${stem}`} label="日文" />
    <AudioPlayButton className={buttonClass} src={`/api/audio/cn/${stem}`} label="原中文" />
    {id && <AudioPlayButton className={buttonClass} src={`/api/lines/${stem}/tts/${id}/audio`} label="中文结果" accent onPlayRequest={() => { void reportTtsPlayback(stem, id); }} />}
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="ml-auto min-h-12 rounded-md px-2 text-sm text-zinc-400">字幕 {expanded ? "▴" : "▾"}</button>
  </div>{expanded && children}</>;
}
