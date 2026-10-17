import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export type SequenceItem = {
  id: number;
  stem: string;
  speaker: string | null;
  name_zh: string | null;
  text_jp: string | null;
  text_zh: string | null;
  subtitle_italic: boolean;
  current: boolean;
  lockedTtsId: string | null;
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const cur = (
    await sql<{ id: number; region: string | null; kind: string | null }[]>`
      SELECT id, region, kind FROM lines WHERE stem = ${stem}`
  )[0];
  if (!cur) return NextResponse.json({ error: "台词不存在" }, { status: 404 });

  // Match the region/kind list: IDs reflect import order, not dialogue order.
  const before = await sql<{ id: number }[]>`
    SELECT id FROM lines
    WHERE region IS NOT DISTINCT FROM ${cur.region}
      AND kind IS NOT DISTINCT FROM ${cur.kind}
      AND stem < ${stem}
    ORDER BY stem DESC LIMIT 5
  `;
  const after = await sql<{ id: number }[]>`
    SELECT id FROM lines
    WHERE region IS NOT DISTINCT FROM ${cur.region}
      AND kind IS NOT DISTINCT FROM ${cur.kind}
      AND stem > ${stem}
    ORDER BY stem ASC LIMIT 5
  `;
  let nBefore = Math.min(3, before.length);
  let nAfter = Math.min(2, after.length);
  let need = 6 - 1 - nBefore - nAfter;
  if (need > 0 && nAfter < after.length) {
    const extra = Math.min(need, after.length - nAfter);
    nAfter += extra;
    need -= extra;
  }
  if (need > 0 && nBefore < before.length) {
    nBefore += Math.min(need, before.length - nBefore);
  }
  const ids = [
    ...before.slice(0, nBefore).map((row) => row.id).reverse(),
    cur.id,
    ...after.slice(0, nAfter).map((row) => row.id),
  ];
  const rows = await sql<
    {
      id: number;
      stem: string;
      speaker: string | null;
      name_zh: string | null;
      text_jp: string | null;
      text_zh: string | null;
      subtitle_italic: boolean;
      locked_tts_id: string | null;
    }[]
  >`
    SELECT l.id, l.stem, l.speaker,
           COALESCE(s.name_zh, l.speaker) AS name_zh,
           l.text_jp, l.text_zh, l.subtitle_italic,
           tv.id::text AS locked_tts_id
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN LATERAL (
      SELECT id FROM line_tts_versions
      WHERE stem = l.stem AND status = 'ready' AND review_state = 'locked'
      LIMIT 1
    ) tv ON true
    WHERE l.id = ANY(${ids})
    ORDER BY l.stem
  `;
  const items: SequenceItem[] = rows.map((row) => ({
    id: row.id,
    stem: row.stem,
    speaker: row.speaker,
    name_zh: row.name_zh,
    text_jp: row.text_jp,
    text_zh: row.text_zh,
    subtitle_italic: row.subtitle_italic,
    current: row.stem === stem,
    lockedTtsId: row.locked_tts_id,
  }));
  return NextResponse.json({ items });
}
