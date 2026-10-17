import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { needsLockSubtitleConfirmation } from "@/lib/tts-lock-subtitle";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";
import { healthCaption } from "@/lib/timing";

export const dynamic = "force-dynamic";

function valid(stem: string, id: string) {
  return /^[\w.\-]+$/.test(stem) && /^\d+$/.test(id);
}

class SubtitleConfirmationRequired extends Error {
  constructor(public subtitleText: string, public originalText: string) { super("请确认要同步的字幕"); }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string; id: string }> },
) {
  const { stem, id } = await ctx.params;
  if (!valid(stem, id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as {
    isUsed?: boolean;
    subtitleText?: string | null;
  };
  const hasUsed = typeof body.isUsed === "boolean";
  const hasSub = Object.prototype.hasOwnProperty.call(body, "subtitleText");
  if (!hasUsed && !hasSub) {
    return NextResponse.json({ error: "缺少 isUsed 或 subtitleText" }, { status: 400 });
  }
  const isUsed = hasUsed ? body.isUsed : undefined;
  const subtitleText =
    hasSub && typeof body.subtitleText === "string" && body.subtitleText.trim()
      ? twoLineSubtitle(body.subtitleText)
      : hasSub
        ? null
        : undefined;
  // Explicit subtitle text on a lock request is the user-confirmed draft.
  const subtitleAutoFilled = isUsed === true && hasSub;
  try {
    const updatedRows = await sql.begin(async (tx) => {
      const target = (
        await tx<{
          id: number;
          tts_text: string;
          subtitle_text: string | null;
          is_used: boolean;
          is_jp_lock: boolean;
          is_auto_final: boolean;
        }[]>`
          SELECT id, tts_text, subtitle_text, is_used,
                 (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS is_jp_lock,
                 EXISTS (SELECT 1 FROM line_auto_runs ar
                   WHERE ar.id = line_tts_versions.auto_run_id
                     AND ar.selected_tts_id = line_tts_versions.id
                     AND ar.status IN ('passed', 'failed')) AS is_auto_final
          FROM line_tts_versions
          WHERE id = ${Number(id)} AND stem = ${stem} AND status = 'ready'
          FOR UPDATE
        `
      )[0];
      if (!target) return [] as { id: number; is_used: boolean; subtitle_text: string | null }[];

      const newlyLocked = isUsed === true && !target.is_used;
      if (
        newlyLocked &&
        !hasSub &&
        !target.is_jp_lock &&
        !target.subtitle_text?.trim()
      ) {
        const [line] = await tx<{ text_zh: string | null }[]>`
          SELECT text_zh FROM lines WHERE stem = ${stem}
        `;
        const original = line?.text_zh ?? "";
        // 自动最终成品的空覆盖是明确的“沿用原文”，不能按去拟声朗读稿重新提议字幕。
        if (needsLockSubtitleConfirmation({ isAutoFinal: target.is_auto_final,
          isJapaneseOriginal: target.is_jp_lock, subtitle: target.subtitle_text,
          ttsText: target.tts_text, original })) {
          // Abort the transaction BEFORE any lock/subtitle write. The client
          // edits this proposal, then sends subtitleText and isUsed together.
          const proposal = twoLineSubtitle(target.tts_text.replace(/\[停顿=\d{1,4}\]/g, ""));
          if (proposal) throw new SubtitleConfirmationRequired(proposal, original.replace(/\\n/g, "\n"));
        }
      }
      if (isUsed === true) {
        await tx`
          UPDATE line_tts_versions
          SET is_used = false, used_at = NULL
          WHERE stem = ${stem} AND is_used
        `;
      }
      if (hasUsed && hasSub) {
        return await tx<{ id: number; is_used: boolean; subtitle_text: string | null }[]>`
          UPDATE line_tts_versions SET
            is_used = ${isUsed as boolean},
            used_at = CASE WHEN ${isUsed as boolean} THEN now() ELSE NULL END,
            subtitle_text = ${subtitleText ?? null}
          WHERE id = ${target.id}
          RETURNING id, is_used, subtitle_text
        `;
      }
      if (hasUsed) {
        return await tx<{ id: number; is_used: boolean; subtitle_text: string | null }[]>`
          UPDATE line_tts_versions SET
            is_used = ${isUsed as boolean},
            used_at = CASE WHEN ${isUsed as boolean} THEN now() ELSE NULL END
          WHERE id = ${target.id}
          RETURNING id, is_used, subtitle_text
        `;
      }
      return await tx<{ id: number; is_used: boolean; subtitle_text: string | null }[]>`
        UPDATE line_tts_versions SET
          subtitle_text = ${subtitleText ?? null}
        WHERE id = ${target.id}
        RETURNING id, is_used, subtitle_text
      `;
    });
    const updated = updatedRows[0];
    if (!updated) return NextResponse.json({ error: "记录不存在或尚未完成" }, { status: 404 });
    let skippedTiming = false;
    if (isUsed === true) {
      const pair = (
        await sql<{
          kind: string | null;
          jp_start_s: number | null;
          jp_end_s: number | null;
          jp_dur_s: number | null;
          jp_speech_s: number | null;
          start_s: number | null;
          end_s: number | null;
          dur_s: number | null;
          speech_s: number | null;
        }[]>`
          SELECT l.kind,
                 m.jp_start_s, m.jp_end_s, m.jp_dur_s, m.jp_speech_s,
                 t.start_s, t.end_s, t.dur_s, t.speech_s
          FROM line_tts_versions t
          JOIN lines l ON l.stem = t.stem
          LEFT JOIN line_meta m ON m.stem = t.stem
          WHERE t.id = ${Number(id)} AND t.stem = ${stem}
        `
      )[0];
      if (pair) {
        const flag = healthCaption(
          { start: pair.jp_start_s, end: pair.jp_end_s, dur: pair.jp_dur_s, speech: pair.jp_speech_s },
          { start: pair.start_s, end: pair.end_s, dur: pair.dur_s, speech: pair.speech_s },
          pair.kind ?? undefined,
        ).flag;
        if (flag !== "ok") {
          await sql`
            INSERT INTO line_meta (stem, skip_timing)
            VALUES (${stem}, true)
            ON CONFLICT (stem) DO UPDATE SET skip_timing = true, updated_at = now()
          `;
          skippedTiming = true;
        }
      }
    }
    return NextResponse.json({ ok: true, record: updated, skippedTiming, subtitleAutoFilled });
  } catch (error) {
    if (error instanceof SubtitleConfirmationRequired) {
      return NextResponse.json({ code: "SUBTITLE_CONFIRMATION_REQUIRED", error: error.message,
        subtitleText: error.subtitleText, originalText: error.originalText }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string; id: string }> },
) {
  const { stem, id } = await ctx.params;
  if (!valid(stem, id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const removed = await sql.begin(async (tx) => {
      // Batch cleanup must never race a user listening, adopting, or confirming.
      if (req.nextUrl.searchParams.get("onlyUnreviewed") === "1") {
        const versions = await tx<{ id: string; is_used: boolean; heard_at: string | null; status: string }[]>`
          SELECT id::text, is_used, heard_at, status FROM line_tts_versions
          WHERE stem = ${stem} ORDER BY id FOR UPDATE
        `;
        const [meta] = await tx<{ skip_timing: boolean }[]>`
          SELECT skip_timing FROM line_meta WHERE stem = ${stem} FOR UPDATE
        `;
        const target = versions.find((item) => item.id === id);
        if (!target) return false;
        if (meta?.skip_timing || versions.some((item) => item.is_used)
            || target.heard_at != null || target.status !== "ready") {
          throw new Error("台词或候选已被审查，批处理不删除");
        }
      }
      const [record] = await tx<{ audio_path: string | null; raw_audio_path: string | null; manifest_path: string | null; status: string }[]>`
        SELECT audio_path, raw_audio_path, manifest_path, status FROM line_tts_versions
        WHERE id = ${id} AND stem = ${stem} FOR UPDATE
      `;
      if (!record) return false;
      if (record.status === "building") throw new Error("生成中的记录暂时不能删除");
      const dataRoot = path.resolve(process.cwd(), "data", "tts");
      for (const relative of [record.audio_path, record.raw_audio_path, record.manifest_path]) {
        if (!relative) continue;
        const target = path.resolve(process.cwd(), "data", relative);
        if (!target.startsWith(`${dataRoot}${path.sep}`)) throw new Error("非法音频路径");
        await rm(target, { force: true });
      }
      await tx`DELETE FROM line_tts_versions WHERE id = ${id} AND stem = ${stem}`;
      return true;
    });
    if (!removed) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
