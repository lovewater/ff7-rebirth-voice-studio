export function sourceAudioUrl(stem: string, language: "jp" | "cn", lockedTtsId: string | null, hasOriginalChineseAudio: boolean): string | null {
  const key = encodeURIComponent(stem);
  if (language === "cn" && lockedTtsId) return `/api/lines/${key}/tts/${lockedTtsId}/audio`;
  if (language === "cn" && !hasOriginalChineseAudio) return null;
  return `/api/audio/${language}/${key}`;
}

/** Remake bank clip numbers differ between languages; only the imported pairing is authoritative. */
export function englishAudioRelativePath(stem: string, extra: unknown, requireExplicitPairing = false): string | null {
  if (!requireExplicitPairing) return /^[\w.\-]+$/.test(stem) ? `en/${stem}.mp3` : null;
  const value = (extra && typeof extra === "object" ? extra : {}) as { english_pairing?: { en_audio_path?: unknown } };
  const relative = value.english_pairing?.en_audio_path;
  // Extraction emits flat canonical filenames. Never normalize traversal or accept another language directory.
  return typeof relative === "string" && /^en\/[\w.\-]+\.mp3$/.test(relative) ? relative : null;
}

/** A decoded mix/preview is listenable, but has not been verified as a speaker reference. */
export function audioReferenceIssue(extra: unknown, language: "jp" | "en" = "jp"): string | null {
  if (!extra || typeof extra !== "object") return null;
  const meta = extra as { audio_extraction?: unknown; audio_sources?: { en?: unknown } };
  const raw = language === "en" ? meta.audio_sources?.en : meta.audio_extraction;
  if (!raw || typeof raw !== "object") return null;
  const parent = raw as { clip?: unknown };
  const evidence = (parent.clip && typeof parent.clip === "object" ? parent.clip : raw) as { eligible_for_generation?: unknown; preview_only?: unknown; channels?: unknown; missing_jp?: unknown };
  if (evidence.eligible_for_generation === false || evidence.preview_only === true || evidence.missing_jp === true
    || (typeof evidence.channels === "number" && evidence.channels > 2)) {
    if (evidence.missing_jp === true) return "该条缺少日文原声，不能将其他语言当作日文生成参考；请先人工核对参考音频";
    const channels = typeof evidence.channels === "number" && evidence.channels > 2 ? `${evidence.channels}声道` : "";
    return `该${channels}音频仅供试听，尚未验证为单人生成参考；请先人工拆分并核对参考音频`;
  }
  return null;
}
