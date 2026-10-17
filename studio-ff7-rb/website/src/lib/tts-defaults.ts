export type LineLang = "jp" | "cn" | "en";
export type EmoRef = LineLang;
export type SeedVcRef = "auto" | "native" | LineLang;
export type SourceLang = LineLang;

export type TtsDefaults = {
  voice_version_id: number | null;
  emo_ref: EmoRef;
  seed_vc_ref: SeedVcRef;
  duration_factor: number;
  emo_alpha: number;
};

export const TTS_DEFAULTS: TtsDefaults = {
  voice_version_id: null,
  emo_ref: "jp",
  seed_vc_ref: "auto",
  duration_factor: 1,
  emo_alpha: 0.4,
};

export function sourceLangLabel(lang: string | null | undefined) {
  if (lang === "en") return "英文音源";
  if (lang === "jp") return "日文音源";
  return "中文音源";
}

export function langShort(lang: string | null | undefined) {
  if (lang === "en") return "英";
  if (lang === "cn") return "中";
  return "日";
}

export function parseLineLang(value: unknown): LineLang | null {
  return value === "jp" || value === "cn" || value === "en" ? value : null;
}

export function parseSeedVcRef(value: unknown): SeedVcRef {
  if (value === "auto" || value === "native") return value;
  const lang = parseLineLang(value);
  if (lang) return lang;
  if (value === "original") return "jp";
  return "auto";
}

export function seedVcGpuMode(ref: SeedVcRef): "auto" | "original" | "native" {
  if (ref === "auto") return "auto";
  if (ref === "native") return "native";
  return "original";
}

/** Audio language Seed-VC treats as「原文」. 自动/本色时跟情绪参考走。 */
export function seedOriginalLang(ref: SeedVcRef, emoRef: EmoRef): LineLang {
  if (ref === "auto" || ref === "native") return emoRef;
  return ref;
}

export function parseTtsDefaults(raw: unknown): TtsDefaults {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const voice = Number(src.voice_version_id);
  const factor = Number(src.duration_factor);
  const emo = Number(src.emo_alpha);
  return {
    voice_version_id: Number.isInteger(voice) && voice > 0 ? voice : null,
    emo_ref: parseLineLang(src.emo_ref) ?? "jp",
    seed_vc_ref: parseSeedVcRef(src.seed_vc_ref),
    duration_factor: Number.isFinite(factor) ? Math.min(2, Math.max(0.5, factor)) : 1,
    emo_alpha: Number.isFinite(emo) ? Math.min(1, Math.max(0, emo)) : 0.4,
  };
}
