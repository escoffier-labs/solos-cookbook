# Scrubber Templates

Deterministic content scrubbing for publish boundaries.

## Files

- `scrub-content.sh` - preview or apply replacements
- `rules.example.tsv` - placeholder pattern rules
- `fixtures/input.txt` and `fixtures/expected.txt` - public-safe test fixture shape

## Usage

```bash
templates/scrubbers/scrub-content.sh templates/scrubbers/fixtures/input.txt
templates/scrubbers/scrub-content.sh --apply drafts/
```

Use this at the boundary where content leaves the host, not on every private chat reply. The full workflow lives in [`../../publishing/publish-time-scrubbing.md`](../../publishing/publish-time-scrubbing.md).
