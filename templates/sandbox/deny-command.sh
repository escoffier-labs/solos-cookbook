#!/usr/bin/env bash
set -euo pipefail

name="$(basename "$0")"
echo "sandbox: $name is disabled in this worker lane" >&2
exit 126
