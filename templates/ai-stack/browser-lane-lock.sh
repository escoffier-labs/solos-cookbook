#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  printf 'usage: %s <lane> <command> [args...]\n' "$0" >&2
  exit 64
fi

lane="$1"
shift

state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
lock_dir="${BROWSER_LOCK_DIR:-$state_home/agent-browser/locks}"
timeout="${BROWSER_LOCK_TIMEOUT:-900}"
lock_file="$lock_dir/$lane.lock"

mkdir -p "$lock_dir"
exec flock -w "$timeout" "$lock_file" "$@"
