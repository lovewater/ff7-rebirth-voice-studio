import { originalCnLockedExpr } from "@/lib/line-filters";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { healthFlagExpr } from "@/lib/line-filters";

export const dynamic = "force-dynamic";

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export type TtsSnapshot = {
  id: string | null;
  reviewState: "candidate" | "locked" | "abnormal";
  subtitle: string | null;
  ttsText: string | null;
  count: number;
  jpLock?: boolean;
  skipTiming?: boolean;
  flag?: string;
  isNew?: boolean;
  timing: {
    start: number | null;
    end: number | null;
    dur: number | null;
    speech: number | null;
  } | null;
};

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("stems") ?? "";
  const stems = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!stems.length) return NextResponse.json({ stems: {} });
  if (stems.length > 40 || stems.some((s) => !stemOk(s))) {
    return NextResponse.json({ error: "bad stems" }, { status: 400 });
  }

  const latest = await sql<
    {
      stem: string;
      id: string;
      review_state: "candidate" | "locked" | "abnormal";
      subtitle_text: string | null;
      tts_text: string;
      jp_lock: boolean;
      is_new: boolean;
      start_s: number | null;
      end_s: number | null;
      dur_s: number | null;
      speech_s: number | null;
    }[]
  >`
    SELECT DISTINCT ON (stem)
      stem, id::text AS id, review_state, subtitle_text, tts_text,
      (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS jp_lock,
      (heard_at IS NULL) AS is_new,
      start_s, end_s, dur_s, speech_s
    FROM line_tts_versions
    WHERE stem = ANY(${stems}) AND status = 'ready'
    ORDER BY stem, (review_state <> 'candidate') DESC, (parent_tts_id IS NULL) DESC, id DESC
  `;
  const counts = await sql<{ stem: string; n: number }[]>`
    SELECT stem, COUNT(*)::int AS n
    FROM line_tts_versions
    WHERE stem = ANY(${stems}) AND status = 'ready'
    GROUP BY stem
  `;
  const nByStem = new Map(counts.map((row) => [row.stem, row.n]));
  const skips = await sql<{ stem: string; skip_timing: boolean; flag: string }[]>`
    SELECT l.stem, ${originalCnLockedExpr()} AS skip_timing, (${healthFlagExpr()}) AS flag
    FROM lines l LEFT JOIN line_meta m ON m.stem = l.stem
    WHERE l.stem = ANY(${stems})
  `;
  const flagByStem = new Map(skips.map((row) => [row.stem, row.flag]));
  const skipByStem = new Map(skips.map((row) => [row.stem, row.skip_timing === true]));
  const byStem: Record<string, TtsSnapshot> = {};
  for (const stem of stems) {
    byStem[stem] = {
      id: null,
      reviewState: "candidate",
      subtitle: null,
      ttsText: null,
      count: nByStem.get(stem) ?? 0,
      jpLock: false,
      skipTiming: skipByStem.get(stem) === true,
      flag: flagByStem.get(stem),
      isNew: false,
      timing: null,
    };
  }
  for (const row of latest) {
    byStem[row.stem] = {
      id: row.id,
      reviewState: row.review_state,
      subtitle: row.subtitle_text,
      ttsText: row.tts_text,
      count: nByStem.get(row.stem) ?? 0,
      jpLock: row.jp_lock === true,
      skipTiming: skipByStem.get(row.stem) === true,
      flag: flagByStem.get(row.stem),
      isNew: row.is_new === true,
      timing: {
        start: row.start_s,
        end: row.end_s,
        dur: row.dur_s,
        speech: row.speech_s,
      },
    };
  }
  return NextResponse.json({ stems: byStem });
}
