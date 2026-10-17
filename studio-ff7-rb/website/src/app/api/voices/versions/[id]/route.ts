import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function safeVersionDir(relative: string | null) {
  if (!relative || path.isAbsolute(relative)) return null;
  const dataRoot = path.resolve(process.cwd(), "data");
  const embeddedRoot = path.join(dataRoot, "embedded");
  const absolute = path.resolve(dataRoot, relative);
  if (!absolute.startsWith(`${embeddedRoot}${path.sep}`)) return null;
  return absolute;
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const versionId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(versionId) || versionId < 1) {
    return NextResponse.json({ error: "bad version" }, { status: 400 });
  }

  const version = (
    await sql<{ result_dir: string | null }[]>`
      SELECT result_dir FROM voice_bank_versions WHERE id = ${versionId}
    `
  )[0];
  if (!version) return NextResponse.json({ error: "版本不存在" }, { status: 404 });

  const directory = safeVersionDir(version.result_dir);
  if (version.result_dir && !directory) {
    return NextResponse.json({ error: "版本文件目录不安全，已拒绝删除" }, { status: 400 });
  }

  let staged: string | null = null;
  try {
    if (directory && existsSync(directory)) {
      staged = `${directory}.deleting-${randomUUID()}`;
      await rename(directory, staged);
    }
    await sql`DELETE FROM voice_bank_versions WHERE id = ${versionId}`;
  } catch (error) {
    if (staged && directory && existsSync(staged)) await rename(staged, directory).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (staged) {
    try {
      await rm(staged, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: `数据库记录已删除，但临时文件清理失败：${message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, versionId });
}
