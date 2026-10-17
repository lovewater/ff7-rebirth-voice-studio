import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { src?: string; dst?: string; note?: string };
  const src = (body.src ?? "").trim();
  const dst = body.dst ?? "";
  const note = (body.note ?? "").trim() || null;
  if (!src) return NextResponse.json({ error: "原文不能为空" }, { status: 400 });
  try {
    const rows = await sql`
      UPDATE pronunciations SET src = ${src}, dst = ${dst}, note = ${note}
      WHERE id = ${id}
      RETURNING id
    `;
    if (!rows.length) return NextResponse.json({ error: "不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("pronunciations_src_key")) {
      return NextResponse.json({ error: "这条原文已经有了" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  await sql`DELETE FROM pronunciations WHERE id = ${id}`;
  return NextResponse.json({ ok: true });
}
