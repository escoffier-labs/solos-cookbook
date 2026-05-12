#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  status|diff|log|show|branch|rev-parse|ls-files)
    exec /usr/bin/git "$@"
    ;;
  *)
    echo "sandbox: git ${1:-<none>} is not allowed in this worker lane" >&2
    exit 126
    ;;
esac
