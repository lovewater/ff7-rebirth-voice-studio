import { rewriteContextChinese } from "@/lib/rewrite-context";
import { rewriteChat, chatModelConfigured, chatModelForTask } from "@/lib/auto-run-llm";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { normalizeScript } from "@/lib/tts-gpu";
import { SUBTITLE_LAYOUT, subtitleLayout } from "@/lib/subtitle-layout";
import { NORMAL_JP_CN_RATIO, type BeatResult } from "@/lib/beats";
import {
  parseRewrite, performanceLabel, rewriteMessages, REWRITE_COUNT, REWRITE_LIMIT, REWRITE_POLICY, REWRITE_MIN, REWRITE_MAX, rewriteBand, rewritePace, samePerformance,
  takeUntilBoundary, type ShowEvidence, type ShowLine,
} from "@/lib/rewrite-prompt";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function GET() {
  return NextResponse.json({ policy: REWRITE_POLICY, min: REWRITE_MIN, max: REWRITE_MAX,
    subtitleLayout: SUBTITLE_LAYOUT, count: REWRITE_COUNT, limit: REWRITE_LIMIT, normalization: NORMAL_JP_CN_RATIO,
    configured: chatModelConfigured(chatModelForTask("manual-rewrite")) });
}

type ContextRow = {
  id: number;
  stem: string;
  kind: string | null;
  name_zh: string | null;
  text_jp: string | null;
  text_en: string | null;
  text_zh: string | null;
  subtitle_italic: boolean;
  dialogue_mode: string | null;
  dialogue_evidence: ShowEvidence | null;
  subtitle_text: string | null;
};

async function count(jp: string, cn: string, signal: AbortSignal): Promise<BeatResult> {
  const response = await fetch(`${process.env.MORA_URL ?? "http://127.0.0.1:8000"}/beats`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairs: [{ jp, cn }] }), cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error("拍数计算服务暂不可用");
  return (await response.json()).results[0];
}

function showLine(row: ContextRow): ShowLine {
  return {
    speaker: row.name_zh || "未知",
    offscreen: row.subtitle_italic,
    textJp: row.text_jp || "",
    textEn: row.text_en || "",
    ...rewriteContextChinese(row.text_zh, row.subtitle_text),
  };
}

