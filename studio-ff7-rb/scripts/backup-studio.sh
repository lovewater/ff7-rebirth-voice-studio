#!/usr/bin/env bash
# 备份修订台：数据库按日期留多份，我们生成的配音增量拷到同一棵树。
# 不备份游戏日文、前人中文包。文件最多 5 路并发。不对 SMB 上的文件做校验。
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
JOBS=5
KEEP_DAYS=30

ROOT="${STUDIO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${BACKUP_DEST:?请配置 BACKUP_DEST 备份目的目录}"
TTS_SRC="$ROOT/website/data/tts"
COMPOSE_FILE="$ROOT/docker-compose.yml"
DB_USER="ff7rb"
DB_NAME="studio"
DATE_DIR="$(date +%Y-%-m-%-d)"
DB_DIR="$DEST/db/$DATE_DIR"
DATA_DIR="$DEST/data"
LOG="$DEST/backup.log"

die() { echo "FAILED: $*" >&2; exit 1; }
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

findmnt -T "$DEST" >/dev/null || die "BACKUP_DEST 没有可用挂载点"
[[ -d "$TTS_SRC" ]] || die "找不到 $TTS_SRC"
command -v docker >/dev/null || die "没有 docker"
[[ -f "$COMPOSE_FILE" ]] || die "找不到 $COMPOSE_FILE"

mkdir -p "$DEST" "$DB_DIR" "$DATA_DIR/tts"
touch "$LOG"

cd "$ROOT"
DB_CID="$(docker compose -f "$COMPOSE_FILE" ps -q db 2>/dev/null || true)"
[[ -n "$DB_CID" ]] || die "数据库容器没在跑，先在 studio-ff7-rb 执行 docker compose up -d db"
docker exec "$DB_CID" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null || die "Postgres 未就绪"

log "开始备份  db=$DATE_DIR  tts -> data/tts"

# 模型访问日志用于临时重放/成本比较，体积会持续增长：每日备份排除数据，
# 两种数据库备份格式都保留表结构，恢复后仍可直接继续记日志。
LLM_LOG_EXCLUDE="--exclude-table-data=public.llm_access_logs"

docker exec "$DB_CID" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner "$LLM_LOG_EXCLUDE" -f /tmp/studio.dump
docker cp "$DB_CID:/tmp/studio.dump" "$DB_DIR/studio.dump"
docker exec "$DB_CID" rm -f /tmp/studio.dump
docker exec "$DB_CID" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=plain --no-owner --encoding=UTF8 "$LLM_LOG_EXCLUDE" \
  | gzip -9 >"$DB_DIR/studio.sql.gz"
DUMP_SHA="$(sha256sum "$DB_DIR/studio.dump" | awk '{print $1}')"
SQL_SHA="$(sha256sum "$DB_DIR/studio.sql.gz" | awk '{print $1}')"
DUMP_BYTES="$(stat -c%s "$DB_DIR/studio.dump")"
SQL_BYTES="$(stat -c%s "$DB_DIR/studio.sql.gz")"
log "数据库 dump ${DUMP_BYTES} 字节  sha256=$DUMP_SHA"

log "拷贝 TTS（增量，${JOBS} 路并发，不删远端）"
python3 - "$TTS_SRC" "$DATA_DIR/tts" "$JOBS" <<'PY' | tee -a "$LOG"
import os, sys, shutil, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
jobs = int(sys.argv[3])
files = [p for p in src.rglob("*") if p.is_file()]
copied = skipped = failed = 0
t0 = time.time()
n = len(files)


def one(p: Path) -> str:
    rel = p.relative_to(src)
    d = dst / rel
    try:
        st = p.stat()
        if d.is_file():
            ds = d.stat()
            if ds.st_size == st.st_size and int(ds.st_mtime) == int(st.st_mtime):
                return "skip"
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, d)
        os.utime(d, (st.st_atime, st.st_mtime))
        return "copy"
    except Exception as exc:
        return f"fail:{rel}:{exc}"


done = 0
with ThreadPoolExecutor(max_workers=jobs) as pool:
    futs = [pool.submit(one, p) for p in files]
    for fut in as_completed(futs):
        result = fut.result()
        done += 1
        if result == "copy":
            copied += 1
        elif result == "skip":
            skipped += 1
        else:
            failed += 1
            print(result, flush=True)
        if done % 200 == 0 or done == n:
            print(
                f"progress {done}/{n} copy={copied} skip={skipped} fail={failed} elapsed={time.time()-t0:.0f}s",
                flush=True,
            )
print(f"done copy={copied} skip={skipped} fail={failed} total={n}", flush=True)
raise SystemExit(1 if failed else 0)
PY

log "核对"

