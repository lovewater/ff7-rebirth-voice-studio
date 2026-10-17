export type VersionRelation = { id: string; parent_tts_id?: string | null };
export type VersionNode<T> = { record: T; children: VersionNode<T>[] };

/** 保留调用方排序。父音频已删除/未就绪时子级提升到顶层；坏数据有环也不能吞掉音频。 */
export function ttsVersionForest<T extends VersionRelation>(rows: T[]): VersionNode<T>[] {
  const nodes = new Map(rows.map((record) => [String(record.id), { record, children: [] } as VersionNode<T>]));
  const parentOf = new Map(rows.map((row) => [String(row.id), row.parent_tts_id == null ? null : String(row.parent_tts_id)]));
  const roots: VersionNode<T>[] = [];
  for (const row of rows) {
    const node = nodes.get(String(row.id))!;
    const parent = row.parent_tts_id == null ? undefined : nodes.get(String(row.parent_tts_id));
    const seen = new Set([String(row.id)]);
    let ancestor = parent ? String(parent.record.id) : null;
    let cycle = false;
    while (ancestor != null && nodes.has(ancestor)) {
      if (seen.has(ancestor)) { cycle = true; break; }
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor) ?? null;
    }
    if (parent && !cycle) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 默认编辑/字幕目标优先已锁定版本，其次顶层最终产物，不误选编号更新的中间候选。 */
export function preferredTtsVersion<T extends VersionRelation & { review_state: "candidate" | "locked" | "abnormal"; status: string }>(rows: T[]) {
  const ready = rows.filter((row) => row.status === "ready" && row.review_state !== "abnormal");
  return ready.find((row) => row.review_state === "locked") ?? ttsVersionForest(ready)[0]?.record;
}
