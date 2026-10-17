"""Internal HTTP adapter with derived SQL metrics cache for the shared beat calculator."""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import psycopg
from mora_core import BEAT_VERSION, analyze_pair, japanese_metrics, japanese_speech_reading, chinese_syllables, clean_text
from speech_activity import analyze_file

engine_lock = threading.Lock()
speech_slots = threading.BoundedSemaphore(2)
AUDIO_ROOT = Path(os.environ.get("AUDIO_DATA_ROOT", "/app/data"))


def refresh_metrics():
    """Cache source CN metrics for SQL filtering; adoption still overrides all alarms.

    Only uncorrected, non-italic scene dialogue is eligible. Text hashes + rule
    version invalidate stale counts. Latest unadopted TTS must NOT hide problems
    in the source CN that is still playing in the game.
    """
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return
    with psycopg.connect(database_url) as conn:
        rows = conn.execute("""
          SELECT l.stem, COALESCE(l.text_jp,''), COALESCE(l.text_zh,''),
                 md5(COALESCE(l.text_jp,'')), md5(COALESCE(l.text_zh,''))
          FROM lines l JOIN line_meta m ON m.stem=l.stem
          WHERE l.kind IN ('对话','talk') AND m.dialogue_mode='scene'
            AND NOT COALESCE(l.subtitle_italic,false) AND NOT COALESCE(m.skip_timing,false)
            AND NOT EXISTS (SELECT 1 FROM line_tts_versions t
                WHERE t.stem=l.stem AND t.review_state='locked' AND t.status='ready')
            AND (m.beat_version IS DISTINCT FROM %s
              OR m.beat_jp_hash IS DISTINCT FROM md5(COALESCE(l.text_jp,''))
              OR m.beat_cn_hash IS DISTINCT FROM md5(COALESCE(l.text_zh,'')))
        """, (BEAT_VERSION,)).fetchall()
        updates = []
        for stem, jp, cn, jp_hash, cn_hash in rows:
            with engine_lock:
                result = analyze_pair(jp, cn)
            updates.append((jp_hash, cn_hash, BEAT_VERSION, result["jp"]["status"],
                            result["normalizedRatio"], result["mark"], stem))
        if updates:
            with conn.cursor() as cursor:
                cursor.executemany("""
                  UPDATE line_meta SET beat_jp_hash=%s, beat_cn_hash=%s,
                    beat_version=%s, beat_status=%s, beat_ratio=%s, beat_mark=%s
                  WHERE stem=%s
                """, updates)
            print(f"refreshed beat metrics: {len(updates)}", flush=True)


def maintain_metrics():
    while True:
        time.sleep(30)
        try:
            refresh_metrics()
        except Exception as exc:
            print(f"beat cache refresh failed: {exc}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_speech(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 65536:
                return self.reply(413, {"error": "payload too large"})
            items = json.loads(self.rfile.read(length)).get("items")
            if not isinstance(items, list) or not 1 <= len(items) <= 4:
                raise ValueError("expected 1–4 items")
            for item in items:
                if (not isinstance(item, dict) or item.get("language") not in ("jp", "cn")
                    or not isinstance(item.get("path"), str) or len(item["path"]) > 1000
                    or not isinstance(item.get("text"), str) or len(item["text"]) > 5000):
                    raise ValueError("invalid speech item")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "invalid request"})
        if not speech_slots.acquire(timeout=1):
            return self.reply(503, {"error": "音频分析繁忙，请稍后重试"})
        try:
            results = []
            for item in items:
                try:
                    audio = analyze_file(AUDIO_ROOT, item["path"])
                    if item["language"] == "jp":
                        with engine_lock:
                            metrics = japanese_metrics(item["text"])
                        units, reading_status = metrics["mora"], metrics["status"]
                    else:
                        units = chinese_syllables(clean_text(item["text"]))
                        reading_status = "ok" if units else "missing"
                    rate = (units / audio["activeS"] if units and audio["activeS"] > 0
                            and reading_status == "ok" else None)
                    results.append({**audio, "units": units, "readingStatus": reading_status, "rate": rate})
                except FileNotFoundError:
                    results.append({"status": "missing", "error": "音频文件不存在"})
                except Exception as exc:
                    self.log_error("speech analysis failed: %s", exc)
                    results.append({"status": "error", "error": "音频分析失败"})
            self.reply(200, {"results": results})
        finally:
            speech_slots.release()

    def do_POST(self):
        if self.path == "/speech":
            return self.do_speech()
        if self.path != "/beats":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 1048576:
                return self.reply(413, {"error": "payload too large"})
            request = json.loads(self.rfile.read(length))
            pairs = request.get("pairs")
            if not isinstance(pairs, list) or not 1 <= len(pairs) <= 100:
                raise ValueError("expected 1–100 pairs")
            for pair in pairs:
                if not isinstance(pair, dict) or any(
                    not isinstance(pair.get(key), str) or len(pair[key]) > 5000
                    for key in ("jp", "cn")
                ):
                    raise ValueError("invalid text pair")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "invalid request"})
        try:
            with engine_lock:
                results = [analyze_pair(p["jp"], p["cn"]) for p in pairs]
                # 仅自动语速判断显式请求；短句正文仍不计算 ratio/normalizedRatio。
                if request.get("includeSpeechReading") is True:
                    for pair, result in zip(pairs, results):
                        result["jpSpeech"] = japanese_speech_reading(pair["jp"])
            self.reply(200, {"results": results})
        except Exception as exc:
            self.log_error("beat calculation failed: %s", exc)
            self.reply(500, {"error": "beat calculation failed"})


if __name__ == "__main__":
    # Warm dictionaries before accepting traffic. A single worker serializes access
    # to the native taggers; repeated JP readings use a bounded in-memory cache.
    japanese_metrics("日文の読み方を確認します。")
    refresh_metrics()
    threading.Thread(target=maintain_metrics, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
