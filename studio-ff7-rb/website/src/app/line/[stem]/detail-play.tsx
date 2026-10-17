"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayCell } from "@/app/lines/play-cell";
import { AudioEditDialog } from "./audio-edit-dialog";
import { notifyTtsChanged } from "./versions";
import type { Timing } from "@/lib/timing";

export function DetailPlay(
  props: {
    stem: string;
    jp: Timing;
    cn: Timing;
    kind?: string | null;
    warn?: number;
    err?: number;
    skipTiming?: boolean;
    timingExempt?: boolean;
    beatsEnabled?: boolean;
    beatTexts?: { jp: string | null; cn: string | null; modified?: string | null };
    modified?: {
      id: string;
      reviewState: "candidate" | "locked" | "abnormal";
      timing: Timing;
      jpLock?: boolean;
      isNew?: boolean;
    } | null;
  },
) {
  const router = useRouter();
  const [editCn, setEditCn] = useState(false);
  return (
    <>
      <PlayCell
        {...props}
        cnExtra={
          <button
            type="button"
            onClick={() => setEditCn(true)}
            className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[11px]"
          >
            修改
          </button>
        }
      />
      {editCn ? (
        <AudioEditDialog
          stem={props.stem}
          source="cn"
          jp={props.jp}
          onClose={() => setEditCn(false)}
          onSaved={() => {
            setEditCn(false);
            notifyTtsChanged();
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
