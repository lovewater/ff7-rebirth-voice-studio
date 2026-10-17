"use client";

import { useRef, useState } from "react";

let current: HTMLAudioElement | null = null;

export function PlayBtn({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);

  function toggle() {
    let a = ref.current;
    if (!a) {
      a = new Audio(src);
      a.preload = "none";
      a.addEventListener("ended", () => setOn(false));
      ref.current = a;
    }
    if (on) {
      a.pause();
      a.currentTime = 0;
      setOn(false);
      if (current === a) current = null;
      return;
    }
    if (current && current !== a) {
      current.pause();
      current.currentTime = 0;
    }
    current = a;
    void a.play().then(() => setOn(true)).catch(() => setOn(false));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`min-w-8 whitespace-nowrap rounded px-2 py-0.5 text-xs ${
        on ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
      }`}
    >
      {on ? "停" : label}
    </button>
  );
}
