import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { audioToMonoWav } from "@/lib/audio-splice";
import { stretchWav } from "@/lib/wav-stretch";
import { wavTiming } from "@/lib/tts-gpu";
import { conditionalLockSteps } from "@/lib/conditional-lock";
import { getSpeechComparisons } from "@/lib/speech-metrics-store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 手机小幅缩放后直接采用，源音频不变，新稿仍为顶层可见的编辑结果。
 * 不能先锁源稿再编辑：解码/缩放/写文件任一步失败，原来的人工结论必须保留。
 * 所有音频处理都在事务外；只在最终保存时串行同stem，原子创建新稿并切换锁。
 */
async function conditionalLock(req: Request, ctx: { params: Promise<{ stem: string }> }, preview = false) {
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) return NextResponse.json({ error: "无效的台词编号" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || !["jp", "cn", "tts"].includes(body.source) || (!preview && ![1, 2, 3].includes(body.step))
    || (body.source === "tts" && !/^\d+$/.test(String(body.id ?? "")))) {
    return NextResponse.json({ error: "请选择音频来源及缩放档位" }, { status: 400 });
  }
  let savedPath: string | undefined;
  try {
    const [line] = await sql<{ speaker: string | null; text_jp: string | null; text_zh: string | null }[]>`
      SELECT speaker,text_jp,text_zh FROM lines WHERE stem=${stem}`;
    if (!line?.speaker) return NextResponse.json({ error: "台词不存在或缺少说话人" }, { status: 404 });
    const [source] = body.source === "tts" ? await sql<{
      id: string; audio_path: string; tts_text: string; spoken_text: string; subtitle_text: string | null;
      jp_text_snapshot: string | null; game_zh_text_snapshot: string | null; jp_lock: boolean;
    }[]>`SELECT id::text,audio_path,tts_text,spoken_text,subtitle_text,jp_text_snapshot,game_zh_text_snapshot,
      (voice_gpu_key='jp-lock' OR conversion_meta->>'pipeline'='jp-lock') AS jp_lock
      FROM line_tts_versions WHERE stem=${stem} AND id=${body.id} AND status='ready'` : [];
    if (body.source === "tts" && !source) return NextResponse.json({ error: "源音频不存在或尚未就绪" }, { status: 404 });
    const root = await realpath(path.join(process.cwd(), "data"));
    const sourcePath = await realpath(path.resolve(root, source?.audio_path ?? `${body.source}/${stem}.mp3`));
    if (!sourcePath.startsWith(root + path.sep)) throw new Error("非法音频路径");
    const referencePath = path.join(root, "jp", `${stem}.mp3`);
    const [input, reference] = await Promise.all([
      readFile(sourcePath).then(audioToMonoWav), readFile(referencePath).then(audioToMonoWav),
    ]);
    if (input.length > 20_000_000) throw new Error("音频过长，暂不支持手机条件锁定");
    // 以文件真实总长重新计算，不能信任客户端比例、数据库旧测量值或切过的参考音频。
    const before = wavTiming(input), jp = wavTiming(reference);
    const steps = conditionalLockSteps(before.duration, jp.duration);
    // 预览只读文件：关闭弹窗不创建记录、不写指标、不改任何人工状态。
    if (preview) return NextResponse.json({ duration: before.duration, referenceDuration: jp.duration, steps });
    const choice = steps.find(row => row.step === body.step);
    if (!choice) return NextResponse.json({ error: "音频已与日文等长，无需缩放，请直接锁定" }, { status: 409 });
    const audio = stretchWav(input, choice.ratio);
    const timing = wavTiming(audio);
    const isJapanese = body.source === "jp" || source?.jp_lock === true;
    const pipeline = isJapanese ? "jp-lock" : body.source === "cn" ? "cn-edit" : "audio-edit";
    const label = source?.tts_text || line.text_zh || line.text_jp || "（原声音频）";
    const record = await sql.begin(async tx => {
      await tx`SELECT stem FROM lines WHERE stem=${stem} FOR UPDATE`;
      // 源记录可能在处理期间被删除，删除后不得悄悄采用一个已经不存在的来源。
      if (source) {
        const [exists] = await tx`SELECT id FROM line_tts_versions WHERE stem=${stem} AND id=${source.id} AND status='ready' FOR SHARE`;
        if (!exists) throw new Error("源音频已被删除，请刷新后重试");
      }
      const [created] = await tx<{ id: string }[]>`INSERT INTO line_tts_versions
        (stem,speaker,voice_gpu_key,tts_text,spoken_text,subtitle_text,jp_text_snapshot,game_zh_text_snapshot,duration_factor,emo_alpha)
        VALUES(${stem},${line.speaker},${isJapanese ? "audio-edit" : pipeline},${label},${source?.spoken_text ?? label},
          ${source?.subtitle_text ?? null},${source?.jp_text_snapshot ?? line.text_jp},${source?.game_zh_text_snapshot ?? line.text_zh},${choice.ratio},0)
        RETURNING id::text`;
      const relative = path.posix.join("tts", stem, `${created.id}.wav`);
      savedPath = path.join(root, relative);
      await mkdir(path.dirname(savedPath), { recursive: true });
      await writeFile(savedPath, audio);
      const conversion = { pipeline, operation: "mobile-conditional-lock", source_kind: body.source, source_id: source?.id ?? null,
        step: choice.step, stretch: choice.ratio, duration_before_s: before.duration, duration_after_s: timing.duration,
        jp_duration_s: jp.duration, difference_ms: Math.round((timing.duration - jp.duration) * 1000) };
      await tx`UPDATE line_tts_versions SET review_state='candidate',used_at=NULL
        WHERE stem=${stem} AND review_state IN ('locked','abnormal')`;
      await tx`UPDATE line_tts_versions SET status='ready',audio_path=${relative},audio_bytes=${audio.length},
        start_s=${timing.start},end_s=${timing.end},dur_s=${timing.duration},speech_s=${timing.speech},
        conversion_meta=${sql.json(conversion)},review_state='locked',used_at=now(),completed_at=now()
        WHERE id=${created.id}`;
      return created;
    });
    // 净语速计算排队即可；它失败不能把已经成功的锁定报成失败，诱导用户重复生成。
    await getSpeechComparisons([{ stem, id: record.id }]).catch(() => undefined);
    return NextResponse.json({ ok: true, id: record.id, ratio: choice.ratio, duration: timing.duration,
      referenceDuration: jp.duration, differenceMs: Math.round((timing.duration - jp.duration) * 1000) });
  } catch (error) {
    if (savedPath) await rm(savedPath, { force: true }).catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : "缩放失败，原锁定状态已保留" }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ stem: string }> }) {
  return conditionalLock(req, ctx);
}

export async function GET(req: Request, ctx: { params: Promise<{ stem: string }> }) {
  const search = new URL(req.url).searchParams;
  return conditionalLock(new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: search.get("source"), id: search.get("id") }) }), ctx, true);
}
