# Tools

Index of tools shipped from this stack - MCPs, dashboards, helpers - and how they fit together.

## Guides

- [`mcp-catalog.md`](mcp-catalog.md) - the public MCP servers published from this stack (media, infrastructure, security, code and memory), what each one wraps, and how per-server secrets are injected
- [`brigade.md`](brigade.md) - installable agent workspace bootstrap, handoff inboxes, MCP sync, work loops, fleet coordination, code graph and evidence lookups, publish guards, operator checks, and security scans
- [`skillet.md`](skillet.md) - installable agent skills: line-check repo audits with impact-sorted backlogs, bug-hunt, security-sweep, publish gates, releases, handoffs, and newer review, research, and orchestration skills
- [`opsdeck.md`](opsdeck.md) - personal ops control plane: a 43-route React dashboard over a default-deny Express API, what's on it, and why
- [`repo-redeploy.md`](repo-redeploy.md) - manifest-driven cron job that keeps installed builds in step with their repos: stale-build and version-drift checks, locking, dry runs, and optional mirroring to a second host
- [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md) - every MCP repo documents Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI, plus how other clients and `brigade mcp sync` fit

> Per-guide format: [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
