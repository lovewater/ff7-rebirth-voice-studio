"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useAbnormalNavigation } from "@/components/abnormal-navigation";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AudioPlayButton } from "@/components/audio-play-button";
import { reportTtsPlayback } from "@/lib/tts-play-count";
import { patchTtsWithConfirmation } from "@/lib/tts-lock-client";
import type { TtsReviewState } from "@/lib/tts-review-state";
import { BeatRatio } from "@/app/lines/beat-count";
import { timingMarks, type Timing as AudioTiming, type Mark } from "@/lib/timing";
import { LINE_PAGE_SIZE } from "@/lib/line-pagination";
import { ConditionalLockDialog, type ConditionalSource } from "./conditional-lock-dialog";

export type ReviewLine = {
  stem: string; region: string | null; region_name: string; name_zh: string;
  text_jp: string | null; text_zh: string | null; kind: string | null; dialogue_mode: string | null; subtitle_italic: boolean;
  jp_start_s: number | null; jp_end_s: number | null; jp_dur_s: number | null; jp_speech_s: number | null;
  cn_start_s: number | null; cn_end_s: number | null; cn_dur_s: number | null; cn_speech_s: number | null;
};
export type ReviewVersion = {
  id: string; parent_tts_id: string | null; review_state: TtsReviewState; voice_gpu_key: string;
  subtitle_text: string | null; tts_text: string;
  start_s: number | null; end_s: number | null; dur_s: number | null; speech_s: number | null;
};
const AudioEditDialog = dynamic(() => import("@/app/line/[stem]/audio-edit-dialog").then(m => m.AudioEditDialog), { ssr: false });

const action = "min-h-12 rounded-md border border-zinc-700 px-3 text-base disabled:opacity-40";
const playClass = "inline-flex min-h-12 min-w-16 items-center justify-center rounded-md px-3 text-base";
const seconds = (n: number | null) => n == null ? '—' : n.toFixed(2);
const markColor = (mark: Mark) => mark === 'err' ? 'text-red-400' : mark === 'warn' ? 'text-amber-300' : 'text-zinc-400';

/** 字幕默认常显，字号与指标一致并排放在名称右侧；结果编号放名称下方。
 * 数值按实测差值着色；锁定仅表示人工采用，不抹去需要知晓的测量差异。
 */
