# Self-hosted infrastructure

The homelab. Hypervisor decisions, container layout, network storage, off-host backup, integration with daily-driver desktop, and surviving upgrades.

## Guides

- [x] [`backup-recovery.md`](backup-recovery.md) - restic to NAS (twice daily) + Google Drive (weekly), Drive quota/over-sync gotchas, KeePass canonical sync, snapshot mounts, disaster recovery
- [x] [`upgrade-hygiene.md`](upgrade-hygiene.md) - surviving `openclaw update`: systemd regeneration, dist patches, OAuth sync, schema drift
- [x] [`openclaw-host-topology.md`](openclaw-host-topology.md) - services, config surfaces, agents, plugins, cron, memory, browser automation, health checks
- [ ] `homelab-topology.md` - hypervisor + LXC/VM split, service-per-container discipline
- [ ] `nas-and-backups.md` - network storage mounts beyond restic
- [ ] `desktop-integration.md` - daily-driver desktop as peer, not just client (SSH/SMB, mounts, sync)
- [ ] `service-isolation.md` - one service per container, why this beats one big VM

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
