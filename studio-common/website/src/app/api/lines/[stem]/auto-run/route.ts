import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { executeAutoRun, latestAutoRun, startAutoRun } from "@/lib/auto-run";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;
const capabilities={reuse_original_candidates_supported:true,semantic_autolock_supported:true,models:["grok","primary"]};

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  return NextResponse.json({...await latestAutoRun(stem),...capabilities});
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
    if(body.reuseOriginalCandidates!==undefined&&typeof body.reuseOriginalCandidates!=='boolean')return NextResponse.json({error:'reuseOriginalCandidates必须是布尔值'},{status:400});
    if(body.reuseOriginalCandidates===true&&body.forceGenerate!==true)return NextResponse.json({error:'原稿候选复用必须显式forceGenerate=true'},{status:400});
    if(body.requestId!==undefined&&(typeof body.requestId!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(body.requestId)))return NextResponse.json({error:'无效requestId'},{status:400});
    if(body.model!==undefined && !["grok","primary"].includes(body.model))return NextResponse.json({error:"无效的自动运行模型"},{status:400});
    const options = {
      ...(body.model!==undefined?{model:body.model as "grok"|"primary"}:{}), forceGenerate: body.forceGenerate === true,
      ...(body.reuseOriginalCandidates!==undefined?{reuseOriginalCandidates:body.reuseOriginalCandidates}:{}),...(body.requestId!==undefined?{requestId:body.requestId}:{}) };
    const run = await startAutoRun(stem, options);
    if (run.skipped) return NextResponse.json({ ok: true, ...run,...capabilities });
    after(() => executeAutoRun(run.id, stem, {...options,model:run.model}));
    return NextResponse.json({ ok: true, ...run,...capabilities }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法开始";
    const status = error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
