#!/usr/bin/env python3
"""Persist net speech measurements sequentially; resume from PostgreSQL.

--watch discovers new/changed files periodically. Default drains one scan.
No audio writes, no adoption changes, no LLM/TTS calls.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from speech_activity import VERSION, analyze_file, safe_path

# Match website speech-metrics-store.ts and the reading engine's version.
from mora_core import BEAT_VERSION, japanese_metrics, chinese_syllables, clean_text
ALGORITHM = f"{VERSION}:{BEAT_VERSION}"
ROOT = Path(os.environ.get('AUDIO_DATA_ROOT', '/app/data'))
DSN = os.environ.get('DATABASE_URL', '')
UPSERT = """
 INSERT INTO speech_metrics(cache_key,audio_path,language,source_text,file_version,algorithm_version,priority)
 VALUES (%s,%s,%s,%s,%s,%s,%s)
 ON CONFLICT(cache_key) DO UPDATE SET
   file_version=excluded.file_version,algorithm_version=excluded.algorithm_version,
   status='pending',last_error=NULL,attempts=0,queued_at=now(),next_attempt_at=now(),
   priority=GREATEST(speech_metrics.priority,excluded.priority)
 WHERE speech_metrics.file_version IS DISTINCT FROM excluded.file_version
    OR speech_metrics.algorithm_version IS DISTINCT FROM excluded.algorithm_version
