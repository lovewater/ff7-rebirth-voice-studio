#!/usr/bin/env python3
"""Resumable scene rewrite -> LLM selection -> TTS pipeline. Never adopts audio.

Uses the website's shared prompt, same-performance context, beat calculator and
zero-shot TTS implementation. SQLite is a local execution journal, not game data.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
TTS_LOCK = ROOT / "work" / "rewrite-tts.lock"
POLICY = "literary-0.9-1.1-v1"
START = "GOLDE_QST_01_0200_0100_00_rez"
TERMINAL = {"done", "skipped", "failed", "uncertain"}


def now():
    return datetime.now(timezone.utc).isoformat()


def eligible(beat, low=0.7, high=1.3, min_chars=7):
    ratio = beat.get("normalizedRatio")
    return (beat["jp"]["characters"] > min_chars and ratio is not None
            and (ratio < low or ratio > high))


def acceptable(beat):
    ratio = beat.get("normalizedRatio")
    return (beat["jp"]["status"] == "ok" and ratio is not None
            and 0.9 - 1e-9 <= ratio <= 1.1 + 1e-9)


def ratio_in_band(beat):
    ratio = beat.get("normalizedRatio")
    return ratio is not None and 0.9 - 1e-9 <= ratio <= 1.1 + 1e-9


def line_count(text):
    return len([part for part in text.replace("\\n", "\n").split("\n") if part.strip()])


def punctuate_line_breaks(text, source):
    def pieces(value):
        return [part.strip() for part in value.splitlines() if part.strip()]
    lines = pieces(source)
    raw = text
    if len(lines) >= 2:
        compact = " ".join(text.split())
        if compact in (" ".join(lines), "".join(lines), " ".join(source.split())):
            raw = source
    parts = pieces(raw)
    if len(parts) < 2:
        return text.strip()
    out = []
    for index, line in enumerate(parts):
        if index == len(parts) - 1 or line[-1] in "。！？，、；：…,.!?;:" or line.endswith("]"):
            out.append(line)
        else:
            out.append(line + "。")
    return "".join(out)


class ApiError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class Api:
    def __init__(self, url):
        self.url = url.rstrip("/")

    def call(self, path, body=None, method=None, timeout=160):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        req = Request(self.url + path, data=data,
                      headers={"Content-Type": "application/json"},
                      method=method or ("GET" if body is None else "POST"))
        try:
            with urlopen(req, timeout=timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                message = json.loads(exc.read()).get("error", "request failed")
            except (ValueError, AttributeError):
                message = "request failed"
            raise ApiError(exc.code, message) from None

    def beats(self, pairs):
        return self.call("/api/beats", {"pairs": pairs})["results"]

    def path(self, stem, suffix):
        return f"/api/lines/{quote(stem, safe='')}/{suffix}"

    def policy(self):
        result = self.call(self.path(START, "rewrite"))
        if result.get("policy") != POLICY or not result.get("configured") or result.get("subtitleLayout") != "source-lines":
            raise RuntimeError("请先部署本次网站改动并配置自动修正服务；策略版本不匹配")
        if result.get("min") != 0.9 or result.get("max") != 1.1:
            raise RuntimeError("改写合格区间不匹配")
        return result


class Database:
    def __init__(self, dsn):
        self.dsn = dsn

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5,
                               options="-c statement_timeout=30000 -c lock_timeout=5000")

    def candidates(self, start, region="", regions=None):
        with self.connect() as conn:
            where = [
                "l.kind IN ('对话','talk')",
                "m.dialogue_mode='scene'",
                "NOT COALESCE(l.subtitle_italic,false)",
                "NOT COALESCE(m.skip_timing,false)",
                "COALESCE(l.text_jp,'')<>''",
                "COALESCE(l.text_zh,'')<>''",
                "NOT EXISTS (SELECT 1 FROM line_tts_versions t WHERE t.stem=l.stem AND t.review_state='locked')",
            ]
            args = []
            if regions:
                where.append("l.region = ANY(%s)")
                args.append(list(regions))
            elif region:
                where.append("l.region = %s")
                args.append(region)
            else:
                first = conn.execute("SELECT id FROM lines WHERE stem=%s", (start,)).fetchone()
                if not first:
                    raise RuntimeError(f"找不到起点 {start}")
                where.append("l.id >= %s")
                args.append(first["id"])
            return conn.execute(f"""
              SELECT l.id, l.stem, l.text_jp, l.text_zh
              FROM lines l JOIN line_meta m ON m.stem=l.stem
              WHERE {' AND '.join(where)}
              ORDER BY l.id
            """, args).fetchall()

    def current(self, stem):
        with self.connect() as conn:
            line = conn.execute("""
              SELECT l.id, l.stem, l.text_jp, l.text_zh, l.kind, l.subtitle_italic,
                     m.skip_timing, m.dialogue_mode,
                     EXISTS(SELECT 1 FROM line_tts_versions t WHERE t.stem=l.stem AND t.review_state='locked') AS locked
              FROM lines l JOIN line_meta m ON m.stem=l.stem WHERE l.stem=%s
            """, (stem,)).fetchone()
            versions = conn.execute("""
              SELECT id::text, status, review_state, heard_at, tts_text, subtitle_text,
                     audio_path, start_s, end_s, dur_s, speech_s
              FROM line_tts_versions WHERE stem=%s ORDER BY id
            """, (stem,)).fetchall()
        return line, versions

    def subtitle(self, stem, ids, text, tts_text, previous_text=None):
        # Protect user edits after the request was submitted. Never set review_state,
        # heard_at, skip_timing, or the official subtitle.
        with self.connect() as conn:
            versions = conn.execute("""
              SELECT id::text, review_state, heard_at, status, tts_text, subtitle_text
              FROM line_tts_versions WHERE stem=%s ORDER BY id FOR UPDATE
            """, (stem,)).fetchall()
            meta = conn.execute("SELECT skip_timing FROM line_meta WHERE stem=%s FOR UPDATE", (stem,)).fetchone()
            if (meta and meta["skip_timing"]) or any(v["review_state"] == "locked" for v in versions):
                return False
            for id_ in ids:
                target = next((v for v in versions if v["id"] == id_), None)
                if not target or target["review_state"] != "candidate" or target["heard_at"] is not None or target["status"] != "ready":
                    return False
                if target["tts_text"] != tts_text or target["subtitle_text"] not in (None, "", text, previous_text):
                    return False
            for id_ in ids:
                conn.execute("UPDATE line_tts_versions SET subtitle_text=%s WHERE stem=%s AND id=%s",
                             (text, stem, id_))
        return True


def still_eligible(line, job):
    return bool(line and not line["locked"] and not line["skip_timing"]
                and not line["subtitle_italic"] and line["dialogue_mode"] == "scene"
                and line["kind"] in ("对话", "talk")
                and line["text_jp"] == job["text_jp"] and line["text_zh"] == job["text_zh"])


class Journal:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL)")
        self.conn.commit()

    def meta(self, key, value=None):
        if value is not None:
            self.conn.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
            self.conn.commit()
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, job):
        job["updated_at"] = now()
        self.conn.execute("INSERT OR REPLACE INTO jobs VALUES (?,?)", (job["id"], json.dumps(job, ensure_ascii=False, default=str)))
        self.conn.commit()

    def jobs(self):
        return [json.loads(row[0]) for row in self.conn.execute("SELECT data FROM jobs ORDER BY id")]

    def report(self, label):
        jobs = self.jobs()
        done = [j for j in jobs if j["state"] == "done"]
        skipped = [j for j in jobs if j["state"] == "skipped"]
        failed = [j for j in jobs if j["state"] in ("failed", "uncertain")]
        active = [j for j in jobs if j["state"] not in TERMINAL]
        frontier = None
        for j in jobs:
            if j["state"] not in ("done", "skipped"):
                break
            frontier = j["stem"]
        latest = max(done, key=lambda j: j["updated_at"])["stem"] if done else None
        reading_review = len((self.meta("plan") or {}).get("reading_review", []))
        summary = {"planned": self.meta("plan") is not None, "reading_review": reading_review, "time": now(), "label": label, "total": len(jobs), "completed": len(done),
                   "remaining": len(jobs) - len(done) - len(skipped), "skipped_after_plan": len(skipped),
                   "failed_or_uncertain": len(failed), "pending_or_running": len(active),
                   "latest_completed": latest, "continuous_frontier": frontier,
                   "next_unfinished": next((j["stem"] for j in jobs if j["state"] not in ("done", "skipped")), None)}
        report = self.path.with_suffix(".progress.json")
        tmp = report.with_suffix(".tmp")
        tmp.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(report)
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return summary


def done_stems(paths):
    stems = set()
    for path in paths:
        if not path.exists():
            raise RuntimeError(f"找不到排除记录 {path}")
        conn = sqlite3.connect(path)
        try:
            for (data,) in conn.execute("SELECT data FROM jobs"):
                job = json.loads(data)
                if job.get("state") == "done":
                    stems.add(job["stem"])
        finally:
            conn.close()
    return stems


def plan(db, api, journal, start, region, bounds, exclude, regions=None, chapter=0):
    rows = db.candidates(start, region, regions)
    selected = []
    reading = []
    version = None
    for offset in range(0, len(rows), 100):
        group = rows[offset:offset + 100]
        results = api.beats([{"jp": row["text_jp"], "cn": row["text_zh"]} for row in group])
        if len(results) != len(group):
            raise RuntimeError("拍数返回数量不一致")
        for row, beat in zip(group, results):
            if version is not None and version != beat["version"]:
                raise RuntimeError("扫描中拍数规则改变，请重建计划")
            version = beat["version"]
            if row["stem"] in exclude or not eligible(beat, **bounds):
                continue
            # 读音两套词典不一致时，列表仍会给出偏离很大的比。只要比本身越界就改写。
            if beat["jp"]["status"] not in ("ok", "review_reading"):
                reading.append({**row, "beats": beat, "reason": "日文读音待核对，未自动改写"})
                continue
            selected.append({**row, "beats": beat, "state": "pending"})
        print(f"扫描 {min(offset+100,len(rows))}/{len(rows)}，待处理 {len(selected)}，读音待核对 {len(reading)}", flush=True)
    # Commit a complete frozen worklist only after the whole scan succeeds.
    journal.conn.execute("DELETE FROM jobs")
    journal.conn.commit()
    for row in selected:
        journal.save(row)
    journal.meta("plan", {"start": start, "region": region, "regions": list(regions or []),
                          "chapter": chapter, "bounds": bounds,
                          "beat_version": version, "policy": POLICY,
                          "scanned": len(rows), "reading_review": reading, "created_at": now()})
    journal.report("plan")


def rewrite(db, api, job, bounds):
    line, versions = db.current(job["stem"])
    if not still_eligible(line, job):
        return {"state": "skipped", "reason": "用户已审查或源文字/类型改变"}
    beat = api.beats([{"jp": line["text_jp"], "cn": line["text_zh"]}])[0]
    if beat["version"] != job["beats"]["version"]:
        raise RuntimeError("拍数规则已改变，停止该条，需重新扫描")
    reading_uncertain = beat["jp"]["status"] == "review_reading"
    if not eligible(beat, **bounds) or beat["jp"]["status"] not in ("ok", "review_reading"):
        return {"state": "skipped", "reason": "重新计数后不再满足筛选条件"}
    old_ids = [v["id"] for v in versions if v["status"] == "ready" and v["review_state"] == "candidate" and v["heard_at"] is None]
    candidates, errors = [], []

    def in_band(item):
        return ratio_in_band(item["beats"]) and line_count(item["text"]) == line_count(job["text_zh"])

    def usable_now():
        return [c for c in candidates if in_band(c) and (reading_uncertain or acceptable(c["beats"]))]

    def pull(start, count):
        for offset in range(count):
            closest = sorted(candidates, key=lambda c: abs(((c.get("beats") or {}).get("normalizedRatio") or 9) - 1))[:4]
            for attempt_try in range(4):
                try:
                    result = api.call(api.path(job["stem"], "rewrite"), {
                        "text": job["text_zh"], "attempt": start + offset,
                        "previous": [{"raw": c["raw"], "text": c["text"]} for c in closest],
                    })
                    if result.get("policy") != POLICY or result["beats"]["version"] != beat["version"]:
                        raise RuntimeError("改写服务或拍数版本改变")
                    candidates.append(result)
                    break
                except ApiError as exc:
                    if exc.status in (401, 403):
                        raise
                    if exc.status in (429, 503) and attempt_try < 3:
                        time.sleep(15 * (attempt_try + 1))
                        continue
                    if exc.status in (429, 503):
                        raise
                    errors.append(str(exc))
                    break

    pull(0, 5)
    retried = False
    if not usable_now():
        retried = True
        errors.append("首轮五个候选都不在 0.9–1.1，已再要五个")
        pull(5, 5)
    usable = usable_now()
    if not usable:
        return {"state": "failed", "reason": "十个候选里没有比落在 0.9–1.1 的" if retried else "五轮后无合格候选",
                "candidates": candidates, "errors": errors, "retried": retried}
    if reading_uncertain:
        best = None
        for item in usable:
            tts_text = punctuate_line_breaks(item["text"], job["text_zh"])
            spoken = api.beats([{"jp": job["text_jp"], "cn": tts_text}])[0]
            if not ratio_in_band(spoken) or spoken["version"] != beat["version"]:
                continue
            distance = abs(item["beats"]["normalizedRatio"] - 1) + abs(spoken["normalizedRatio"] - 1)
            if best is None or distance < best[0]:
                best = (distance, item, tts_text)
        if best is None:
            return {"state": "failed", "reason": "读音待核对，朗读文本的比仍不在 0.9–1.1", "candidates": candidates}
        _, item, tts_text = best
        chosen = {"selectedIndex": usable.index(item), "text": item["text"], "ttsText": tts_text,
                  "subtitleText": item["text"], "reason": "日文读音待核对，选用比落在正常区间内的候选"}
    else:
        try:
            chosen = api.call(api.path(job["stem"], "rewrite"), {
                "action": "select", "text": job["text_zh"], "candidates": [c["text"] for c in usable],
            })
        except ApiError as exc:
            if exc.status in (401, 403, 429, 503):
                raise
            return {"state": "failed", "reason": str(exc), "candidates": candidates, "errors": errors}
        if chosen.get("selectedIndex") is None:
            return {"state": "failed", "reason": "模型拒绝全部候选：" + chosen.get("reason", ""), "candidates": candidates}
    index = chosen["selectedIndex"]
    if not isinstance(index, int) or not 0 <= index < len(usable) or chosen.get("text") != usable[index]["text"]:
        raise RuntimeError("择优返回不在已验证的候选中")
    subtitle = chosen.get("subtitleText")
    if not isinstance(subtitle, str) or subtitle.replace("\n", "") != chosen["text"].replace("\n", ""):
        raise RuntimeError("字幕排版改变了原文字")
    checks = api.beats([{"jp": job["text_jp"], "cn": chosen[key]} for key in ("text", "ttsText")])
    def passes(item):
        return item["version"] == beat["version"] and (ratio_in_band(item) if reading_uncertain else acceptable(item))
    if any(not passes(item) for item in checks):
        raise RuntimeError("选中字幕或实际 TTS 文字复算不合格")
    return {"state": "selected", "selection": chosen, "candidates": candidates,
            "old_ids": old_ids, "errors": errors, "retried": retried}


def generate(api, job):
    # Two TTS servers. A slot is one in-flight clone; the website splits its three
    # takes across the two cards and keeps one inference on each card.
    # Never retry this POST automatically: a timed-out request may still write audio.
    TTS_LOCK.parent.mkdir(parents=True, exist_ok=True)
    slots = []
    for index in range(2):
        handle = (TTS_LOCK.parent / f"rewrite-tts-slot-{index}.lock").open("a+")
        slots.append(handle)
    chosen = None
    try:
        while chosen is None:
            for handle in slots:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                chosen = handle
                break
            if chosen is None:
                time.sleep(0.5)
        return api.call(api.path(job["stem"], "tts/clone"), {
            "ttsText": job["selection"]["ttsText"], "promptLang": "jp", "promptStem": job["stem"], "durationFactor": 1,
        }, timeout=1250)
    finally:
        if chosen is not None:
            fcntl.flock(chosen, fcntl.LOCK_UN)
        for handle in slots:
            handle.close()


def finish(db, api, job):
    ids = job["new_ids"]
    line, versions = db.current(job["stem"])
    if not still_eligible(line, job):
        return {"state": "skipped", "reason": "生成期间用户审查或修改原文，新音频保留，旧候选未删"}
    records = [v for v in versions if v["id"] in ids]
    if len(records) != len(ids) or any(v["status"] != "ready" or not v["audio_path"] for v in records):
        raise RuntimeError("TTS 结果缺失或尚未 ready")
    if any(v["tts_text"] != job["selection"]["ttsText"] for v in records):
        raise RuntimeError("TTS 返回文字与选中稿不一致")
    subtitle = job["selection"].get("subtitleText", job["selection"]["text"])
    if not db.subtitle(job["stem"], ids, subtitle, job["selection"]["ttsText"]):
        return {"state": "skipped", "reason": "候选已被试听/锁定/编辑，保留用户状态"}
    deleted, protected = list(job.get("deleted_ids", [])), []
    for id_ in job.get("old_ids", []):
        if id_ in ids or id_ in deleted:
            continue
        try:
            api.call(api.path(job["stem"], f"tts/{id_}?onlyUnreviewed=1"), method="DELETE")
            deleted.append(id_)
        except ApiError as exc:
            if exc.status == 404:
                deleted.append(id_)
            elif exc.status == 409:
                protected.append(id_)
            else:
                raise
    # Read back subtitles and audio state; no listening endpoint is ever called.
    _, fresh = db.current(job["stem"])
    records = [v for v in fresh if v["id"] in ids]
    if len(records) != len(ids) or any(v["subtitle_text"] != subtitle for v in records):
        raise RuntimeError("字幕回读不一致")
    return {"state": "done", "deleted_ids": deleted, "protected_ids": protected, "generated": records}


def run(db, api, journal, rewrite_workers, tts_workers, bounds):
    jobs = journal.jobs()
    # A crash during a read-only rewrite is safe to repeat. A crash while TTS
    # was submitted is ambiguous: require inspection, never silently resubmit.
    for job in jobs:
        if job["state"] == "rewriting":
            job["state"] = "pending"
            journal.save(job)
        elif job["state"] == "tts_submitted":
            job.update(state="uncertain", reason="TTS 请求中断，先检查 baseline_ids 之后的候选；不会自动重复生成")
            journal.save(job)
    completed = sum(j["state"] == "done" for j in jobs)
    next_report = (completed // 100 + 1) * 100
    last_status = time.monotonic()
    infrastructure_failures = 0
    stop_scheduling = False
    with ThreadPoolExecutor(max_workers=rewrite_workers) as rp, ThreadPoolExecutor(max_workers=tts_workers) as tp:
        running = {}
        while True:
            selected_count = sum(j["state"] == "selected" for j in jobs)
            rw_busy = sum(stage == "rewrite" for stage, _ in running.values())
            tt_busy = sum(stage != "rewrite" for stage, _ in running.values())
            for job in jobs:
                if stop_scheduling:
                    break
                if job["state"] in ("selected", "generated") and tt_busy < tts_workers:
                    if job["state"] == "selected":
                        line, versions = db.current(job["stem"])
                        if not still_eligible(line, job):
                            job.update(state="skipped", reason="提交 TTS 前用户已审查或原文改变")
                            journal.save(job)
                            continue
                        job.update(state="tts_submitted", baseline_ids=[v["id"] for v in versions], submitted_at=now())
                        journal.save(job)
                        running[tp.submit(generate, api, job.copy())] = ("tts", job)
                    else:
                        # Distinguish scheduled finalization from durable generated state.
                        job["state"] = "finishing"
                        running[tp.submit(finish, db, api, job.copy())] = ("finish", job)
                    tt_busy += 1
                elif job["state"] == "pending" and rw_busy < rewrite_workers and selected_count < rewrite_workers * 2:
                    job["state"] = "rewriting"
                    journal.save(job)
                    running[rp.submit(rewrite, db, api, job.copy(), bounds)] = ("rewrite", job)
                    rw_busy += 1
            if not running:
                break
            finished, _ = wait(running, timeout=15, return_when=FIRST_COMPLETED)
            for future in finished:
                stage, job = running.pop(future)
                try:
                    result = future.result()
                    infrastructure_failures = 0
                    if stage == "tts":
                        ids = [str(i) for i in result.get("ids", [])]
                        if not ids:
                            raise RuntimeError("TTS 返回没有记录 ID")
                        job.update(state="generated", new_ids=ids)
                    else:
                        job.update(result)
                except Exception as exc:
                    infrastructure_failures += 1
                    if infrastructure_failures >= 3:
                        stop_scheduling = True
                    # Keep generated state durable so a failed cleanup can resume
                    # without making more TTS. Pause this job for the current run.
                    job.update(state="uncertain" if stage == "tts" else "failed",
                               failed_stage=stage, reason=str(exc))
                journal.save(job)
                print(json.dumps({"line_id": job["id"], "stem": job["stem"], "state": job["state"],
                                  "new_ids": job.get("new_ids", []), "reason": job.get("reason")}, ensure_ascii=False), flush=True)
                completed = sum(j["state"] == "done" for j in jobs)
                if completed >= next_report:
                    journal.report(f"completed_{next_report}")
                    next_report += 100
            if time.monotonic() - last_status >= 60:
                journal.report("heartbeat")
                last_status = time.monotonic()
    summary = journal.report("finished")
    return 2 if summary["remaining"] or summary["reading_review"] else 0


def chapter_regions(chapter):
    worker = str(Path(__file__).resolve().parent)
    if worker not in sys.path:
        sys.path.insert(0, worker)
    from build_mod import chapter_map
    groups, _extra = chapter_map()
    found = groups.get(chapter)
    if not found:
        raise RuntimeError(f"没有第{chapter}章")
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=START)
    ap.add_argument("--url", default="http://127.0.0.1:8765")
    ap.add_argument("--journal", type=Path, default=ROOT / "work/rewrite-scene-golde.sqlite3")
    ap.add_argument("--execute", action="store_true", help="执行；默认只扫描列出工作清单")
    ap.add_argument("--status", action="store_true", help="离线查看已有进度")
    ap.add_argument("--region", default="", help="只处理这个地区；设置后不再从起点一直扫到表尾")
    ap.add_argument("--chapter", type=int, default=0, help="处理这一章里的全部地区，含章内地图")
    ap.add_argument("--low", type=float, default=0.7, help="比低于此值才进入改写")
    ap.add_argument("--high", type=float, default=1.3, help="比高于此值才进入改写")
    ap.add_argument("--min-jp-chars", type=int, default=7, help="日文正文字数必须大于此值")
    ap.add_argument("--rewrite-workers", type=int, default=2)
    ap.add_argument("--tts-workers", type=int, default=1, help="每个 clone 请求内部已并行生成三条")
    ap.add_argument("--retry-failed", action="store_true", help="重试已知失败；绝不重试 uncertain TTS")
    ap.add_argument("--exclude-journal", action="append", default=[], type=Path,
                    help="这些记录里已经完成的句子不再重做")
    args = ap.parse_args()
    if not 1 <= args.rewrite_workers <= 4 or not 1 <= args.tts_workers <= 2:
        ap.error("rewrite-workers 1–4；tts-workers 1–2")
    args.journal.parent.mkdir(parents=True, exist_ok=True)
    # Separate status process can read SQLite without acquiring the execution lock.
    if args.status:
        if not args.journal.exists():
            ap.error("还没有执行记录")
        Journal(args.journal).report("status")
        return 0
    with args.journal.with_suffix(".lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("同一工作清单已有脚本运行") from None
        journal = Journal(args.journal)
        db = Database(os.environ.get("DATABASE_URL", ""))
        api = Api(args.url)
        if args.execute:
            api.policy()  # No plan writes/mutations if an older server is running.
        if args.chapter and args.region:
            ap.error("--chapter 和 --region 只能用一个")
        if args.chapter and not 1 <= args.chapter <= 14:
            ap.error("--chapter 取 1 到 14")
        regions = chapter_regions(args.chapter) if args.chapter else None
        bounds = {"low": args.low, "high": args.high, "min_chars": args.min_jp_chars}
        saved = journal.meta("plan")
        if saved and (saved["start"] != args.start or saved["policy"] != POLICY
                      or saved.get("region", "") != args.region or saved.get("chapter", 0) != args.chapter
                      or saved.get("bounds") != bounds):
            raise RuntimeError("起点/地区/章节/阈值/策略与记录不符，请使用新的 --journal")
        if not saved:
            plan(db, api, journal, args.start, args.region, bounds, done_stems(args.exclude_journal),
                 regions, args.chapter)
        if not args.execute:
            journal.report("dry_run")
            return 0
        if args.retry_failed:
            for job in journal.jobs():
                if job["state"] == "failed":
                    job.setdefault("attempt_history", []).append({
                        "archived_at": now(), **{key: job.get(key) for key in
                        ("reason", "failed_stage", "candidates", "selection", "errors")}
                    })
                    job["state"] = "generated" if job.get("new_ids") else "pending"
                    job.pop("reason", None)
                    job.pop("failed_stage", None)
                    journal.save(job)
        return run(db, api, journal, args.rewrite_workers, args.tts_workers, bounds)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("中断；重启时不会自动重发状态不明的 TTS 请求。", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f"批处理未完成：{exc}", file=sys.stderr)
        sys.exit(1)
