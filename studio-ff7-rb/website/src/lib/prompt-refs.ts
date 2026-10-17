import { existsSync } from "node:fs";
import path from "node:path";
import { sql } from "@/lib/db";
import { firstLine } from "@/lib/text";

export type NearbyRef = {
  id: number;
  stem: string;
  offset: number;
  text_jp: string | null;
  text_zh: string | null;
  has_jp: boolean;
  has_cn: boolean;
};

function hasAudio(lang: "jp" | "cn", stem: string) {
  return existsSync(path.join(process.cwd(), "data", lang, `${stem}.mp3`));
}

/** Same-speaker original JP/CN clips immediately before/after this stem, by line id. */
export async function loadNearbySpeakerRefs(
  speaker: string,
  stem: string,
): Promise<NearbyRef[]> {
  const cur = (await sql<{ id: number }[]>`SELECT id FROM lines WHERE stem = ${stem}`)[0];
  if (!cur) return [];
  const before = await sql<{ id: number; stem: string; text_jp: string | null; text_zh: string | null }[]>`
    SELECT l.id, l.stem, l.text_jp, l.text_zh
    FROM lines l
    WHERE l.speaker = ${speaker} AND l.id < ${cur.id}
    ORDER BY l.id DESC
    LIMIT 3
  `;
  const after = await sql<{ id: number; stem: string; text_jp: string | null; text_zh: string | null }[]>`
    SELECT l.id, l.stem, l.text_jp, l.text_zh
    FROM lines l
    WHERE l.speaker = ${speaker} AND l.id > ${cur.id}
    ORDER BY l.id ASC
    LIMIT 3
  `;
  const rows: NearbyRef[] = [
    ...before.map((row, index) => ({
      id: row.id,
      stem: row.stem,
      offset: -(index + 1),
      text_jp: row.text_jp,
      text_zh: row.text_zh,
      has_jp: hasAudio("jp", row.stem),
      has_cn: hasAudio("cn", row.stem),
    })),
    ...after.map((row, index) => ({
      id: row.id,
      stem: row.stem,
      offset: index + 1,
      text_jp: row.text_jp,
      text_zh: row.text_zh,
      has_jp: hasAudio("jp", row.stem),
      has_cn: hasAudio("cn", row.stem),
    })),
  ];
  return rows
    .filter((row) => row.has_jp || row.has_cn)
    .sort((a, b) => a.offset - b.offset);
}

export async function resolvePromptRef(
  speaker: string,
  currentStem: string,
  promptStem: string,
  promptLang: "jp" | "cn",
): Promise<{ ok: true; note: string | null } | { ok: false }> {
  if (promptStem === currentStem) return { ok: true, note: null };
  const owned = await sql<{ note: string }[]>`
    SELECT note FROM speaker_timbre_refs
    WHERE speaker = ${speaker} AND stem = ${promptStem}
  `;
  if (owned[0]) return { ok: true, note: owned[0].note };
  const nearby = await loadNearbySpeakerRefs(speaker, currentStem);
  const hit = nearby.find((row) => row.stem === promptStem);
  if (!hit) return { ok: false };
  if (promptLang === "jp" && !hit.has_jp) return { ok: false };
  if (promptLang === "cn" && !hit.has_cn) return { ok: false };
  const quote = firstLine(promptLang === "cn" ? hit.text_zh : hit.text_jp);
  return { ok: true, note: quote || promptStem };
}
