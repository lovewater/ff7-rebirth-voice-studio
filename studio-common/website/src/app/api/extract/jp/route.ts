import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { gameProfile } from "@/lib/game-profile";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WORKER = path.resolve(process.env.FF7_WORKER_ROOT ?? path.resolve(process.cwd(), "..", "worker"), "extract_one.py");

export async function POST(req: NextRequest) {
  if (!gameProfile().extractionReady) return NextResponse.json({ error: "Remake 游戏资源尚未导入，解包适配确认后才能抽取音频" }, { status: 503 });
  const { stem, chunkId } = (await req.json()) as {
    stem?: string;
    chunkId?: string;
  };
  if (!stem || !chunkId || !/^[\w.\-]+$/.test(stem)) {
    return NextResponse.json({ error: "bad args" }, { status: 400 });
  }
  const args = [
    WORKER,
    "--chunk-id",
    chunkId,
    "--name",
    stem,
    "--kind",
    "jp",
  ];
  const result = await new Promise<{ code: number; out: string; err: string }>(
    (resolve) => {
      const child = spawn("python3", args, {
        env: process.env,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.stderr.on("data", (d) => {
        err += String(d);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    },
  );
  if (result.code !== 0) {
    return NextResponse.json(
      { error: result.err || result.out || "extract failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, log: result.out });
}
