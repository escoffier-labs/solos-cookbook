#!/usr/bin/env bash
set -euo pipefail

APPLY=0
RULES="${SCRUB_RULES:-$(dirname "$0")/rules.example.tsv}"

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "usage: scrub-content.sh [--apply] <file-or-directory>..." >&2
  exit 2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

find_targets() {
  for target in "$@"; do
    if [[ -d "$target" ]]; then
      find "$target" -type f -name '*.md' -o -name '*.txt'
    else
      printf '%s\n' "$target"
    fi
  done
}

while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  cp "$file" "$tmp"
  while IFS=$'\t' read -r pattern replacement; do
    [[ -z "${pattern:-}" || "$pattern" == \#* ]] && continue
    perl -0pi -e "s{$pattern}{$replacement}g" "$tmp"
  done < "$RULES"

  if ! cmp -s "$file" "$tmp"; then
    if [[ "$APPLY" -eq 1 ]]; then
      cp "$tmp" "$file"
      echo "scrubbed $file"
    else
      echo "would scrub $file"
      diff -u "$file" "$tmp" || true
    fi
  fi
done < <(find_targets "$@")
