import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { executeAutoRun, latestAutoRun, startAutoRun } from "@/lib/auto-run";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  return NextResponse.json(await latestAutoRun(stem));
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  try {
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body) || (body.forceGenerate !== undefined && typeof body.forceGenerate !== "boolean")) {
      return NextResponse.json({ error: "forceGenerate 必须是布尔值" }, { status: 400 });
    }
    const options = { forceGenerate: body.forceGenerate === true };
    const run = await startAutoRun(stem, options);
    if (run.skipped) return NextResponse.json({ ok: true, ...run });
    after(() => executeAutoRun(run.id, stem, options));
    return NextResponse.json({ ok: true, ...run }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法开始";
    const status = error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
