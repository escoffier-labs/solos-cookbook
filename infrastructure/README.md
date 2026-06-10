# Self-hosted infrastructure

The homelab. Hypervisor decisions, container layout, network storage, off-host backup, integration with daily-driver desktop, and surviving upgrades.

## Guides

- [x] [`backup-recovery.md`](backup-recovery.md) - restic to NAS (twice daily) + Google Drive (weekly), Drive quota/over-sync gotchas, KeePass canonical sync, snapshot mounts, disaster recovery
- [x] [`upgrade-hygiene.md`](upgrade-hygiene.md) - surviving `openclaw update`: systemd regeneration, dist patches, OAuth sync, schema drift
- [x] [`openclaw-host-topology.md`](openclaw-host-topology.md) - services, config surfaces, agents, plugins, cron, memory, browser automation, health checks
- [x] [`homelab-topology.md`](homelab-topology.md) - hypervisor map: LXC/VM split, container inventory, resource allocation, backup wiring
- [x] [`nas-and-backups.md`](nas-and-backups.md) - CIFS automount patterns, soft mounts, bind-mount traps, PBS-on-NAS resilience
- [x] [`desktop-integration.md`](desktop-integration.md) - daily-driver desktop as peer: SSH into Windows, SMB shares, SCP inbox, remote app control
- [x] [`service-isolation.md`](service-isolation.md) - one service per unprivileged container, blast radius, ephemeral build containers
- [x] [`proxmox-agent-lab.md`](proxmox-agent-lab.md) - Proxmox as the agent-stack substrate: service vs ephemeral CTs, RAM budget, PBS, proxmox-mcp + proxguard
- [x] [`adguard-dns-sinkhole.md`](adguard-dns-sinkhole.md) - network DNS sinkhole with a synced standby, agent-managed via adguard-mcp

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
