"use client";

import { useEffect, useRef, useState } from "react";

type PlaybackState = "idle" | "loading" | "playing";
let current: { audio: HTMLAudioElement; stop: () => void } | null = null;

/** 列表锁定核对开始试听时停止上一条，避免与弹窗音频重叠。 */
export function stopCurrentAudioPlayback() { current?.stop(); }

type Props = {
  src: string;
  label?: string;
  accent?: boolean;
  disabled?: boolean;
  className?: string;
  onPlayRequest?: () => void;
};

// 源地址变化时重建播放器，避免历史稿切换后沿用旧音频/播放状态。
export function AudioPlayButton(props: Props) {
  return <Player key={props.src} {...props} />;
}

function Player({ src, label = "播", accent, disabled, className, onPlayRequest }: Props) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const attempt = useRef(0);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const lastTouchActivation = useRef(-Infinity);
  const [state, setState] = useState<PlaybackState>("idle");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => () => {
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    attempt.current++;
    const audio = ref.current;
    ref.current = null;
    if (audio) {
      if (current?.audio === audio) current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  function stop() {
    clearLoadingTimer();
    attempt.current++;
    const audio = ref.current;
    if (current?.audio === audio) current = null;
    audio?.pause();
    // load取消尚未完成的网络加载及play请求；再次点击从头开始。
    audio?.load();
    setState("idle");
  }

  function clearLoadingTimer() {
    if (loadingTimer.current) clearTimeout(loadingTimer.current);
    loadingTimer.current = null;
  }

  function waitForPlayback() {
    clearLoadingTimer();
    setState("loading");
    const request = attempt.current;
    // 手机媒体引擎偶尔既不playing也不error，不能让按钮无限转圈。
    // 停掉旧请求再提示重试；迟到的play结果受attempt保护，不会恢复已取消的播放。
    loadingTimer.current = setTimeout(() => {
      if (attempt.current !== request || current?.audio !== ref.current) return;
      stop();
      setFailure("音频加载超时，点击重试");
    }, 30000);
  }

  function toggle() {
    if (current?.audio === ref.current && ref.current) {
      stop();
      return;
    }
    current?.stop();
    let audio = ref.current;
    if (!audio) {
      audio = new Audio(src);
      audio.preload = "none";
      ref.current = audio;
      const active = () => ref.current === audio && current?.audio === audio;
      // 只有playing事件表示已经实际出声；请求开始/缓冲等待都显示转圈。
      audio.addEventListener("playing", () => { if (active()) { clearLoadingTimer(); setState("playing"); } });
      audio.addEventListener("waiting", () => { if (active()) waitForPlayback(); });
      const finish = (error: boolean) => {
        if (!active()) return;
        clearLoadingTimer();
        attempt.current++;
        current = null;
        setState("idle");
        setFailure(error ? "播放失败，点击重试" : null);
      };
      // 取消后立刻重播时，旧pause事件可能晚到；已恢复播放就忽略旧事件。
      audio.addEventListener("pause", () => { if (audio?.paused) finish(false); });
      audio.addEventListener("ended", () => finish(false));
      audio.addEventListener("error", () => finish(true));
    }
    current = { audio, stop };
    setFailure(null);
    const request = ++attempt.current;
    waitForPlayback();
    onPlayRequest?.();
    // 切歌/取消后旧请求可能才reject，不能把新请求的状态覆盖掉。
    void audio.play().catch(() => {
      if (attempt.current !== request || ref.current !== audio) return;
      if (current?.audio === audio) current = null;
      clearLoadingTimer();
      setState("idle");
      setFailure("播放失败，点击重试");
    });
  }

  const hint = state === "loading" ? "加载中，点击取消" : state === "playing" ? "正在播放，点击停止" : failure ?? "播放";
  return (
    <button type="button" disabled={disabled}
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => { pointerStart.current = null; }}
      onPointerUp={(event) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (event.pointerType === "mouse" || !start || start.id !== event.pointerId || disabled) return;
        // 松手才播放，滑动列表不误播。直接在用户手势中play，兼容手机的自动播放限制。
        const rect = event.currentTarget.getBoundingClientRect();
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
        event.preventDefault();
        lastTouchActivation.current = performance.now();
        toggle();
      }}
      onClick={(event) => {
        // 手机松手后可能补发click；去重，避免刚播放就又被同一次触摸停止。
        // detail=0保留键盘/辅助技术的按钮激活。
        if (event.detail !== 0 && performance.now() - lastTouchActivation.current < 800) return;
        toggle();
      }}
      title={hint} aria-label={`${label}：${hint}`} aria-busy={state === "loading"} aria-pressed={state !== "idle"}
      data-playback-state={state}
      className={`audio-play-button touch-manipulation select-none ${className ?? "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-sm md:h-auto md:w-8 md:px-1 md:py-0.5 md:text-xs"} disabled:opacity-40 ${
        state === "playing" ? accent ? "bg-sky-100 text-sky-950" : "bg-zinc-100 text-zinc-900"
          : accent ? "bg-sky-950 text-sky-200 hover:bg-sky-900" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
      }`}>
      {state === "loading" ? <svg aria-hidden="true" className="pointer-events-none h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg> : state === "playing" ? "停" : failure ? "重试" : label}
    </button>
  );
}
