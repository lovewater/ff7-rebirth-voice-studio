import { NextResponse } from "next/server";
import { comparisonKey, getSpeechComparisons } from "@/lib/speech-metrics-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ stem: string }> }) {
  const { stem } = await params;
  const raw = new URL(req.url).searchParams.get("ttsId");
  if (!/^[\w.\-]+$/.test(stem) || (raw !== null && !/^\d{1,18}$/.test(raw))) {
    return NextResponse.json({ error: "无效的台词或版本编号" }, { status: 400 });
  }
  const id = raw === null ? undefined : BigInt(raw).toString();
  try {
    const data = (await getSpeechComparisons([{ stem, id }]))[comparisonKey(stem, id)];
    if (!data) return NextResponse.json({ error: "台词或音频版本不存在，请刷新页面" }, { status: 404 });
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Saved speech comparison unavailable", error);
    return NextResponse.json({ error: "净发声数据暂不可用，请稍后重试" }, { status: 503 });
  }
}
