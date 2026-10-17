"use client";

import { useState } from "react";

type GroupKey = "lead" | "support" | "extra";

export type SpeakerOpt = {
  speaker: string;
  speaker_name: string;
  n: number;
  role: string | null;
};

function Grid({
  items,
  selected,
  hidden,
  single,
}: {
  items: SpeakerOpt[];
  selected: Set<string>;
  hidden: boolean;
  single: boolean;
}) {
  return (
    <div
      className={`grid max-h-36 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 ${
        hidden ? "hidden" : ""
      }`}
    >
      {items.map((s) => (
        <label key={s.speaker} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-zinc-300 sm:min-h-0 sm:gap-1.5 sm:text-xs">
          <input
            type={single ? "radio" : "checkbox"}
            name="speaker"
            value={s.speaker}
            defaultChecked={selected.has(s.speaker)}
            className="h-4 w-4 accent-zinc-200"
          />
          <span className="truncate" title={s.speaker}>
            {s.speaker_name}
          </span>
          <span className="text-zinc-600">{s.n}</span>
        </label>
      ))}
    </div>
  );
}

function GroupToggle({
  group,
  label,
  count,
  selectedCount,
  open,
  onToggle,
}: {
  group: GroupKey;
  label: string;
  count: number;
  selectedCount: number;
  open: boolean;
  onToggle: (group: GroupKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(group)}
      className={`min-h-11 rounded border px-3 text-sm sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs ${
        open
          ? "border-zinc-500 bg-zinc-800 text-zinc-100"
          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
      }`}
    >
      {label}
      <span className="ml-1 text-zinc-500">
        {count}
        {selectedCount ? ` · 已选 ${selectedCount}` : ""}
      </span>
    </button>
  );
}

export function SpeakerPicker({
  leads,
  supports,
  others,
  selected,
  single = false,
}: {
  leads: SpeakerOpt[];
  supports: SpeakerOpt[];
  others: SpeakerOpt[];
  selected: string[];
  single?: boolean;
}) {
  const [open, setOpen] = useState({ lead: true, support: false, extra: false });
  const picked = new Set(selected);
  const byCode = new Map(
    [...leads, ...supports, ...others].map((s) => [s.speaker, s]),
  );
  const chips = selected.map((code) => byCode.get(code)).filter(Boolean) as SpeakerOpt[];

  function uncheck(code: string, btn: HTMLButtonElement) {
    const form = btn.closest("form");
    if (!form) return;
    const input = form.querySelector<HTMLInputElement>(
      `input[name="speaker"][value="${CSS.escape(code)}"]`,
    );
    if (input) input.checked = false;
    form.requestSubmit();
  }

  const selectedCount = (items: SpeakerOpt[]) =>
    items.filter((speaker) => picked.has(speaker.speaker)).length;
  const toggleGroup = (group: GroupKey) =>
    setOpen((current) => ({ ...current, [group]: !current[group] }));

  return (
    <div className="flex flex-col gap-2">
      {!single && chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((s) => (
            <span
              key={s.speaker}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200"
            >
              {s.speaker_name}
              <button
                type="button"
                aria-label={`取消 ${s.speaker_name}`}
                className="rounded px-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-100"
                onClick={(e) => uncheck(s.speaker, e.currentTarget)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <GroupToggle group="lead" label="主角" count={leads.length} selectedCount={selectedCount(leads)} open={open.lead} onToggle={toggleGroup} />
        <GroupToggle group="support" label="配角" count={supports.length} selectedCount={selectedCount(supports)} open={open.support} onToggle={toggleGroup} />
        <GroupToggle group="extra" label="其它" count={others.length} selectedCount={selectedCount(others)} open={open.extra} onToggle={toggleGroup} />
      </div>
      <Grid items={leads} selected={picked} hidden={!open.lead} single={single} />
      <Grid items={supports} selected={picked} hidden={!open.support} single={single} />
      <Grid items={others} selected={picked} hidden={!open.extra} single={single} />
    </div>
  );
}
