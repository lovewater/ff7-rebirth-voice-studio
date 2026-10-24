import { sql } from "./db";
import type { ReviewLine, ReviewVersion } from "@/app/review/[stem]/review";

export async function loadReviewData(stem: string) {
  const [lines, versions] = await Promise.all([
    sql<ReviewLine[]>`SELECT l.stem,l.region,l.text_jp,l.text_zh,l.kind,l.subtitle_italic,m.dialogue_mode,
      COALESCE(rg.name_zh,l.region,'未分区') AS region_name,COALESCE(s.name_zh,l.speaker,'未知角色') AS name_zh,
      m.jp_start_s,m.jp_end_s,m.jp_dur_s,m.jp_speech_s,m.cn_start_s,m.cn_end_s,m.cn_dur_s,m.cn_speech_s
      FROM lines l LEFT JOIN regions rg ON rg.code=l.region LEFT JOIN speakers s ON s.code=l.speaker
      LEFT JOIN line_meta m ON m.stem=l.stem WHERE l.stem=${stem}`,
    sql<ReviewVersion[]>`SELECT id::text AS id,parent_tts_id::text AS parent_tts_id,review_state,voice_gpu_key,
      subtitle_text,tts_text,start_s,end_s,dur_s,speech_s FROM line_tts_versions
      WHERE stem=${stem} AND status='ready' ORDER BY id DESC`,
  ]);
  return { line: lines[0] ?? null, versions };
}
