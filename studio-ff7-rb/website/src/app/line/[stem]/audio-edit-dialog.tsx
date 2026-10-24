"use client";

import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";
import { reportTtsPlayback } from "@/lib/tts-play-count";
import { stopCurrentAudioPlayback } from "@/components/audio-play-button";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ConfigProvider, Dropdown, theme } from "antd";
import {
  alignToJpSlot,
  speechBounds,
  bufferFromMono,
  mixMono,
  deleteRange,
  encodeWavPcm16,
  insertClip,
  insertSilence,
  scaleGain,
  sliceClip,
  stretchDuration,
  stretchRange,
  wavToBase64,
} from "@/lib/audio-edit";
import { alignSpeechGaps, gapOnlyAlignmentPlan, internalSpeechParts } from "@/lib/gap-only-align";
import type { Timing } from "@/lib/timing";

function niceStep(max: number) {
  const raw = Math.max(max / 8, 0.05);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  if (n < 1.5) return pow;
  if (n < 3.5) return 2 * pow;
  if (n < 7.5) return 5 * pow;
  return 10 * pow;
}

function formatTick(t: number, step: number) {
  if (step >= 1) return t.toFixed(0);
  if (step >= 0.1) return t.toFixed(1);
  return t.toFixed(2);
}

function TimeRuler({ duration }: { duration: number }) {
  const max = Math.max(duration, 0.001);
  const major = niceStep(max);
  const minor = major / 5;
  const ticks: { t: number; major: boolean }[] = [];
  for (let t = 0; t <= max + 1e-9; t += minor) {
    const x = Math.round(t / minor) * minor;
    const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
    ticks.push({ t: x, major: isMajor });
  }
  return (
    <div className="relative h-7 w-full">
      <div className="absolute inset-x-0 bottom-0 h-px bg-zinc-700" />
      {ticks.map((tick, i) => (
        <div
          key={`${tick.t}-${i}`}
          className="absolute bottom-0"
          style={{ left: `${(tick.t / max) * 100}%` }}
        >
          <div className={tick.major ? "h-3 w-px bg-zinc-400" : "h-1.5 w-px bg-zinc-600"} />
          {tick.major ? (
            <span className="absolute bottom-3.5 left-0.5 whitespace-nowrap font-mono text-[10px] text-zinc-500">
              {formatTick(tick.t, major)}s
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const pointer = window.matchMedia("(pointer: coarse)");
    const narrow = window.matchMedia("(max-width: 767px)");
    const apply = () => setCoarse(pointer.matches || narrow.matches);
    apply();
    pointer.addEventListener("change", apply);
    narrow.addEventListener("change", apply);
    return () => {
      pointer.removeEventListener("change", apply);
      narrow.removeEventListener("change", apply);
    };
  }, []);
  return coarse;
}

function HoverDrop({
  items,
  onItem,
  menuOnly = false,
  children,
}: {
  items: { key: string; label: string }[];
  onItem: (key: string) => void;
  menuOnly?: boolean;
  children: ReactNode;
}) {
  const coarse = useCoarsePointer();
  const dropdown = (node: ReactNode) => (
    <Dropdown
      trigger={coarse ? ["click"] : ["hover"]}
      placement="bottomLeft"
      mouseEnterDelay={0.05}
      mouseLeaveDelay={0.2}
      getPopupContainer={() => document.body}
      styles={{ root: { zIndex: 2000 } }}
      menu={{
        items,
        onClick: ({ key }) => onItem(String(key)),
      }}
    >
      {node}
    </Dropdown>
  );
  // Phones and narrow windows have no hover. Keep the main action on the button, and open extras from ▾.
  if (coarse && !menuOnly) {
    return (
      <span className="inline-flex items-stretch">
        {children}
        {dropdown(<Button aria-label="更多选项">▾</Button>)}
      </span>
    );
  }
  return dropdown(<span className="inline-flex">{children}</span>);
}

type WsHandle = {
  destroy: () => void;
  getCurrentTime: () => number;
  setTime: (time: number) => void;
  playPause: () => void;
  pause: () => void;
};

type Props = {
  stem: string;
  sourceId?: string;
  source?: "tts" | "cn" | "jp";
  /** 手机试听评价：只读波形，确认时仅锁定原版本，不保存编辑音频。 */
  readOnly?: boolean;
  /** 手机核对只开放一键对齐；调整在确认时另存并锁定，取消不保存。 */
  allowAutoAdjust?: boolean;
  jp: Timing;
  onClose: () => void;
  onSaved: () => void;
  /** 列表场景演出核对：null表示未修改的原中文；返回false表示取消字幕确认。 */
  onConfirmLock?: (id: string | null) => Promise<boolean>;
  /** 仅列表锁定入口传入：初次加载完成后自动试听一次，编辑/撤销不重新自动播。 */
  autoPlayOnOpen?: boolean;
};

export function AudioEditDialog({ stem, sourceId, source = "tts", jp, onClose, onSaved, onConfirmLock, autoPlayOnOpen = false, readOnly = false, allowAutoAdjust = false }: Props) {
  const readOnlyRoot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!readOnly) return;
    const previous = document.activeElement as HTMLElement | null;
    readOnlyRoot.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [readOnly]);
  const jpHostRef = useRef<HTMLDivElement | null>(null);
  const editHostRef = useRef<HTMLDivElement | null>(null);
  const jpWsRef = useRef<WsHandle | null>(null);
  const editWsRef = useRef<WsHandle | null>(null);
  const jpRegionRef = useRef<{ start: number; end: number } | null>(null);
  const editRegionRef = useRef<{ start: number; end: number } | null>(null);
  const lastSelRef = useRef<"jp" | "edit" | null>(null);
  const jpRegionObjRef = useRef<{ setOptions?: (o: { color: string }) => void; element?: HTMLElement | null } | null>(null);
  const editRegionObjRef = useRef<{ setOptions?: (o: { color: string }) => void; element?: HTMLElement | null } | null>(null);

  const JP_ON = "rgba(251, 191, 36, 0.55)";
  const JP_OFF = "rgba(251, 191, 36, 0.14)";
  const EDIT_ON = "rgba(56, 189, 248, 0.55)";
  const EDIT_OFF = "rgba(56, 189, 248, 0.14)";

  function paintSel(which: "jp" | "edit" | null) {
    lastSelRef.current = which;
    const jpObj = jpRegionObjRef.current;
    const edObj = editRegionObjRef.current;
    const jpColor = which === "jp" ? JP_ON : JP_OFF;
    const edColor = which === "edit" ? EDIT_ON : EDIT_OFF;
    try {
      jpObj?.setOptions?.({ color: jpColor });
    } catch {
      /* ignore */
    }
    if (jpObj?.element) jpObj.element.style.backgroundColor = jpColor;
    try {
      edObj?.setOptions?.({ color: edColor });
    } catch {
      /* ignore */
    }
    if (edObj?.element) edObj.element.style.backgroundColor = edColor;
  }
  const ctxRef = useRef<AudioContext | null>(null);
  const [jpBuffer, setJpBuffer] = useState<AudioBuffer | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const hasAudioChanges = Boolean(buffer && originalBuffer && buffer !== originalBuffer);
  const autoPlayedRef = useRef(false);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const autoPlayPending = autoPlayOnOpen && !audioLoaded;
  // 核对后取消字幕弹窗或锁定失败，再确认时复用已保存版本，避免重复创建音频。
  const savedBufferRef = useRef<{ buffer: AudioBuffer; id: string } | null>(null);
  const undoRef = useRef<AudioBuffer[]>([]);
  const [busy, setBusy] = useState("");
  const processingRef = useRef(false);
  const [error, setError] = useState("");
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [jpAt, setJpAt] = useState(0);
  const [editAt, setEditAt] = useState(0);
  const editSeekRef = useRef(0);
  const removeSelRef = useRef<() => void>(() => {});
  const insertGapRef = useRef<(ms: number) => void>(() => {});
  const deleteKeyRef = useRef<() => void>(() => {});
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (readOnly && event.key === "Tab") {
        const buttons = [...(readOnlyRoot.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (readOnly && event.key !== "Escape") return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        if (busy) return;
        const prev = undoRef.current.pop();
        if (prev) {
          editSeekRef.current = editWsRef.current?.getCurrentTime() ?? editAt;
          setBuffer(prev);
        }
        return;
      }
      const tag = (event.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (event.key === "Delete") {
        if (typing) return;
        event.preventDefault();
        if (busy) return;
        deleteKeyRef.current();
        return;
      }
      if (event.key === "Insert") {
        if (typing) return;
        event.preventDefault();
        if (busy) return;
        insertGapRef.current(100);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (busy) return;
      const jpObj = jpRegionObjRef.current as { remove?: () => void } | null;
      const edObj = editRegionObjRef.current as { remove?: () => void } | null;
      const hadSel = Boolean(jpRegionRef.current || editRegionRef.current);
      jpObj?.remove?.();
      edObj?.remove?.();
      jpRegionRef.current = null;
      editRegionRef.current = null;
      lastSelRef.current = null;
      if (hadSel) return;
      jpWsRef.current?.pause();
      editWsRef.current?.pause();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, readOnly]);

  // 随当前编辑缓冲重新判断，撤销、删段或插入静音后菜单也同步变化。
  // 使用已加载的完整日文波形，不能用数据库旧起止值或当前选区代替参考。
  const gapAlignment = useMemo(() => {
    if (!jpBuffer || !buffer) return null;
    const reference = { samples: mixMono(jpBuffer), sampleRate: jpBuffer.sampleRate };
    const edited = { samples: mixMono(buffer), sampleRate: buffer.sampleRate };
    const plan = gapOnlyAlignmentPlan(reference, edited);
    // 两端对话工作流、三段对话工作流共用手动入口；只调留白，不自动缩放正文。
    return plan ? { reference, edited, partCount: plan.partCount } : null;
  }, [jpBuffer, buffer]);

  const scaleMax = Math.max(jpBuffer?.duration ?? 0, buffer?.duration ?? 0, 0.001);
  const jpPct = jpBuffer ? Math.min(100, (jpBuffer.duration / scaleMax) * 100) : 100;
  const editPct = buffer ? Math.min(100, (buffer.duration / scaleMax) * 100) : 100;

  useEffect(() => {
    let cancelled = false;
    autoPlayedRef.current = false;
    setAudioLoaded(false);
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    void (async () => {
      try {
        const editUrl =
          (source === "cn" || source === "jp")
            ? `/api/audio/${source}/${encodeURIComponent(stem)}`
            : `/api/lines/${encodeURIComponent(stem)}/tts/${sourceId}/audio`;
        const [editRes, jpRes] = await Promise.all([
          fetch(editUrl),
          fetch(source === "tts" ? `${editUrl}?kind=reference` : `/api/audio/jp/${encodeURIComponent(stem)}`),
        ]);
        if (!editRes.ok) throw new Error(`加载待改音频失败 HTTP ${editRes.status}`);
        const editRaw = await editRes.arrayBuffer();
        const editDecoded = await ctx.decodeAudioData(editRaw.slice(0));
        if (cancelled) return;
        setOriginalBuffer(editDecoded);
        setBuffer(editDecoded);
        if (jpRes.ok) {
          const jpRaw = await jpRes.arrayBuffer();
          const jpDecoded = await ctx.decodeAudioData(jpRaw.slice(0));
          if (!cancelled) setJpBuffer(jpDecoded);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setAudioLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      jpWsRef.current?.destroy();
      editWsRef.current?.destroy();
      jpWsRef.current = null;
      editWsRef.current = null;
      void ctx.close();
    };
  }, [stem, sourceId, source]);

  useEffect(() => {
    if (!jpBuffer || !jpHostRef.current) return;
    let disposed = false;
    void (async () => {
      const WaveSurfer = (await import("wavesurfer.js")).default;
      const Regions = (await import("wavesurfer.js/dist/plugins/regions.esm.js")).default;
      if (disposed || !jpHostRef.current) return;
      jpWsRef.current?.destroy();
      const regions = Regions.create();
      const objectUrl = URL.createObjectURL(new Blob([encodeWavPcm16(jpBuffer)], { type: "audio/wav" }));
      const ws = WaveSurfer.create({
        container: jpHostRef.current,
        height: 96,
        waveColor: "#a8a29e",
        progressColor: "#fbbf24",
        cursorColor: "#fde68a",
        url: objectUrl,
        plugins: [regions],
      });
      if (!readOnly) regions.enableDragSelection({ color: "rgba(251, 191, 36, 0.55)" });
      regions.on("region-created", (region) => {
        for (const other of regions.getRegions()) {
          if (other.id !== region.id) other.remove();
        }
        jpRegionRef.current = { start: region.start, end: region.end };
        jpRegionObjRef.current = region;
        paintSel("jp");
      });
      regions.on("region-updated", (region) => {
        jpRegionRef.current = { start: region.start, end: region.end };
        jpRegionObjRef.current = region;
        paintSel("jp");
      });
      regions.on("region-clicked", (region) => {
        jpRegionRef.current = { start: region.start, end: region.end };
        jpRegionObjRef.current = region;
        paintSel("jp");
      });
      regions.on("region-removed", () => {
        jpRegionRef.current = null;
        jpRegionObjRef.current = null;
        if (lastSelRef.current === "jp") paintSel(null);
      });
      const syncJp = () => setJpAt(ws.getCurrentTime());
      ws.on("timeupdate", syncJp);
      ws.on("interaction", syncJp);
      ws.on("click", syncJp);
      jpWsRef.current = ws;
      ws.once("destroy", () => URL.revokeObjectURL(objectUrl));
    })();
    return () => {
      disposed = true;
      jpWsRef.current?.destroy();
      jpWsRef.current = null;
      jpRegionRef.current = null;
      jpRegionObjRef.current = null;
    };
  }, [jpBuffer, scaleMax, readOnly]);

  useEffect(() => {
    // 自动试听等待两边音频加载完成，避免JP稍晚到达后重建波形、打断刚开始的试听。
    if (!buffer || !editHostRef.current || autoPlayPending) return;
    let disposed = false;
    void (async () => {
      const WaveSurfer = (await import("wavesurfer.js")).default;
      const Regions = (await import("wavesurfer.js/dist/plugins/regions.esm.js")).default;
      if (disposed || !editHostRef.current) return;
      editWsRef.current?.destroy();
      const regions = Regions.create();
      const objectUrl = URL.createObjectURL(new Blob([encodeWavPcm16(buffer)], { type: "audio/wav" }));
      const ws = WaveSurfer.create({
        container: editHostRef.current,
        height: 112,
        waveColor: "#64748b",
        progressColor: "#38bdf8",
        cursorColor: "#e2e8f0",
        url: objectUrl,
        plugins: [regions],
      });
      if (!readOnly) regions.enableDragSelection({ color: "rgba(56, 189, 248, 0.55)" });
      regions.on("region-created", (region) => {
        for (const other of regions.getRegions()) {
          if (other.id !== region.id) other.remove();
        }
        editRegionRef.current = { start: region.start, end: region.end };
        editRegionObjRef.current = region;
        paintSel("edit");
      });
      regions.on("region-updated", (region) => {
        editRegionRef.current = { start: region.start, end: region.end };
        editRegionObjRef.current = region;
        paintSel("edit");
      });
      regions.on("region-clicked", (region) => {
        editRegionRef.current = { start: region.start, end: region.end };
        editRegionObjRef.current = region;
        paintSel("edit");
      });
      regions.on("region-removed", () => {
        editRegionRef.current = null;
        editRegionObjRef.current = null;
        if (lastSelRef.current === "edit") paintSel(null);
      });
      const syncEdit = () => setEditAt(ws.getCurrentTime());
      ws.on("ready", () => {
        const dur = ws.getDuration();
        const t = Math.min(Math.max(0, editSeekRef.current), Math.max(0, dur - 0.001));
        if (t > 0.001) ws.setTime(t);
        setEditAt(ws.getCurrentTime());
        if (autoPlayOnOpen && !autoPlayedRef.current && !disposed) {
          autoPlayedRef.current = true;
          stopCurrentAudioPlayback();
          if (source === "tts" && sourceId) void reportTtsPlayback(stem, sourceId);
          // 浏览器若限制自动播放，仍可手动点“播编辑”，不影响核对和锁定。
          void ws.play().catch(() => {});
        }
      });
      ws.on("timeupdate", syncEdit);
      ws.on("interaction", syncEdit);
      ws.on("click", syncEdit);
      editWsRef.current = ws;
      ws.once("destroy", () => URL.revokeObjectURL(objectUrl));
    })();
    return () => {
      disposed = true;
      editWsRef.current?.destroy();
      editWsRef.current = null;
      editRegionRef.current = null;
      editRegionObjRef.current = null;
    };
  }, [buffer, scaleMax, readOnly, autoPlayPending, autoPlayOnOpen, source, sourceId, stem]);

  function apply(next: AudioBuffer) {
    if (buffer) undoRef.current.push(buffer);
    editSeekRef.current = editWsRef.current?.getCurrentTime() ?? editAt;
    setBuffer(next);
    setError("");
  }

  function undo() {
    if (processingRef.current || busy) return;
    const prev = undoRef.current.pop();
    if (prev) {
      editSeekRef.current = editWsRef.current?.getCurrentTime() ?? editAt;
      setBuffer(prev);
    }
  }

  function withCtx(fn: (ctx: AudioContext, buf: AudioBuffer) => AudioBuffer | Promise<AudioBuffer>) {
    const ctx = ctxRef.current;
    if (!ctx || !buffer || processingRef.current || busy) return;
    processingRef.current = true;
    setBusy("处理音频中…");
    void (async () => {
      try {
        apply(await fn(ctx, buffer));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        processingRef.current = false;
        setBusy("");
      }
    })();
  }

  function insertGap(ms: number) {
    if (!Number.isFinite(ms) || ms < 20 || ms > 5000) {
      setError("空白时长须在 20 到 5000 毫秒");
      return;
    }
    const at = editWsRef.current?.getCurrentTime() ?? editAt;
    editSeekRef.current = at;
    withCtx((ctx, buf) => insertSilence(ctx, buf, at, ms / 1000));
  }
  insertGapRef.current = insertGap;

  function insertFrom(which: "jp" | "edit") {
    const region = which === "jp" ? jpRegionRef.current : editRegionRef.current;
    const srcBuf = which === "jp" ? jpBuffer : buffer;
    if (!region || !srcBuf || region.end - region.start < 0.02) {
      setError(which === "jp" ? "先在上方日文波形拖出要插入的一段" : "先在下方成品波形拖出要插入的一段");
      return;
    }
    const at = editWsRef.current?.getCurrentTime() ?? 0;
    withCtx((ctx, buf) => {
      const clip = sliceClip(ctx, srcBuf, region.start, region.end);
      return insertClip(ctx, buf, at, clip);
    });
  }

  function removeSel() {
    const region = editRegionRef.current;
    if (!region || region.end - region.start < 0.02) {
      setError("先在下方波形上拖出要删除的一段");
      return;
    }
    editSeekRef.current = region.start;
    withCtx((ctx, buf) => deleteRange(ctx, buf, region.start, region.end));
  }
  removeSelRef.current = removeSel;

  function deleteForward(ms: number) {
    const at = editWsRef.current?.getCurrentTime() ?? editAt;
    editSeekRef.current = at;
    withCtx((ctx, buf) => deleteRange(ctx, buf, at, at + ms / 1000));
  }

  function onDeleteKey() {
    const region = editRegionRef.current;
    if (region && region.end - region.start >= 0.02) {
      removeSel();
      return;
    }
    deleteForward(100);
  }
  deleteKeyRef.current = onDeleteKey;

  function changeGain(pct: number) {
    const gain = 1 + pct / 100;
    const region = editRegionRef.current;
    withCtx((ctx, buf) => {
      if (region && region.end - region.start >= 0.02) {
        return scaleGain(ctx, buf, gain, region.start, region.end);
      }
      return scaleGain(ctx, buf, gain);
    });
  }

  function scale(ratio: number) {
    const region = editRegionRef.current;
    withCtx((ctx, buf) => {
      if (region && region.end - region.start >= 0.02) {
        editSeekRef.current = region.start;
        return stretchRange(ctx, buf, ratio, region.start, region.end);
      }
      return stretchDuration(ctx, buf, ratio);
    });
  }

  function autoAlign() {
    // 用当前日文PCM检测开口，避免旧起点缓存绕过孤立微弱凸起规则。
    const bounds = jpBuffer ? speechBounds(mixMono(jpBuffer), jpBuffer.sampleRate) : null;
    const start = bounds && jpBuffer ? bounds.start / jpBuffer.sampleRate : jp.start;
    const dur = jp.dur;
    if (start == null || start < 0) {
      setError("这句没有日文起，无法自动对齐");
      return;
    }
    if (dur == null || dur <= 0) {
      setError("这句没有日文时长，无法自动对齐");
      return;
    }
    withCtx((ctx, buf) => alignToJpSlot(ctx, buf, { start, dur }));
  }

  function advancedAutoAlign() {
    if (!gapAlignment) return;
    withCtx((ctx, buf) => bufferFromMono(
      ctx, alignSpeechGaps(gapAlignment.reference, gapAlignment.edited), buf.sampleRate,
    ));
  }

  function autoAdjust() {
    if (!jpBuffer || source === "jp") return;
    const reference = { samples: mixMono(jpBuffer), sampleRate: jpBuffer.sampleRate };
    const referencePartCount = internalSpeechParts(reference)?.parts.length ?? 1;
    const bounds = speechBounds(reference.samples, reference.sampleRate);
    jpWsRef.current?.pause();
    editWsRef.current?.pause();
    withCtx((ctx, buf) => {
      const edited = { samples: mixMono(buf), sampleRate: buf.sampleRate };
      // 与高级对齐按钮共用计划：中文两段时，日文即使三段也取最长停顿归两组。
      const plan = gapOnlyAlignmentPlan(reference, edited);
      const partCount = plan?.partCount ?? referencePartCount;
      // 两/三段无法匹配或装下时明确报错，不能退回整句对齐掩盖分段问题。
      const next = partCount > 1
        ? bufferFromMono(ctx, alignSpeechGaps(reference, edited), buf.sampleRate)
        : alignToJpSlot(ctx, buf, { start: bounds ? bounds.start / reference.sampleRate : jp.start ?? 0, dur: jp.dur ?? jpBuffer.duration });
      setAdjustmentNote(`已按${partCount === 3 ? "三段对话" : partCount === 2 ? "两端对话" : "单句"}自动对齐，可试听后确认。`);
      return next;
    });
  }

  async function save(lockNew = false) {
    if (!buffer || !audioLoaded || busy || processingRef.current) return;
    setBusy(readOnly || lockNew ? hasAudioChanges ? "保存并锁定中…" : "锁定中…" : "保存并计算净语速中…");
    setError("");
    const confirmLock = onConfirmLock ?? (lockNew ? async (id: string | null) => {
      if (id === null && source === "cn") {
        const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/original-review`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviewState: "locked" }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return true;
      }
      if (!id) throw new Error("缺少当前音频编号");
      return Boolean(await patchTtsWithConfirmation(stem, id, {
        reviewState: "locked", confirmSubtitleChanges: true,
      }));
    } : undefined);
    try {
      if (readOnly && (!allowAutoAdjust || buffer === originalBuffer)) {
        if (onConfirmLock && await onConfirmLock(sourceId ?? null)) onSaved();
        return;
      }
      if (source === "jp") return;
      // 试听、选区、移动光标不算修改；全部撤销也会回到原缓冲，直接锁原记录。
      // 任何锁定入口未修改时均锁当前记录；普通“保存为新版本”仍另存。
      if (confirmLock && buffer === originalBuffer) {
        if (await confirmLock(source === "cn" ? null : sourceId!)) onSaved();
        return;
      }
      if (confirmLock && savedBufferRef.current?.buffer === buffer) {
        if (await confirmLock(savedBufferRef.current.id)) onSaved();
        return;
      }
      const wav = encodeWavPcm16(buffer);
      const saveUrl =
        source === "cn"
          ? `/api/lines/${encodeURIComponent(stem)}/tts/edit-cn`
          : `/api/lines/${encodeURIComponent(stem)}/tts/${sourceId}/edit`;
      const response = await fetch(saveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wavBase64: wavToBase64(wav) }),
      });
      const result = (await response.json()) as { error?: string; id?: string; netStatus?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (!result.id) throw new Error("保存成功但未返回音频编号");
      savedBufferRef.current = { buffer, id: String(result.id) };
      window.dispatchEvent(new CustomEvent("ff7-audio-edit-saved", { detail: { stem, id: String(result.id), netStatus: result.netStatus } }));
      if (confirmLock && !await confirmLock(String(result.id))) return;
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  const jpLen = jp.dur ?? jp.speech;
  return (
    <div ref={readOnlyRoot} role="dialog" aria-modal="true" aria-label={readOnly ? "核对音频节奏并锁定" : "音频编辑"} className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div className="h-[100dvh] max-h-[100dvh] w-full overflow-y-auto bg-zinc-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:h-auto sm:max-h-[min(100vh-2rem,calc(92vh*1.15))] sm:max-w-[calc(56rem*1.15)] sm:rounded-xl sm:border sm:border-zinc-700 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-medium text-zinc-100">
            {readOnly ? `核对音频节奏 · ${sourceId ? "#" + sourceId : source === "jp" ? "日文原声" : "原中文"}` : <>{onConfirmLock ? "核对音频并锁定 · " : ""}{source === "cn" ? "修改中文原声" : `修改 #${sourceId}`}</>}
          </h3>
          <button type="button" disabled={Boolean(busy)} onClick={onClose} className="inline-flex min-h-11 items-center px-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
            关闭
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {readOnly ? allowAutoAdjust ? "对照试听，可自动调整节奏。调整后确认会保存为新音频并锁定；取消不保存。" : "对照同一时间刻度试听日文和所选音频。确认后仅锁定当前版本，音频及字幕保持原样。" : <>
          上面日文只读（选区黄），下面待改（选区蓝）。点波形定位插入光标。点「插入日文选区」插日文；手机点右侧 ▾，电脑把鼠标停在按钮上，可看到其它选项。
          {onConfirmLock ? "未修改直接锁定；修改后确认会保存为新音频并锁定。" : "保存生成新待选。"}</>}
          缩放算法：G · Rubber Band R3 短窗。
          {jpLen != null ? ` 日文长 ${jpLen.toFixed(2)}s。` : ""}
        </p>
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
            <span>日文原声（只读）</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-zinc-500">光标 {jpAt.toFixed(2)}s</span>
              <button
                type="button"
                onClick={() => jpWsRef.current?.playPause()}
                className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700"
              >
                播日文
              </button>
            </span>
          </div>
          {jpBuffer ? (
            <div className="overflow-hidden rounded border border-zinc-800 bg-zinc-950">
              <div className="px-2 pt-1">
                <TimeRuler duration={scaleMax} />
              </div>
              <div ref={jpHostRef} className="bg-zinc-900 px-2 py-2" style={{ width: `${jpPct}%` }} />
            </div>
          ) : (
            <p className="rounded border border-zinc-800 px-2 py-3 text-xs text-zinc-600">{readOnly ? autoPlayPending ? "正在加载日文波形…" : "日文音频不可用" : "没有日文配音，无法从上面取片段。"}</p>
          )}
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
            <span>{readOnly ? adjustmentNote ? "调整后音频" : "所选音频" : source === "cn" ? "中文原声（可改）" : "待改音频"}</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-zinc-500">光标 {editAt.toFixed(2)}s</span>
              <button
                type="button"
                onClick={() => {
                  if (source === "tts" && sourceId) void reportTtsPlayback(stem, sourceId);
                  void editWsRef.current?.playPause();
                }}
                className="inline-flex min-h-11 items-center rounded bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700"
              >
                {readOnly ? "播所选音频" : "播编辑"}
              </button>
            </span>
          </div>
          <div className="overflow-hidden rounded border border-zinc-800 bg-zinc-950">
            <div className="px-2 pt-1">
              <TimeRuler duration={scaleMax} />
            </div>
            <div ref={editHostRef} className="bg-zinc-900 px-2 py-2" style={{ width: `${editPct}%` }} />
          </div>
        </div>
        {readOnly && !buffer && <p role="status" className="mt-2 text-xs text-zinc-400">正在加载所选音频波形…</p>}
        {!readOnly && <div className="audio-edit-toolbar mt-3 flex flex-wrap items-center gap-2">
          <ConfigProvider
            button={{ autoInsertSpace: false }}
            theme={{
              algorithm: theme.darkAlgorithm,
              token: {
                colorPrimary: "#b45309",
                borderRadius: 6,
                fontSize: 14,
                controlHeight: 32,
              },
              components: {
                Button: { controlHeight: 32, paddingInline: 12, fontSize: 14 },
                Menu: { itemHeight: 32, fontSize: 14, itemPaddingInline: 12 },
              },
            }}
          >
            <HoverDrop items={[{ key: "edit", label: "插入成品选区" }]} onItem={() => insertFrom("edit")}>
              <Button type="primary" onClick={() => insertFrom("jp")}>
                插入日文选区
              </Button>
            </HoverDrop>
            <HoverDrop
              items={[
                { key: "50", label: "50ms" },
                { key: "100", label: "100ms" },
                { key: "500", label: "500ms" },
                { key: "1000", label: "1000ms" },
              ]}
              onItem={(key) => insertGap(Number(key))}
            >
              <Button onClick={() => insertGap(200)}>插入200ms空白</Button>
            </HoverDrop>
            <Button onClick={removeSel}>删除</Button>
            <HoverDrop
              menuOnly
              items={[
                { key: "30", label: "+30%" },
                { key: "20", label: "+20%" },
                { key: "10", label: "+10%" },
                { key: "-10", label: "-10%" },
                { key: "-20", label: "-20%" },
                { key: "-30", label: "-30%" },
              ]}
              onItem={(key) => changeGain(Number(key))}
            >
              <Button>音量</Button>
            </HoverDrop>
            <HoverDrop
              items={[
                { key: "10", label: "10%" },
                { key: "15", label: "15%" },
                { key: "20", label: "20%" },
                { key: "40", label: "40%" },
                { key: "80", label: "80%" },
                { key: "120", label: "120%" },
              ]}
              onItem={(key) => scale(1 + Number(key) / 100)}
            >
              <Button onClick={() => scale(1.05)}>拉长 5%</Button>
            </HoverDrop>
            <HoverDrop
              items={[
                { key: "10", label: "加速 10%" },
                { key: "15", label: "加速 15%" },
                { key: "20", label: "加速 20%" },
                { key: "40", label: "加速 40%" },
                { key: "80", label: "加速 80%" },
                { key: "120", label: "加速 120%" },
              ]}
              onItem={(key) => {
                const percent = Number(key);
                // 所有缩短档位统一按加速倍率计算：输出时长=输入时长÷(1+百分比)。
                // 加速120%就是时长÷2.2；小档位也用倒数，不再按时长直接相减。
                // 有选区仅处理选区，无选区处理整段，只做一次Rubber Band R3变速，不重复叠加20%。
                scale(1 / (1 + percent / 100));
              }}
            >
              <Button title="时长÷1.05（按加速倍率缩短）" onClick={() => scale(1 / 1.05)}>缩短 5%</Button>
            </HoverDrop>
            <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: "#0369a1" } }}>
              {gapAlignment ? (
                <HoverDrop items={[{ key: "ordinary", label: "自动对齐" }]} onItem={autoAlign}>
                  <Button type="primary" title={gapAlignment.partCount === 3 ? "三段对话工作流：首段贴头、中段中心对齐日文中段、末段贴尾，只调整留白" : "两端对齐：取日文最长停顿分两组，首段贴头、末段贴尾，只调整留白"} onClick={advancedAutoAlign}>
                    高级自动对齐
                  </Button>
                </HoverDrop>
              ) : (
                <Button type="primary" onClick={autoAlign}>
                  自动对齐
                </Button>
              )}
            </ConfigProvider>
            <Button onClick={undo}>撤销</Button>
            <span className="ml-auto inline-flex gap-2">
              <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: "#0369a1" } }}>
                {!onConfirmLock && <Button disabled={!buffer || !audioLoaded || Boolean(busy)} onClick={() => void save(true)}>
                  {hasAudioChanges ? "保存并锁定" : "锁定"}
                </Button>}
                <Button type="primary" disabled={!buffer || !audioLoaded || Boolean(busy)} onClick={() => void save()}>
                  {busy || (onConfirmLock ? "确认锁定" : "保存为新版本")}
                </Button>
              </ConfigProvider>
            </span>
          </ConfigProvider>
        </div>}
        {readOnly && onConfirmLock && <div className="mt-4 flex justify-end gap-2">
          {allowAutoAdjust && <button type="button" disabled={!buffer || !jpBuffer || source === "jp" || Boolean(busy) || Boolean(adjustmentNote)} onClick={autoAdjust} className="mr-auto min-h-12 rounded border border-sky-800 px-3 text-sky-300 disabled:opacity-40">{adjustmentNote ? "已自动调整" : "自动调整"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={onClose} className="min-h-12 rounded border border-zinc-700 px-4">取消</button>
          <button type="button" disabled={!buffer || !jpBuffer || Boolean(busy)} onClick={() => void save()} className="min-h-12 rounded bg-sky-700 px-4 disabled:opacity-40">{busy || "确认锁定"}</button>
        </div>}
        {readOnly && adjustmentNote && <p role="status" className="mt-2 text-xs text-sky-300">{adjustmentNote}</p>}
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}
