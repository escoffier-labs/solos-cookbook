# Security

Defense in depth across host, agents, network, and outbound boundary. Plus what to do when the agent does something it shouldn't.

## Guides

- [x] [`linux-hardening.md`](linux-hardening.md) - UFW, SSH hardening, fail2ban, service binding, auditd, unattended-upgrades, Wazuh agent (Ubuntu 24.04)
- [x] [`wsl-hardening.md`](wsl-hardening.md) - Windows host running a native node: Windows Firewall, RDP/SSH/SMB lockdown, node credentials, sleep prevention, optional WSL2
- [x] [`agent-security-hardening.md`](agent-security-hardening.md) - API gateway isolation, RBAC, sandboxing, circuit breakers, a dedicated security-review lane, post-mortem from a sub-agent nuking a database
- [x] [`wazuh-triage.md`](wazuh-triage.md) - RCA → fix → narrow suppress in one pass, plus the 2026-09 alert-flood incident, retention, and agent version pinning
- [x] [`mcp-incident-response.md`](mcp-incident-response.md) - agent-driven SOC loop: Wazuh → TheHive → Cortex → MISP → ATT&CK over your own MCP servers, with read-only credentials
- [x] `outbound-scrubbing.md` - covered by [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md): scrubbers and scanner gates as preflight, not afterthought
- [x] [`incident-runbook.md`](incident-runbook.md) - agent did a destructive thing, secret leaked, or automation ran away, here's what you do
- [x] [`secret-management.md`](secret-management.md) - env files, rendering from a vault to tmpfs, TPM-sealed credentials, MCP env inheritance, shell-snapshot leaks, rotation, never in config

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
