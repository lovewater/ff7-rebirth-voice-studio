"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { AutoRunPanel } from "./auto-run-panel";
import { SequencePlay } from "./sequence-play";

export function SequenceAutoRun({ stem }: { stem: string }) {
  const left = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = left.current;
    if (!el) return;
    const apply = () => {
      const next = Math.round(el.getBoundingClientRect().height);
      if (next > 0) setHeight((old) => (old === next ? old : next));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stem]);

  return (
    <div className="mt-4 grid items-start gap-3 lg:grid-cols-2">
      <div ref={left}>
        <SequencePlay stem={stem} />
      </div>
      <div
        className="flex min-h-0 flex-col overflow-hidden"
        style={height ? { height, maxHeight: height } : undefined}
      >
        <AutoRunPanel stem={stem} />
      </div>
    </div>
  );
}