function ReviewAudio({ title, id, text, beatText, language, timing, reference, jpText, scene, source, locked, abnormal, modified, children }: {
  title: string; id?: string; text: string | null; beatText?: string | null; language?: string;
  timing: AudioTiming; reference: AudioTiming; jpText: string | null; scene: boolean;
  source?: boolean; locked?: boolean; abnormal?: boolean; modified?: boolean; children: ReactNode;
}) {
  const marks = timingMarks(reference, timing, undefined, undefined, undefined, source || !scene);
  const items = [['起', timing.start, marks.start], ['止', timing.end, marks.end], ['说', timing.speech, marks.speech], ['长', timing.dur, marks.dur]] as const;
  const deltas = ([['长', timing.dur, reference.dur], ['起', timing.start, reference.start], ['止', timing.end, reference.end], ['说', timing.speech, reference.speech]] as const)
    .flatMap(([label, value, base]) => value == null || base == null ? [] : [{ label, ms: Math.round((value - base) * 1000) }]);
  const worst = deltas.reduce<{ label: string; ms: number } | null>((result, next) => !result || Math.abs(next.ms) > Math.abs(result.ms) ? next : result, null);
  const mark = Object.values(marks).includes('err') ? 'err' : Object.values(marks).includes('warn') ? 'warn' : 'ok';
  const difference = source ? '日文参考' : worst ? `${mark === 'err' ? '异常' : mark === 'warn' ? '警告' : '正常'} ${worst.label}${worst.ms > 0 ? '+' : ''}${worst.ms}ms` : '差值 —';
  return <section className={`px-3 py-2.5 ${locked ? 'bg-emerald-950/25' : abnormal ? 'bg-red-950/20' : ''}`}>
    <div className="flex items-start gap-2">
      <div className="w-[5.25rem] shrink-0 leading-4">
        <h2 className="text-xs font-medium text-zinc-200">{title}</h2>
        {id && <p className="font-mono text-[10px] text-zinc-600">#{id}</p>}
        {locked && <span className="text-[10px] text-emerald-300">已锁定</span>}{abnormal && <span className="text-[10px] text-red-400">人工异常</span>}
      </div>
      <p lang={language} className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 ${modified ? 'text-amber-300' : 'text-zinc-300'}`}>{text || '（无字幕）'}</p>
    </div>
    <div className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-xs leading-5">
      {items.map(([label, value, mark]) => <span key={label} className={markColor(mark)} title={`${label}：${value == null ? '无数据' : value + '秒'}`}>{label} {seconds(value)}</span>)}
      {!source && scene ? <BeatRatio jp={jpText} cn={beatText ?? text} enabled compact /> : <span className="text-zinc-500">比 —</span>}
    </div>
    <div className="mt-1.5 flex flex-wrap items-center gap-2">{children}
      <span className={`ml-auto font-mono text-xs ${markColor(mark)}`} title={deltas.map(d => `${d.label}差 ${d.ms > 0 ? '+' : ''}${d.ms}ms`).join('；')}>{difference}</span>
    </div>
  </section>;
}

export function MobileReview({ line, versions, initialQueue, context, abnormalMode = false }: {
  line: ReviewLine; versions: ReviewVersion[]; initialQueue: string[]; context: string; abnormalMode?: boolean;
}) {
  const router = useRouter();
  const abnormalNav = useAbnormalNavigation();
  const [waveSource, setWaveSource] = useState<ConditionalSource | null>(null);
  const [queue, setQueue] = useState(initialQueue);
  const [heardId, setHeardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conditionalSource, setConditionalSource] = useState<ConditionalSource | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TtsReviewState>>({});
  const state = (v: ReviewVersion) => overrides[v.id] ?? v.review_state;
  const locked = versions.find(v => state(v) === 'locked');
  const generated = versions.filter(v => v.parent_tts_id == null && !['jp-lock','cn-original'].includes(v.voice_gpu_key)).sort((a,b) => Number(b.id) - Number(a.id));
  const jp = versions.find(v => v.voice_gpu_key === 'jp-lock' && state(v) === 'locked') ?? versions.find(v => v.voice_gpu_key === 'jp-lock');
  const cn = versions.find(v => v.voice_gpu_key === 'cn-original' && state(v) === 'locked') ?? versions.find(v => v.voice_gpu_key === 'cn-original');
  // 用户确认的标记规则：先当前锁定稿，再最近试听的中文结果，最后最新结果。
  const target = locked ?? versions.find(v => state(v) === 'abnormal') ?? versions.find(v => v.id === heardId) ?? generated[0] ?? cn;
  const abnormal = target ? state(target) === 'abnormal' : false;
  const reference = { start: line.jp_start_s, end: line.jp_end_s, dur: line.jp_dur_s, speech: line.jp_speech_s };
  const scene = ['对话', 'talk'].includes(line.kind ?? '') && line.dialogue_mode === 'scene' && !line.subtitle_italic;
  const index = queue.indexOf(line.stem);
  const page = index >= 0 ? Math.floor(index / LINE_PAGE_SIZE) + 1 : Math.max(1, Number(new URLSearchParams(context).get('page')) || 1);
  const position = index >= 0 ? index % LINE_PAGE_SIZE + 1 : null;
  const params = new URLSearchParams(context);
  const session = params.get('reviewSession');
  const storageKey = !abnormalMode && session && /^[\w-]{1,80}$/.test(session) ? `ff7-mobile-review:${session}` : null;

  useEffect(() => {
    // 同一次进入审核保持列表快照；锁定后从“警告”筛选消失，也不能跳条/改变页码。
    if (!storageKey) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步既有会话快照；异常列表不使用快照。
      if (Array.isArray(saved) && saved.every(s => typeof s === 'string' && /^[\w.\-]+$/.test(s)) && saved.includes(line.stem)) setQueue(saved);
      else sessionStorage.setItem(storageKey, JSON.stringify(initialQueue));
    } catch { /* 存储禁用时仍按服务端列表继续审核 */ }
  }, [storageKey, line.stem, initialQueue]);

  function href(stem: string, nextIndex: number) {
    const search = new URLSearchParams(context);
    search.set('page', String(Math.floor(nextIndex / LINE_PAGE_SIZE) + 1));
    return `/review/${encodeURIComponent(stem)}?${search}`;
  }
  const back = new URLSearchParams(context); back.delete('reviewSession'); back.set('page', String(page));
  function notify(advance = false) {
    window.dispatchEvent(new Event('ff7-tts-changed'));
    try { const channel = new BroadcastChannel('ff7-tts-changed'); channel.postMessage({ stem: line.stem }); channel.close(); } catch {}
    if (abnormalMode) { abnormalNav?.refresh(); return; }
    if (advance && index >= 0 && index < queue.length - 1) router.push(href(queue[index + 1], index + 1));
    else router.refresh();
  }
  async function update(id: string, reviewState: TtsReviewState) {
    const result = await patchTtsWithConfirmation(line.stem, id, { reviewState, ...(reviewState === "locked" ? { preserveSubtitle: true } : {}) });
    if (!result) return false;
    setOverrides(old => {
      const next = { ...old };
      if (reviewState !== 'candidate') for (const v of versions) if ((old[v.id] ?? v.review_state) !== 'candidate') next[v.id] = 'candidate';
      next[id] = reviewState; return next;
    });
    notify(reviewState === 'locked'); return true;
  }
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  async function original(kind: 'jp' | 'cn', reviewState: 'locked' | 'abnormal') {
    const existing = kind === 'jp' ? jp : cn;
    if (existing) return update(existing.id, reviewState);
    const response = await fetch(`/api/lines/${line.stem}/${kind === 'jp' ? 'tts/lock-jp' : 'original-review'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewState }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    notify(reviewState === 'locked');
    return true;
  }
  function lockButton(v: ReviewVersion | undefined, kind?: 'jp' | 'cn') {
    const isLocked = v && state(v) === 'locked';
    const source: ConditionalSource = {
      source: v ? 'tts' : kind!, id: v?.id,
      title: kind === 'jp' ? '日文原声' : kind === 'cn' ? '原中文' : `音频 #${v?.id}`,
      duration: kind === 'jp' ? line.jp_dur_s : kind === 'cn' ? line.cn_dur_s : v?.dur_s ?? null,
    };
    return <><button type="button" disabled={busy} onClick={() => { if (isLocked) void run(() => update(v.id, "candidate")); else setWaveSource(source); }}
      className={`${action} ${isLocked ? 'border-emerald-600 bg-emerald-950 text-emerald-200' : 'bg-zinc-900 text-zinc-200'}`}>{isLocked ? '解锁' : '锁定'}</button>
      {!abnormalMode && <button type="button" disabled={busy} onClick={() => setConditionalSource(source)} className={`${action} bg-zinc-900 text-zinc-200`}>条件锁定</button>}</>;
  }
  function conditionalLock(step: number) {
    const source = conditionalSource;
    if (!source || busy) return;
    // 点击档位才发请求；打开/关闭弹窗均不预先生成音频或切换锁。
    setConditionalSource(null);
    void run(async () => {
      const response = await fetch(`/api/lines/${line.stem}/conditional-lock`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: source.source, id: source.id, step }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '缩放并锁定失败');
      notify(true);
    });
  }
  return <main data-mobile-review data-abnormal-review={abnormalMode ? "" : undefined} className="mx-auto flex h-dvh max-w-2xl flex-col bg-zinc-950">
    <header className="shrink-0 border-b border-zinc-800 px-3 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-3"><p className="text-sm text-sky-300">{line.region_name}</p><Link href={`/lines?${back}`} className="shrink-0 py-1 text-xs text-zinc-400">返回列表</Link></div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-sm"><span>{line.name_zh}<span className="ml-2 text-zinc-500">{({ '对话': '对话', talk: '对话', '旁白': '旁白', narrate: '旁白', '战斗': '战斗', battle: '战斗', npc: 'NPC', NPC: 'NPC', cut: '过场', pending: '待处理' } as Record<string,string>)[line.kind ?? ''] ?? line.kind ?? '未分类'}{['对话','talk'].includes(line.kind ?? '') ? <> - <span className={line.dialogue_mode === 'scene' ? 'inline-flex items-center rounded border border-emerald-600 bg-emerald-950 px-1.5 py-0.5 font-semibold text-emerald-300' : undefined}>{({ scene: '场景演出', field: '普通对话', mixed: '兼有演出', unknown: '待判定' } as Record<string,string>)[line.dialogue_mode ?? ''] ?? '待判定'}</span></> : null}</span></span><span className="text-zinc-400">{abnormalMode ? `第 ${abnormalNav?.position ?? "—"} 条 / 共 ${abnormalNav?.total ?? 0} 条` : <>第 {page} 页 · 第 {position ?? "—"} 条{queue.length > 0 ? ` / 共 ${queue.length} 条` : ""}</>}</span></div>
      <p className="mt-1 truncate font-mono text-[10px] text-zinc-600">{line.stem}</p>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" key={line.stem}>
      {/* 场景演出用绿色外框及分隔线强调；只改视觉，不改变锁定/异常和指标规则。 */}
      <article className={`divide-y rounded-xl border bg-zinc-900/40 ${line.dialogue_mode === 'scene' ? 'divide-emerald-800 border-emerald-500' : 'divide-zinc-800 border-zinc-800'}${line.subtitle_italic ? ' italic' : ''}`}>
        <ReviewAudio title="日文原声" id={jp?.id} text={line.text_jp} language="ja" timing={reference} reference={reference} jpText={line.text_jp} scene={scene} source locked={jp && state(jp) === 'locked'} abnormal={jp && state(jp) === 'abnormal'}>
          <AudioPlayButton src={`/api/audio/jp/${line.stem}`} className={playClass} />{lockButton(jp, 'jp')}
        </ReviewAudio>
        <ReviewAudio title="原中文" id={cn?.id} text={line.text_zh} timing={{ start: line.cn_start_s, end: line.cn_end_s, dur: line.cn_dur_s, speech: line.cn_speech_s }} reference={reference} jpText={line.text_jp} scene={scene} locked={cn && state(cn) === 'locked'} abnormal={cn && state(cn) === 'abnormal'}>
          <AudioPlayButton src={`/api/audio/cn/${line.stem}`} className={playClass} onPlayRequest={() => { if (cn) { setHeardId(cn.id); void reportTtsPlayback(line.stem, cn.id); } }} />{lockButton(cn, 'cn')}
        </ReviewAudio>
        {generated.map((v, i) => <ReviewAudio key={v.id} title={`中文结果 ${i + 1}`} id={v.id} text={v.subtitle_text || line.text_zh || v.tts_text} beatText={v.tts_text} modified={!!v.subtitle_text?.trim() && v.subtitle_text.replace(/\\n/g, '\n').trim() !== (line.text_zh ?? '').replace(/\\n/g, '\n').trim()}
          timing={{ start: v.start_s, end: v.end_s, dur: v.dur_s, speech: v.speech_s }} reference={reference} jpText={line.text_jp} scene={scene} locked={state(v) === 'locked'} abnormal={state(v) === 'abnormal'}>
          <AudioPlayButton src={`/api/lines/${line.stem}/tts/${v.id}/audio`} accent className={playClass} onPlayRequest={() => { setHeardId(v.id); void reportTtsPlayback(line.stem, v.id); }} />{lockButton(v)}
        </ReviewAudio>)}
        {generated.length === 0 && <p className="p-4 text-sm text-zinc-500">暂无生成的中文结果</p>}
      </article>
      <p className="mt-3 text-center text-xs text-zinc-500">标记对象：{target ? `${target.voice_gpu_key === 'jp-lock' ? '日文原声' : target.voice_gpu_key === 'cn-original' ? '原中文' : '中文结果'} #${target.id}` : '原中文'}</p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-950 p-3 text-sm text-red-200">{error}</p>}
    </div>
    <footer className={`grid shrink-0 grid-cols-3 ${abnormalMode ? "" : "md:grid-cols-2"} border-t border-zinc-700 bg-zinc-950 pb-[env(safe-area-inset-bottom)]`}>
      <button type="button" disabled={busy || (abnormalMode ? !abnormalNav?.previousHref : index <= 0)} className="min-h-14 border-r border-zinc-800 text-base disabled:text-zinc-700" onClick={() => abnormalMode ? abnormalNav?.previousHref && router.replace(abnormalNav.previousHref) : router.push(href(queue[index - 1], index - 1))}>上一条</button>
      <button type="button" disabled={busy} className={`min-h-14 border-r border-zinc-800 text-base text-red-400 disabled:opacity-40 ${abnormalMode ? "" : "md:hidden"}`}
        onClick={() => void run(() => target ? update(target.id, abnormal ? 'candidate' : 'abnormal') : original('cn', 'abnormal'))}>{busy ? '保存中…' : abnormal ? '取消异常' : '标异常'}</button>
      <button type="button" disabled={busy || (abnormalMode ? !abnormalNav?.nextHref : index < 0 || index >= queue.length - 1)} className="min-h-14 text-base disabled:text-zinc-700" onClick={() => abnormalMode ? abnormalNav?.nextHref && router.replace(abnormalNav.nextHref) : router.push(href(queue[index + 1], index + 1))}>下一条</button>
    </footer>
    {waveSource && <AudioEditDialog key={`${waveSource.source}-${waveSource.id ?? "original"}`} stem={line.stem}
      source={waveSource.source} sourceId={waveSource.id} jp={reference} readOnly allowAutoAdjust autoPlayOnOpen
      onClose={() => setWaveSource(null)}
      onConfirmLock={async (id) => Boolean(id ? await update(id, "locked") : await original(waveSource.source === "jp" ? "jp" : "cn", "locked"))}
      onSaved={() => { setWaveSource(null); if (abnormalMode) setTimeout(() => abnormalNav?.refresh(), 0); }} />}
    {conditionalSource && <ConditionalLockDialog stem={line.stem} source={conditionalSource} referenceDuration={line.jp_dur_s}
      italic={line.subtitle_italic} onClose={() => setConditionalSource(null)} onSelect={conditionalLock} />}
  </main>;
}
