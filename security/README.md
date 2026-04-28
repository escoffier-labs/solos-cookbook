# Security

Defense in depth across host, agents, network, and publish boundary. Plus what to do when the agent does something it shouldn't.

## Guides

- [x] [`linux-hardening.md`](linux-hardening.md) — UFW, SSH hardening, fail2ban, service binding, defense-in-depth (Ubuntu 24.04)
- [x] [`wsl-hardening.md`](wsl-hardening.md) — Windows Firewall, RDP/SSH/SMB lockdown, port-proxy hygiene, dual-OS defense (Windows 11 + WSL2)
- [x] [`agent-security-hardening.md`](agent-security-hardening.md) — API gateway isolation, RBAC, sandboxing, circuit breakers, post-mortem from a sub-agent nuking a database
- [ ] `wazuh-triage.md` — RCA → fix → narrow suppress in one pass
- [ ] `publish-time-scrubbing.md` — hostname + PII scrubbers as preflight, not afterthought
- [ ] `incident-runbook.md` — agent did a destructive thing, here's what you do
- [ ] `secret-management.md` — env files, systemd EnvironmentFile, never in config

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
