import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isTtsReviewState } from "@/lib/tts-review-state";
import { needsLockSubtitleConfirmation } from "@/lib/tts-lock-subtitle";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { createAutoRunSubtitleFormatter } from "@/lib/auto-run-subtitle-format";
import { finalizeAutoSubtitle } from "@/lib/final-auto-subtitle";
import { sql } from "@/lib/db";

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
    reviewState?: "candidate" | "locked" | "abnormal";
    subtitleText?: string | null;
    requireSubtitleConfirmation?: boolean;
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "无效的音频更新请求" }, { status: 400 });
  }
  const hasState = Object.prototype.hasOwnProperty.call(body, "reviewState");
  if (hasState && !isTtsReviewState(body.reviewState)) {
    return NextResponse.json({ error: "reviewState 必须为 candidate、locked 或 abnormal" }, { status: 400 });
  }
  const hasSub = Object.prototype.hasOwnProperty.call(body, "subtitleText");
  if (!hasState && !hasSub) {
    return NextResponse.json({ error: "缺少 reviewState 或 subtitleText" }, { status: 400 });
  }
  const reviewState = hasState ? body.reviewState : undefined;
  const subtitleText =
    hasSub && typeof body.subtitleText === "string" && body.subtitleText.trim()
      ? twoLineSubtitle(body.subtitleText)
      : hasSub
        ? null
        : undefined;
  // Explicit subtitle text on a lock request is the user-confirmed draft.
  const subtitleAutoFilled = reviewState === "locked" && hasSub;
  try {
    const updatedRows = await sql.begin(async (tx) => {
      // 同一句的状态切换串行，保证锁定/异常的互斥切换原子完成。
      await tx`SELECT stem FROM lines WHERE stem = ${stem} FOR UPDATE`;
      const target = (
        await tx<{
          id: number;
          tts_text: string;
          subtitle_text: string | null;
          review_state: "candidate" | "locked" | "abnormal";
          is_jp_lock: boolean;
          is_auto_final: boolean;
        }[]>`
          SELECT id, tts_text, subtitle_text, review_state,
                 (voice_gpu_key = 'jp-lock' OR conversion_meta->>'pipeline' = 'jp-lock') AS is_jp_lock,
                 EXISTS (
                   -- 空覆盖表示沿用游戏字幕。音频编辑/G重处理会复制空值，但不复制auto_run_id；
                   -- 需沿同句、同朗读稿的audio-edit来源找已结束任务的最终成品，不能误认正文子音频。
                   -- 限深度、防环，并校验source_id后转换；修改文字或跨句的链条立即中止。
                   WITH RECURSIVE lineage AS (
                     SELECT line_tts_versions.id, line_tts_versions.stem, line_tts_versions.tts_text,
                            line_tts_versions.spoken_text, line_tts_versions.auto_run_id,
                            line_tts_versions.conversion_meta, ARRAY[line_tts_versions.id] AS visited
                     UNION ALL
                     SELECT parent.id, parent.stem, parent.tts_text, parent.spoken_text,
                            parent.auto_run_id, parent.conversion_meta, child.visited || parent.id
                     FROM lineage child JOIN line_tts_versions parent
                       ON parent.id = CASE WHEN child.conversion_meta->>'source_id' ~ '^[0-9]{1,18}$'
                         THEN (child.conversion_meta->>'source_id')::bigint END
                     WHERE child.conversion_meta->>'pipeline' = 'audio-edit'
                       AND parent.stem = child.stem AND parent.status = 'ready'
                       AND parent.tts_text IS NOT DISTINCT FROM child.tts_text
                       AND parent.spoken_text IS NOT DISTINCT FROM child.spoken_text
                       AND NOT parent.id = ANY(child.visited) AND cardinality(child.visited) < 32
                   )
                   SELECT 1 FROM lineage ancestor JOIN line_auto_runs ar
                     ON ar.id = ancestor.auto_run_id AND ar.stem = ancestor.stem
                   WHERE ar.selected_tts_id = ancestor.id AND ar.status IN ('passed', 'failed')
                 ) AS is_auto_final
          FROM line_tts_versions
          WHERE id = ${Number(id)} AND stem = ${stem} AND status = 'ready'
          FOR UPDATE
        `
      )[0];
      if (!target) return [] as { id: number; review_state: "candidate" | "locked" | "abnormal"; subtitle_text: string | null }[];

      // 异常修订必须人工核对：优先当前覆盖字幕，否则沿用完整原字幕，
      // 不从去掉拟声词的TTS朗读稿推导，取消弹窗前不写入任何锁/字幕。
      if (reviewState === "locked" && body.requireSubtitleConfirmation === true && !hasSub) {
        const [line] = await tx<{ text_zh: string | null }[]>`SELECT text_zh FROM lines WHERE stem = ${stem}`;
        const original = (line?.text_zh ?? "").replace(/\\n/g, "\n");
        const manualProposal = needsLockSubtitleConfirmation({ isAutoFinal: target.is_auto_final,
          isJapaneseOriginal: target.is_jp_lock, subtitle: target.subtitle_text,
          ttsText: target.tts_text, original });
        const proposal = target.subtitle_text?.trim() ? target.subtitle_text : manualProposal
          ? twoLineSubtitle(target.tts_text.replace(/\[停顿=\d{1,4}\]/g, "")) || original : original;
        throw new SubtitleConfirmationRequired(proposal, original);
      }
      const newlyLocked = reviewState === "locked" && target.review_state !== "locked";
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
          // edits this proposal, then sends subtitleText and reviewState together.
          const proposal = twoLineSubtitle(target.tts_text.replace(/\[停顿=\d{1,4}\]/g, ""));
          if (proposal) throw new SubtitleConfirmationRequired(proposal, original.replace(/\\n/g, "\n"));
        }
      }
      if (reviewState && reviewState !== "candidate") {
        await tx`
          UPDATE line_tts_versions
          SET review_state = 'candidate', used_at = NULL
          WHERE stem = ${stem} AND review_state IN ('locked', 'abnormal')
        `;
      }
      if (hasState && hasSub) {
        return await tx<{ id: number; review_state: "candidate" | "locked" | "abnormal"; subtitle_text: string | null }[]>`
          UPDATE line_tts_versions SET
            review_state = ${reviewState!},
            used_at = CASE WHEN ${reviewState!} = 'locked' THEN now() ELSE NULL END,
            subtitle_text = ${subtitleText ?? null}
          WHERE id = ${target.id}
          RETURNING id, review_state, subtitle_text
        `;
      }
      if (hasState) {
        return await tx<{ id: number; review_state: "candidate" | "locked" | "abnormal"; subtitle_text: string | null }[]>`
          UPDATE line_tts_versions SET
            review_state = ${reviewState!},
            used_at = CASE WHEN ${reviewState!} = 'locked' THEN now() ELSE NULL END
          WHERE id = ${target.id}
          RETURNING id, review_state, subtitle_text
        `;
      }
      return await tx<{ id: number; review_state: "candidate" | "locked" | "abnormal"; subtitle_text: string | null }[]>`
        UPDATE line_tts_versions SET
          subtitle_text = ${subtitleText ?? null}
        WHERE id = ${target.id}
        RETURNING id, review_state, subtitle_text
      `;
    });
    const updated = updatedRows[0];
    if (!updated) return NextResponse.json({ error: "记录不存在或尚未完成" }, { status: 404 });
    return NextResponse.json({ ok: true, record: updated, skippedTiming: false, subtitleAutoFilled });
  } catch (error) {
    if (error instanceof SubtitleConfirmationRequired) {
      // 事务已回滚，再复用自动字幕排版，避免等待模型时持有音频记录锁。
      // 仅生成弹窗草稿，不写字幕、不改TTS稿和音频；取消确认仍保留原锁。
      let proposal = error.subtitleText;
      let subtitlePreparationError: string | undefined;
      try {
        proposal = await createAutoRunSubtitleFormatter()(proposal);
      } catch {
        // 模型断行不可用时保留程序排版结果，让用户仍能确认或手工修改。
        subtitlePreparationError = "自动语义断行未完成，请检查字幕分行。";
      }
      proposal = finalizeAutoSubtitle(proposal, error.originalText) ?? error.originalText;
      return NextResponse.json({ code: "SUBTITLE_CONFIRMATION_REQUIRED", error: error.message,
        subtitleText: proposal, originalText: error.originalText, subtitlePreparationError }, { status: 409 });
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
        const versions = await tx<{ id: string; review_state: "candidate" | "locked" | "abnormal"; heard_at: string | null; status: string }[]>`
          SELECT id::text, review_state, heard_at, status FROM line_tts_versions
          WHERE stem = ${stem} ORDER BY id FOR UPDATE
        `;
        const [meta] = await tx<{ skip_timing: boolean }[]>`
          SELECT skip_timing FROM line_meta WHERE stem = ${stem} FOR UPDATE
        `;
        const target = versions.find((item) => item.id === id);
        if (!target) return false;
        if (meta?.skip_timing || versions.some((item) => item.review_state === "locked")
            || target.review_state === "abnormal" || target.heard_at != null || target.status !== "ready") {
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
