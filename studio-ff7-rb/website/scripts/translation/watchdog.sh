#!/usr/bin/env bash
# cron每分钟调用。锁在整个Node生命期持有，避免重叠；STOP存在时绝不重新拉起。
set -euo pipefail
translation_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
translation_site_dir="$(cd -- "$translation_script_dir/../.." && pwd)"
translation_state_dir="${TRANSLATION_STATE_DIR:-$translation_site_dir/data/translation-background}"
mkdir -p "$translation_state_dir"
[ ! -e "$translation_state_dir/STOP" ] || exit 0
translation_node="${TRANSLATION_NODE:-node}"
# flock占用退出是正常“已有进程”，不记成错误。
exec 9>"$translation_state_dir/process.lock"
flock -n 9 || exit 0
export TRANSLATION_STATE_DIR="$translation_state_dir"
export TRANSLATION_ENV_FILE="${TRANSLATION_ENV_FILE:-$translation_state_dir/model.env}"
# 每天单独小日志，自动清理14天前的调度日志；完整模型输入输出已进数据库。
find "$translation_state_dir" -maxdepth 1 -name 'run-*.log' -mtime +14 -delete
printf '%s\n' "$$" > "$translation_state_dir/watchdog.pid"
exec "$translation_node" "$translation_site_dir/scripts/translate-dialogue.cjs" "$@" >>"$translation_state_dir/run-$(date +%F).log" 2>&1
