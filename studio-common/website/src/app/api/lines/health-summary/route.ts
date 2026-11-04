import { NextRequest, NextResponse } from "next/server";
import { countFilteredHealth } from "@/lib/line-filters";

export const dynamic = "force-dynamic";

function listParam(v: string | string[] | null): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : v.split(",");
  return arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const stats = await countFilteredHealth({
    region: sp.get("region") ?? "",
    kind: sp.get("kind") ?? "",
    mode: sp.get("mode") ?? "",
    flag: sp.get("flag") ?? "",
    speakers: listParam(sp.getAll("speaker")),
    q: sp.get("q") ?? "",
    onlyCast: sp.get("cast") === "1" || sp.get("cast") === "true",
    modifiedOnly: sp.get("modified") === "1" || sp.get("modified") === "true",
  });
  return NextResponse.json(stats);
}
