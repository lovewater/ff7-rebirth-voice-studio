"use client";

import { useId, useState, type ReactNode } from "react";
import { ttsVersionForest, type VersionNode, type VersionRelation } from "@/lib/tts-version-tree";

/** 两处版本列表共用收折行为；每条子音频仍由原来的行组件绘制。 */
export function TtsVersionTree<T extends VersionRelation>({ rows, renderRow }: {
  rows: T[];
  renderRow: (row: T, toggle: ReactNode) => ReactNode;
}) {
  const prefix = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  function render(node: VersionNode<T>): ReactNode {
    const id = String(node.record.id);
    const open = expanded.has(id);
    const controls = `${prefix}-children-${id}`;
    const toggle = node.children.length ? (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        aria-label={`${open ? "收起" : "展开"} #${id} 的 ${node.children.length} 条子音频`}
        title={`${open ? "收起" : "展开"}子音频（${node.children.length}）`}
        onClick={() => setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        })}
        className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 md:min-h-7 md:min-w-7"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={`h-4 w-4 ${open ? "rotate-180" : ""}`}>
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[11px]">{node.children.length}</span>
      </button>
    ) : null;
    return (
      <div key={id} data-tts-version={id}>
        {renderRow(node.record, toggle)}
        {node.children.length ? (
          <div id={controls} hidden={!open} className="ml-4 mt-2 space-y-2 md:ml-6" data-tts-children={id}>
            {open ? node.children.map(render) : null}
          </div>
        ) : null}
      </div>
    );
  }
  return <div className="space-y-2">{ttsVersionForest(rows).map(render)}</div>;
}
