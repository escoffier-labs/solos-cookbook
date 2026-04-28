# Automation

Anything scheduled, hooked, or sandbox-wrapped. The decision tree for "where does this go" lives in `cron-patterns.md` — start there.

## Guides

- [x] [`cron-patterns.md`](cron-patterns.md) — three-layer cron stack: systemd vs agent cron vs n8n schedule triggers
- [x] [`openclaw-cron-deep-dive.md`](openclaw-cron-deep-dive.md) — OpenClaw-specific deep dive: heartbeat batching, thinking-budget aliases, delivery routing
- [x] [`multi-channel-setup.md`](multi-channel-setup.md) — Discord, Telegram, Signal routing, session isolation, ACP threads
- [ ] `hooks.md` — pre/post hooks, sandbox shims, message-sending guards
- [ ] `n8n-patterns.md` — Code node pitfalls, workflow_history gotcha, error-classifier
- [ ] `sandbox-shims.md` — wrapping git/network for sub-agents that shouldn't have free access
- [ ] `failure-classifier.md` — turning n8n errors into actionable buckets, not noise

> 🦞 Reference guide is `cron-patterns.md`. Match its depth.
