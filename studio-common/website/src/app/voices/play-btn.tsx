"use client";

import { AudioPlayButton } from "@/components/audio-play-button";

export function PlayBtn({ src, label }: { src: string; label: string }) {
  return <AudioPlayButton src={src} label={label} className="inline-flex min-w-8 items-center justify-center whitespace-nowrap rounded px-2 py-0.5 text-xs" />;
}