docker exec "$DB_CID" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "DROP DATABASE IF EXISTS studio_restore_check WITH (FORCE);"
docker exec "$DB_CID" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "CREATE DATABASE studio_restore_check OWNER $DB_USER;"
docker cp "$DB_DIR/studio.dump" "$DB_CID:/tmp/studio.dump"
TOC_N="$(docker exec "$DB_CID" pg_restore -l /tmp/studio.dump | grep -c '^[0-9]' || true)"
[[ "$TOC_N" -gt 20 ]] || die "studio.dump TOC 条目过少: $TOC_N"
docker exec "$DB_CID" pg_restore -U "$DB_USER" -d studio_restore_check --no-owner --exit-on-error /tmp/studio.dump
docker exec "$DB_CID" rm -f /tmp/studio.dump

live_count() { docker exec "$DB_CID" psql -U "$DB_USER" -d "$DB_NAME" -Atc "$1"; }
chk_count() { docker exec "$DB_CID" psql -U "$DB_USER" -d studio_restore_check -Atc "$1"; }

Q_TTS='SELECT COUNT(*) FROM line_tts_versions'
Q_READY="SELECT COUNT(*) FROM line_tts_versions WHERE status = 'ready' AND audio_path IS NOT NULL"
Q_USED="SELECT COUNT(*) FROM line_tts_versions WHERE is_used"
Q_LINES='SELECT COUNT(*) FROM lines'
Q_META='SELECT COUNT(*) FROM line_meta'
Q_PRON='SELECT COUNT(*) FROM pronunciations'
Q_SKIP="SELECT COUNT(*) FROM line_meta WHERE skip_timing"

LIVE_TTS="$(live_count "$Q_TTS")"
LIVE_READY="$(live_count "$Q_READY")"
LIVE_USED="$(live_count "$Q_USED")"
LIVE_LINES="$(live_count "$Q_LINES")"
LIVE_META="$(live_count "$Q_META")"
LIVE_PRON="$(live_count "$Q_PRON")"
LIVE_SKIP="$(live_count "$Q_SKIP")"

for pair in \
  "line_tts_versions:$Q_TTS:$LIVE_TTS" \
  "ready_audio:$Q_READY:$LIVE_READY" \
  "used:$Q_USED:$LIVE_USED" \
  "lines:$Q_LINES:$LIVE_LINES" \
  "line_meta:$Q_META:$LIVE_META" \
  "pronunciations:$Q_PRON:$LIVE_PRON" \
  "skip_timing:$Q_SKIP:$LIVE_SKIP"
do
  name="${pair%%:*}"
  rest="${pair#*:}"
  q="${rest%:*}"
  expect="${rest##*:}"
  got="$(chk_count "$q")"
  [[ "$got" == "$expect" ]] || die "还原核对失败 $name 期望 $expect 得到 $got"
  log "库表 $name = $got"
done

docker exec "$DB_CID" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS studio_restore_check WITH (FORCE);" >/dev/null

SRC_AUDIO="$(find "$TTS_SRC" -type f \( -name '*.wav' -o -name '*.mp3' \) | wc -l)"
SRC_JSON="$(find "$TTS_SRC" -type f -name '*.json' | wc -l)"
[[ "$SRC_AUDIO" -ge "$LIVE_READY" ]] || die "本机 TTS 音频 $SRC_AUDIO 少于 ready 行 $LIVE_READY"

{
  echo "backup_ok $(date '+%F %T')"
  echo "db_dir $DB_DIR"
  echo "studio.dump bytes=$DUMP_BYTES sha256=$DUMP_SHA toc=$TOC_N"
  echo "studio.sql.gz bytes=$SQL_BYTES sha256=$SQL_SHA"
  echo "lines=$LIVE_LINES line_meta=$LIVE_META tts_rows=$LIVE_TTS ready=$LIVE_READY used=$LIVE_USED pronunciations=$LIVE_PRON skip_timing=$LIVE_SKIP"
  echo "tts_audio_src=$SRC_AUDIO tts_json_src=$SRC_JSON"
  echo "restore_check=passed"
  echo "file_verify=skipped"
} | tee "$DB_DIR/MANIFEST.txt" | tee -a "$LOG"

cp "$ROOT/scripts/RESTORE.md" "$DEST/RESTORE.md"

log "删除 ${KEEP_DAYS} 天前的数据库备份"
python3 - "$DEST/db" "$KEEP_DAYS" <<'PY' | tee -a "$LOG"
import shutil, sys
from datetime import date
from pathlib import Path

root = Path(sys.argv[1])
keep_days = int(sys.argv[2])
today = date.today()
removed = 0
for p in sorted(root.iterdir()):
    if not p.is_dir():
        continue
    parts = p.name.split("-")
    if len(parts) != 3:
        continue
    try:
        d = date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        continue
    age = (today - d).days
    if age > keep_days:
        shutil.rmtree(p)
        print(f"removed {p.name} ({age} days)", flush=True)
        removed += 1
print(f"db_prune removed={removed} keep_days={keep_days}", flush=True)
PY

log "备份完成"