"""


def cache_key(path, language, text):
    return hashlib.sha256(f'{path}\0{language}\0{text}'.encode()).hexdigest()


def signature(path):
    try:
        stat = safe_path(ROOT, path).stat()
        return f'{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}'
    except FileNotFoundError:
        return 'missing'


def seed(conn):
    rows = conn.execute("""
      SELECT l.stem,l.text_jp,l.text_zh,
        CASE WHEN m.dialogue_mode='scene' THEN 10 ELSE 0 END AS priority
      FROM lines l LEFT JOIN line_meta m ON m.stem=l.stem
      ORDER BY CASE WHEN l.region='GOLDE' THEN 0 ELSE 1 END,l.stem
    """).fetchall()
    sources = []
    texts = {}
    for row in rows:
        texts[row['stem']] = row
        for language, field in [('jp','text_jp'),('cn','text_zh')]:
            sources.append((f"{language}/{row['stem']}.mp3", language, row[field] or '', row['priority']))
    for row in conn.execute("""
      SELECT stem,audio_path,raw_audio_path,tts_text,review_state,
        (voice_gpu_key='jp-lock' OR conversion_meta->>'pipeline'='jp-lock') AS jp_lock
      FROM line_tts_versions WHERE status='ready' ORDER BY (review_state='locked') DESC,id DESC
    """).fetchall():
        line = texts.get(row['stem'])
        if not line:
            continue
        language = 'jp' if row['jp_lock'] else 'cn'
        text = (line['text_jp'] or '') if row['jp_lock'] else (row['tts_text'] or line['text_zh'] or '')
        for field in ('audio_path','raw_audio_path'):
            if row[field]:
                sources.append((row[field], language, text, 20 if row['review_state']=='locked' else line['priority']))
    # Only enqueue changed/new inputs. Reading directory metadata is cheap;
    # periodic scans never decode already measured audio.
    known = {r['cache_key']: (r['file_version'],r['algorithm_version']) for r in
             conn.execute('SELECT cache_key,file_version,algorithm_version FROM speech_metrics').fetchall()}
    changes = {}
    for path, language, text, priority in sources:
        key = cache_key(path, language, text)
        try:
            version = signature(path)
        except ValueError:
            continue
        if known.get(key) != (version, ALGORITHM):
            changes[key] = (key,path,language,text,version,ALGORITHM,priority)
    if changes:
        with conn.transaction(), conn.cursor() as cur:
            cur.executemany(UPSERT, changes.values())
    print(json.dumps({'event':'scan','sources':len(sources),'queued':len(changes)},ensure_ascii=False),flush=True)


def process(conn, row):
    path, expected = row['audio_path'], row['file_version']
    try:
        if signature(path) != expected:
            conn.execute("UPDATE speech_metrics SET file_version=%s,queued_at=now() WHERE cache_key=%s AND file_version=%s",
                         (signature(path),row['cache_key'],expected))
            return False
        result = analyze_file(ROOT, path)
        if row['language'] == 'jp':
            metrics = japanese_metrics(row['source_text'])
            units, reading_status = metrics['mora'], metrics['status']
        else:
            units = chinese_syllables(clean_text(row['source_text']))
            reading_status = 'ok' if units else 'missing'
        rate = units/result['activeS'] if units and result['activeS']>0 and reading_status=='ok' else None
        result = {**result,'units':units,'readingStatus':reading_status,'rate':rate}
        # A file can be edited while it is decoded. Never publish stale bytes
        # under the replacement file's signature; the next pass retries it.
        if signature(path) != expected:
            return False
        conn.execute("""UPDATE speech_metrics SET status='ready',result=%s,
            duration_s=%s,silence_s=%s,net_speech_s=%s,unit_count=%s,units_per_s=%s,
            measured_at=now(),last_error=NULL,attempts=attempts+1
            WHERE cache_key=%s AND file_version=%s AND algorithm_version=%s""",
            (Jsonb(result),result['durationS'],result['silenceS'],result['activeS'],units,rate,
             row['cache_key'],expected,ALGORITHM))
        return True
    except Exception as exc:
        message = '音频文件不存在' if isinstance(exc, FileNotFoundError) else str(exc)[:400]
        conn.execute("""UPDATE speech_metrics SET status='error',last_error=%s,
          attempts=attempts+1,next_attempt_at=now()+interval '1 hour'
          WHERE cache_key=%s AND file_version=%s AND algorithm_version=%s""",
          (message,row['cache_key'],expected,ALGORITHM))
        return False


def report(conn, done, started):
    counts={r['status']:r['n'] for r in conn.execute('SELECT status,count(*) AS n FROM speech_metrics GROUP BY status')}
    print(json.dumps({'event':'progress','sessionDone':done,'seconds':round(time.monotonic()-started),**counts}),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch',action='store_true')
    parser.add_argument('--seed-only',action='store_true')
    parser.add_argument('--limit',type=int,default=0,help='maximum jobs for this run; 0 is unlimited')
    args=parser.parse_args()
    try: os.nice(10)
    except OSError: pass
    with psycopg.connect(DSN,autocommit=True,row_factory=dict_row) as conn:
        if args.seed_only:
            seed(conn)
            return
        if not conn.execute("SELECT pg_try_advisory_lock(hashtext('net-speech-batch-v1')) AS locked").fetchone()['locked']:
            raise SystemExit('净语速后台脚本已运行，不启动第二个计算进程')
        seed(conn)
        started=last_scan=last_report=time.monotonic()
        done=attempted=0
        while True:
            if args.watch and time.monotonic()-last_scan>=60:
                seed(conn)
                conn.execute("UPDATE speech_metrics SET status='pending' WHERE status='error' AND next_attempt_at<=now() AND attempts<3")
                last_scan=time.monotonic()
            rows=conn.execute("""SELECT * FROM speech_metrics WHERE status='pending'
              AND algorithm_version=%s ORDER BY priority DESC,queued_at LIMIT 50""",(ALGORITHM,)).fetchall()
            for row in rows:
                done+=int(process(conn,row)); attempted+=1
                if attempted%100==0 or time.monotonic()-last_report>=30:
                    report(conn,done,started);last_report=time.monotonic()
                if args.limit and attempted>=args.limit:
                    report(conn,done,started)
                    return
            if not rows:
                report(conn,done,started)
                if not args.watch:
                    return
                time.sleep(5)

if __name__=='__main__':
    main()
