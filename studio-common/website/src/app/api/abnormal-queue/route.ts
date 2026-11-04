import { NextResponse } from "next/server";
import { getAbnormalQueue } from "@/lib/abnormal-queue";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const current = new URL(req.url).searchParams.get('current');
  if (current && !/^[\w.\-]+$/.test(current)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  return NextResponse.json(await getAbnormalQueue(current), { headers: { 'Cache-Control': 'no-store' } });
}
