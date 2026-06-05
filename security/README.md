# Security

Defense in depth across host, agents, network, and outbound boundary. Plus what to do when the agent does something it shouldn't.

## Guides

- [x] [`linux-hardening.md`](linux-hardening.md) - UFW, SSH hardening, fail2ban, service binding, defense-in-depth (Ubuntu 24.04)
- [x] [`wsl-hardening.md`](wsl-hardening.md) - Windows Firewall, RDP/SSH/SMB lockdown, port-proxy hygiene, dual-OS defense (Windows 11 + WSL2)
- [x] [`agent-security-hardening.md`](agent-security-hardening.md) - API gateway isolation, RBAC, sandboxing, circuit breakers, post-mortem from a sub-agent nuking a database
- [x] [`wazuh-triage.md`](wazuh-triage.md) - RCA → fix → narrow suppress in one pass
- [x] `outbound-scrubbing.md` - covered by [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md): scrubbers and scanner gates as preflight, not afterthought
- [x] [`incident-runbook.md`](incident-runbook.md) - agent did a destructive thing, secret leaked, or automation ran away, here's what you do
- [x] [`secret-management.md`](secret-management.md) - env files, systemd EnvironmentFile, browser profiles, rotation, never in config

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
