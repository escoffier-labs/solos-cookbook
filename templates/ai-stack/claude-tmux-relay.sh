#!/usr/bin/env bash
# TOKEN HANDLING WARNING
# Do NOT put CLAUDE_CODE_OAUTH_TOKEN (or any secret) on a tmux command line,
# for example `tmux new-session -e CLAUDE_CODE_OAUTH_TOKEN=... ...` or
# `tmux new-session "CLAUDE_CODE_OAUTH_TOKEN=... claude ..."`. Command-line
# arguments are visible to every local process listing (`ps`, `/proc/*/cmdline`)
# and end up in captured transcripts. By default this script injects no token:
# Claude Code uses its own login in ~/.claude/. If a clean context (cron,
# systemd) really needs an explicit token, set CLAUDE_TOKEN_FILE to a 0600 env
# file; it is sourced INSIDE the tmux session, so only the file path appears in
# argv. Rotate any token that was ever exposed through argv.
set -euo pipefail

session="${CLAUDE_TMUX_SESSION:-claude-code-review}"
target="${session}:0.0"
workspace="${CLAUDE_WORKSPACE:-$PWD}"
model="${CLAUDE_MODEL:-opus}"
permission_mode="${CLAUDE_PERMISSION_MODE:-plan}"
session_name="${CLAUDE_SESSION_NAME:-openclaw-review}"
claude_bin="${CLAUDE_BIN:-claude}"
token_file="${CLAUDE_TOKEN_FILE:-}"

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
  CLAUDE_TOKEN_FILE       optional 0600 file containing a line such as
                          CLAUDE_CODE_OAUTH_TOKEN=<token>; sourced inside the
                          tmux session, never passed on the command line.
                          Unset by default (Claude Code uses its own login).
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

    env_prefix=""
    if [ -n "$token_file" ]; then
      if [ ! -f "$token_file" ]; then
        echo "CLAUDE_TOKEN_FILE does not exist: $token_file" >&2
        exit 1
      fi
      mode="$(stat -c '%a' "$token_file")"
      if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
        echo "refusing CLAUDE_TOKEN_FILE with mode $mode (need 600 or 400): $token_file" >&2
        exit 1
      fi
      # Only the file PATH goes into the tmux command line. The shell inside the
      # session reads the value; it never appears in argv.
      env_prefix="set -a && . $(quote "$token_file") && set +a && "
    fi

    launch_cmd="${env_prefix}cd $(quote "$workspace") && $(quote "$claude_bin") --model $(quote "$model") --permission-mode $(quote "$permission_mode") --name $(quote "$session_name")"
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
