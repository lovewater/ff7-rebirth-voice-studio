import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { projectReadiness } from "@/lib/game-profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM lines WHERE processing_state='active'`;
  return NextResponse.json(projectReadiness(row?.count ?? 0));
}
