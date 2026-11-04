/** 锁定稿只替换前后文中文；本句的original/current仍由调用方独立提供。
 * 保留原字幕作对照，不把未锁定候选或人工异常稿当成已确认对白。
 */
export function rewriteContextChinese(original: string | null | undefined, locked: string | null | undefined) {
  const originalTextZh = original ?? "";
  const lockedZh = locked?.trim() || null;
  return { textZh: lockedZh ?? originalTextZh, lockedZh, originalTextZh };
}
