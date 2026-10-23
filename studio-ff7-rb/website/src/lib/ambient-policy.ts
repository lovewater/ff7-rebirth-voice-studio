import type { OnoPlan, TimeSpan } from "./auto-run-onomatopoeia";

export const IGNORED_AMBIENT_MAX_MS = 450;
export type AmbientPolicyPlan = OnoPlan & { ignoredAmbient?: TimeSpan[] };

/** 短环境音视作未分类：原音整句用于克隆，不删除、静音或单独拼回。 */
export function applyAmbientPolicy(plan: AmbientPolicyPlan): AmbientPolicyPlan {
  const ignored = plan.ambient.filter(span => Number.isFinite(span.startMs) && Number.isFinite(span.endMs)
    && span.endMs > span.startMs && span.endMs - span.startMs <= IGNORED_AMBIENT_MAX_MS);
  const ambient = plan.ambient.filter(span => !ignored.includes(span));
  const ignoredAmbient = [...(plan.ignoredAmbient ?? []), ...ignored];
  // 将该区间归回整句正文包络，避免参考生成器按原speech边界裁掉开头声音。
  const speech = [...plan.speech, ...ignored.map(({ startMs, endMs }) => ({ startMs, endMs }))]
    .sort((left, right) => left.startMs - right.startMs);
  return { ...plan, ambient, ignoredAmbient, speech,
    enabled: plan.onomatopoeia.length > 0 || ambient.length > 0 };
}