// One request = one turn of a five-turn conversation. The browser sends the
// earlier turns back. This endpoint never writes TTS, subtitles, locks, or audio.
export async function POST(req: NextRequest, { params }: { params: Promise<{ stem: string }> }) {
  let body: { text?: unknown; attempt?: unknown; previous?: unknown; action?: unknown; candidates?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 40000) throw new Error();
    body = JSON.parse(raw);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000
      || (body.action !== "select" && (!Number.isInteger(body.attempt) || (body.attempt as number) < 0 || (body.attempt as number) >= REWRITE_LIMIT))
      || (body.action === "select" && (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > REWRITE_LIMIT))) throw new Error();
  } catch { return NextResponse.json({ error: "无效的改写请求" }, { status: 400 }); }
  const { stem } = await params;
  const rows = await sql<ContextRow[]>`
    SELECT l.id, l.stem, COALESCE(s.name_zh, l.speaker) AS name_zh,
           l.text_jp, l.text_en, l.text_zh, l.subtitle_italic, l.kind,
           m.dialogue_mode, m.dialogue_evidence, tv.subtitle_text
    FROM lines l
    JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(BTRIM(v.subtitle_text), ''), l.text_zh, '') AS subtitle_text FROM line_tts_versions v
      WHERE v.stem = l.stem AND v.status = 'ready' AND v.review_state = 'locked'
      ORDER BY v.id DESC LIMIT 1
    ) tv ON true
    WHERE l.id BETWEEN
      (SELECT id FROM lines WHERE stem = ${stem}) - 80
      AND (SELECT id FROM lines WHERE stem = ${stem}) + 80
    ORDER BY l.id`;
  const currentIndex = rows.findIndex((row) => row.stem === stem);
  const line = rows[currentIndex];
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (!line.kind || !["对话", "talk"].includes(line.kind) || line.dialogue_mode !== "scene" || line.subtitle_italic) {
    return NextResponse.json({ error: "仅适用于需要对口型的场景演出" }, { status: 422 });
  }
  if (!line.text_jp || !line.text_zh) return NextResponse.json({ error: "缺少日文或中文原文" }, { status: 422 });
  const task = body.action === "select" ? "manual-selection" : "manual-rewrite";
  if (!chatModelConfigured(chatModelForTask(task))) {
    return NextResponse.json({ error: "尚未配置改写服务" }, { status: 503 });
  }
  try {
    const source = await count(line.text_jp, body.text as string, req.signal);
    if (source.jp.units == null) return NextResponse.json({ error: "日文正文少于8字，跳过语速改写" }, { status: 422 });
    const inside = (row: ContextRow) => row.dialogue_mode === "scene"
      && samePerformance(line.dialogue_evidence, row.dialogue_evidence)
      && !!(row.text_jp || row.text_zh);
    const context = takeUntilBoundary(rows, currentIndex, inside, 8);
    const previous: { raw: string; units: number; spokenUnits: number }[] = [];
    if (Array.isArray(body.previous)) {
      for (const item of body.previous.slice(0, 4)) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        const raw = (item as { raw?: unknown }).raw;
        if (typeof text !== "string" || text.length > 1000 || typeof raw !== "string" || raw.length > 4000) continue;
        previous.push({ raw, units: (await count(line.text_jp, text, req.signal)).cn.units,
          spokenUnits: (await count(line.text_jp, normalizeScript(text, line.text_zh).ttsText, req.signal)).cn.units });
      }
    }
    const messages = rewriteMessages({
      attempt: body.action === "select" ? undefined : body.attempt as number,
      speaker: line.name_zh || "", show: performanceLabel(line.dialogue_evidence),
      textJp: line.text_jp || "", textEn: line.text_en || "", original: line.text_zh,
      current: body.text as string, beats: source,
      before: context.before.map(showLine), after: context.after.map(showLine), previous,
    });
    const selectable: { index: number; text: string; ratio: number; ttsText: string; ttsRatio: number }[] = [];
    if (body.action === "select") {
      for (const [index, item] of (body.candidates as unknown[]).entries()) {
        if (typeof item !== "string" || item.length > 1000) continue;
        const draft = parseRewrite(JSON.stringify({ text: item }));
        const beats = await count(line.text_jp, draft.text, req.signal);
        const { ttsText } = normalizeScript(draft.text, line.text_zh);
        const spoken = await count(line.text_jp, ttsText, req.signal);
        const lineCount = (value: string) => value.replace(/\\n/g, "\n").split(/\n+/).filter((part) => part.trim()).length;
        if (beats.jp.status === "ok" && beats.normalizedRatio != null
            && rewritePace(beats.normalizedRatio, line.text_jp) === "正常"
            && spoken.normalizedRatio != null && rewritePace(spoken.normalizedRatio, line.text_jp) === "正常"
            && lineCount(draft.text) === lineCount(line.text_zh)) {
          selectable.push({ index, text: draft.text, ratio: beats.normalizedRatio, ttsText, ttsRatio: spoken.normalizedRatio! });
        }
      }
      if (!selectable.length) return NextResponse.json({ error: "没有拍数及分行合格的候选" }, { status: 422 });
      messages.push({ role: "user", content: [
        `本轮只择优，不要再改写。以下候选均由程序核实比在 ${rewriteBand(line.text_jp).low}–${rewriteBand(line.text_jp).high} 内，区间内一视同仁，不按接近 1.00 排名。`,
        "结合上面的本场三语前后文，先排除错译、添加事实、遗漏否定/条件/人物关系的稿子，再挑最简洁自然、措辞优美、人物口吻贴切的一条。杜绝车轱辘话、套话和为了凑拍数而加的废话。",
        "字幕排版跟随原字幕行数，不因文字较长额外分行，不改变朗读文本。",
        "只输出 JSON：{\"selectedIndex\":整数或null,\"reason\":\"选择理由或全部拒绝原因\"}。index 必须使用候选原始编号；都不合适就用 null，不得勉强选，不输出新台词。",
        JSON.stringify(selectable),
      ].join("\n"), promptKey: "rewrite.manual-selection", promptValues: {"input_json": JSON.stringify(selectable), beat_min: rewriteBand(line.text_jp).low, beat_max: rewriteBand(line.text_jp).high} });
    }
    // 手动改稿也走通用入口，防止页面按钮遗漏统一模型路由、三位小数处理或访问日志。
    // 只择优不创作台词的manual-selection仍用原模型；所有HTTP重试由连接层统一负责。
    const { content } = await rewriteChat(messages,
      body.action === "select" ? 0.2 : [0.4, 0.55, 0.7, 0.6, 0.5][(body.attempt as number) % REWRITE_COUNT],
      task, 3, { signal: req.signal, stem });
    if (body.action === "select") {
      const selection = JSON.parse(content);
      const reason = typeof selection.reason === "string" ? selection.reason.slice(0, 1000) : "";
      if (selection.selectedIndex === null) return NextResponse.json({ selectedIndex: null, reason, policy: REWRITE_POLICY });
      const chosen = selectable.find((item) => item.index === selection.selectedIndex);
      if (!chosen) throw new Error("模型选择了不合格或不存在的候选");
      return NextResponse.json({ selectedIndex: chosen.index, text: chosen.text, ratio: chosen.ratio, ttsText: chosen.ttsText, ttsRatio: chosen.ttsRatio, subtitleText: subtitleLayout(chosen.text, line.text_zh), reason, policy: REWRITE_POLICY });
    }
    const draft = parseRewrite(content);
    const beats = await count(line.text_jp, draft.text, req.signal);
    const warnings: string[] = [];
    if (!draft.situation || !draft.problem || !draft.plan) warnings.push("模型没有说明改法");
    if (beats.jp.status === "review_reading") warnings.push("日文读音待核对，比值仅供参考");
    if (beats.normalizedRatio == null || rewritePace(beats.normalizedRatio, line.text_jp) !== "正常") warnings.push("拍数尚未达到正常范围");
    if (draft.text.replace(/\s/g, "") === (body.text as string).replace(/\\n/g, "\n").replace(/\s/g, "")) warnings.push("与当前台词相同");
    const lineCount = (value: string) => value.replace(/\\n/g, "\n").split(/\n+/).filter((item) => item.trim()).length;
    if (lineCount(draft.text) !== lineCount(line.text_zh)) warnings.push("换行数量与原字幕不同");
    const show = performanceLabel(line.dialogue_evidence);
    return NextResponse.json({
      ...draft,
      referenceTextJp: line.text_jp,
      policy: REWRITE_POLICY,
      beats,
      target: source.jp.units / NORMAL_JP_CN_RATIO,
      warnings,
      scope: `${show ? `本场 ${show}` : "未识别场次"}，上文 ${context.before.length} 句，下文 ${context.after.length} 句`,
    });
  } catch (error) {
    console.error("台词改写失败", error);
    return NextResponse.json({ error: error instanceof Error && error.name === "TimeoutError"
      ? "改写服务超时" : error instanceof Error ? error.message : "改写失败" }, { status: 502 });
  }
}
