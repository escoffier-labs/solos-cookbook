#!/usr/bin/env bash
set -euo pipefail

CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

jq -e '.plugins.entries | type == "object"' "$CONFIG" >/dev/null
jq -r '.plugins.entries | to_entries[] | select((.value.enabled // false) == true) | .key' "$CONFIG"

systemctl --user is-active openclaw-gateway.service >/dev/null
echo "openclaw plugin config and gateway look reachable"
