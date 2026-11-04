import { audioFileResponse } from "@/lib/audio-file-response";
import { sql } from "@/lib/db";
import { gameProfile } from "@/lib/game-profile";
import { sourceAudioFile } from "@/lib/source-audio-files";
import { NextRequest } from "next/server";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ stem: string }> }) {
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) return new Response("bad stem", { status: 400 });
  const requirePairing = gameProfile().id === "remake";
  const row = requirePairing ? (await sql<{ extra: unknown }[]>`SELECT extra FROM line_meta WHERE stem = ${stem}`)[0] : null;
  const file = sourceAudioFile(path.join(process.cwd(), "data"), stem, "en", row?.extra, requirePairing);
  if (!file) return new Response("未配对英文音频", { status: 404 });
  return audioFileResponse(req, file, { contentType: "audio/mpeg", cacheControl: "no-store" });
}

export const HEAD = GET;
