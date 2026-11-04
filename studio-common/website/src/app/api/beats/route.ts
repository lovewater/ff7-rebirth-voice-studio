import { stripInlinePinyin } from "@/lib/inline-pinyin";
import { NextRequest, NextResponse } from "next/server";
import type { BeatPair } from "@/lib/beats";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let pairs: BeatPair[];
  try {
    if (Number(req.headers.get("content-length")) > 1048576) {
      return NextResponse.json({ error: "文本过长" }, { status: 413 });
    }
    const raw = await req.text();
    if (raw.length > 1048576) return NextResponse.json({ error: "文本过长" }, { status: 413 });
    const body = JSON.parse(raw);
    if (!Array.isArray(body?.pairs) || !body.pairs.length || body.pairs.length > 100 ||
        body.pairs.some((p: BeatPair | null) => !p ||
          typeof p.jp !== "string" || typeof p.cn !== "string" ||
          p.jp.length > 5000 || p.cn.length > 5000)) {
      return NextResponse.json({ error: "无效的日中文本" }, { status: 400 });
    }
    pairs = body.pairs.map((p:BeatPair)=>({...p,cn:stripInlinePinyin(p.cn)}));
  } catch {
    return NextResponse.json({ error: "无效请求" }, { status: 400 });
  }
  try {
    // Use the SAME core as the batch CLI: no browser dictionary drift, no LLM,
    // no database/audio writes. Native dictionary work stays in the worker.
    const response = await fetch(`${process.env.MORA_URL ?? "http://127.0.0.1:8000"}/beats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairs }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`mora service ${response.status}`);
    return NextResponse.json(await response.json());
  } catch (error) {
    console.error("Beat calculation unavailable", error);
    return NextResponse.json({ error: "拍数计算暂不可用，请稍后重试" }, { status: 503 });
  }
}
