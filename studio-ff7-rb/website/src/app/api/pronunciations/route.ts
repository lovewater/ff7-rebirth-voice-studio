import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await sql<{ id: number; src: string; dst: string; note: string | null }[]>`
    SELECT id, src, dst, note FROM pronunciations
    ORDER BY char_length(src) DESC, src
  `;
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { src?: string; dst?: string; note?: string };
  const src = (body.src ?? "").trim();
  const dst = body.dst ?? "";
  const note = (body.note ?? "").trim() || null;
  if (!src) return NextResponse.json({ error: "原文不能为空" }, { status: 400 });
  if (src.length > 80 || dst.length > 80) {
    return NextResponse.json({ error: "原文/替换最长 80 字" }, { status: 400 });
  }
  try {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO pronunciations (src, dst, note) VALUES (${src}, ${dst}, ${note})
      RETURNING id
    `;
    return NextResponse.json({ ok: true, id: row.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("pronunciations_src_key")) {
      return NextResponse.json({ error: "这条原文已经有了" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
