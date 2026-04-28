# Self-hosted infrastructure

The homelab. Hypervisor decisions, container layout, network storage, off-host backup, integration with daily-driver desktop, and surviving upgrades.

## Guides

- [x] [`backup-recovery.md`](backup-recovery.md) — restic to NAS + Google Drive, twice-daily schedule, snapshot mounts, disaster recovery
- [x] [`upgrade-hygiene.md`](upgrade-hygiene.md) — surviving `openclaw update`: systemd regeneration, dist patches, OAuth sync, schema drift
- [ ] `homelab-topology.md` — hypervisor + LXC/VM split, service-per-container discipline
- [ ] `nas-and-backups.md` — network storage mounts beyond restic
- [ ] `desktop-integration.md` — daily-driver desktop as peer, not just client (SSH/SMB, mounts, sync)
- [ ] `service-isolation.md` — one service per container, why this beats one big VM

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
