# Templates

Drop-in artifacts you can lift from this stack without adopting the whole thing. Each subdirectory corresponds to a guide that uses it.

## Available

- [`cron/`](cron/) — skeletons for systemd timers, OpenClaw cron jobs, and n8n schedule triggers. Used by [`../automation/cron-patterns.md`](../automation/cron-patterns.md).

## Planned

- [ ] `hooks/` — pre/post hook skeletons + sandbox shim wrappers
- [ ] `n8n/` — workflow JSON exports with placeholders
- [ ] `scrubbers/` — sed-based scrubber template + test fixtures
- [ ] `ai-stack/` — model alias snippets, ACP wrapper script

## License

Templates are MIT (see [`../LICENSE`](../LICENSE)). Lift freely. Attribution appreciated but not required.
