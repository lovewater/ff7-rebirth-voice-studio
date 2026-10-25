/** 普通对话专用：原稿一次，最多三次反馈；不拉伸、不补槽、不按拍数改稿。 */
export const CASUAL_DURATION_RETRIES = 3;
export type CasualDurationAttempt = {
  id: string; script: string; duration: number; textPassed: boolean; reason: string;
};
export function casualDurationPass(attempt: CasualDurationAttempt, target: number) {
  return Number.isFinite(target) && target > 0 && Number.isFinite(attempt.duration)
    && attempt.duration > 0 && attempt.duration <= target && attempt.textPassed;
}
export function compactCasualText(text: string) {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}
export function casualCharacterBudget(script: string, measured: number, target: number) {
  const count = Array.from(compactCasualText(script)).length;
  return Math.max(1, Math.min(count - 1, Math.floor(count * target / measured * .92)));
}
export async function runCasualDurationWorkflow(input: {
  original: string; target: number;
  attempt: (script: string, round: number) => Promise<CasualDurationAttempt>;
  rewrite: (previous: CasualDurationAttempt, maxCharacters: number, round: number) => Promise<string>;
  guard: () => Promise<void>;
}) {
  if (!input.original.trim() || !Number.isFinite(input.target) || input.target <= 0)
    throw new Error('原中文字幕或日文音频时长无效');
  let script = input.original;
  const attempts: CasualDurationAttempt[] = [];
  let rewriteError: string | null = null;
  for (let round = 0; round <= CASUAL_DURATION_RETRIES; round++) {
    await input.guard();
    const attempt = await input.attempt(script, round);
    attempts.push(attempt);
    if (casualDurationPass(attempt, input.target)) return { passed: true, selected: attempt, attempts, rewriteError };
    if (round === CASUAL_DURATION_RETRIES) break;
    // 漏字不能靠删稿伪装成功：校字未过时沿用当前稿重试，占用同一三次反馈预算。
    if (attempt.textPassed && Number.isFinite(attempt.duration) && attempt.duration > input.target) {
      await input.guard();
      try {
        const next = (await input.rewrite(attempt, casualCharacterBudget(script, attempt.duration, input.target), round + 1)).trim();
        if (!next || Array.from(compactCasualText(next)).length >= Array.from(compactCasualText(script)).length)
          throw new Error('压缩稿为空或未减少字数');
        script = next;
      } catch (error) {
        rewriteError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  }
  // 未通过也保留可审核音频，完整读出者优先，再选超时最少的一条；全部漏字取最后一次。
  const complete = attempts.filter(row => row.textPassed && Number.isFinite(row.duration) && row.duration > 0);
  const selected = complete.sort((a, b) => a.duration - b.duration)[0] ?? attempts[attempts.length - 1];
  return { passed: false, selected, attempts, rewriteError };
}
