#!/usr/bin/env bash
set -euo pipefail

session="${CLAUDE_TMUX_SESSION:-claude-code-review}"
target="${session}:0.0"
workspace="${CLAUDE_WORKSPACE:-$PWD}"
model="${CLAUDE_MODEL:-opus}"
permission_mode="${CLAUDE_PERMISSION_MODE:-plan}"
session_name="${CLAUDE_SESSION_NAME:-openclaw-review}"
claude_bin="${CLAUDE_BIN:-claude}"

usage() {
  cat <<'USAGE'
Usage:
  claude-tmux-relay.sh start
  claude-tmux-relay.sh send "prompt text"
  claude-tmux-relay.sh send-file /path/to/prompt.txt
  claude-tmux-relay.sh capture [start-line]
  claude-tmux-relay.sh stop

Environment:
  CLAUDE_TMUX_SESSION     tmux session name, default claude-code-review
  CLAUDE_WORKSPACE        working directory, default current directory
  CLAUDE_MODEL            Claude Code model flag, default opus
  CLAUDE_PERMISSION_MODE  plan or acceptEdits, default plan
  CLAUDE_SESSION_NAME     Claude Code session name, default openclaw-review
  CLAUDE_BIN              Claude Code binary, default claude
USAGE
}

quote() {
  printf '%q' "$1"
}

require_session() {
  if ! tmux has-session -t "$session" 2>/dev/null; then
    echo "No tmux session named $session. Run: $0 start" >&2
    exit 1
  fi
}

cmd="${1:-}"
case "$cmd" in
  start)
    if tmux has-session -t "$session" 2>/dev/null; then
      echo "tmux session already exists: $session"
      exit 0
    fi

    launch_cmd="cd $(quote "$workspace") && $(quote "$claude_bin") --model $(quote "$model") --permission-mode $(quote "$permission_mode") --name $(quote "$session_name")"
    tmux new-session -d -s "$session" "$launch_cmd"
    echo "started $session in $workspace"
    ;;

  send)
    shift || true
    require_session
    if [ "$#" -eq 0 ]; then
      echo "send requires prompt text" >&2
      exit 1
    fi
    tmux send-keys -t "$target" -l -- "$*"
    tmux send-keys -t "$target" Enter
    ;;

  send-file)
    require_session
    prompt_file="${2:-}"
    if [ -z "$prompt_file" ] || [ ! -f "$prompt_file" ]; then
      echo "send-file requires an existing prompt file" >&2
      exit 1
    fi
    tmux load-buffer "$prompt_file"
    tmux paste-buffer -t "$target" -d
    tmux send-keys -t "$target" Enter
    ;;

  capture)
    require_session
    start_line="${2:--200}"
    tmux capture-pane -t "$target" -p -S "$start_line"
    ;;

  stop)
    if tmux has-session -t "$session" 2>/dev/null; then
      tmux kill-session -t "$session"
      echo "stopped $session"
    fi
    ;;

  -h|--help|help|"")
    usage
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
