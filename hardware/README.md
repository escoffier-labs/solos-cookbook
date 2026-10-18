# Hardware & host

The physical layer. Choosing the box, partitioning the disk, deciding what the host OS owns vs what gets virtualized.

## Guides

- [`bare-metal-setup.md`](bare-metal-setup.md) - choosing hardware, OS install, baseline tuning for an always-on agent host
- [`disk-layout-lvm.md`](disk-layout-lvm.md) - two-disk LVM design that survives "I need to grow this" without a reinstall
- [`kernel-tuning.md`](kernel-tuning.md) - the sysctl, swap, scheduler, and limit values the host actually runs, plus optional tuning not applied

> Per-guide format: [`../automation/cron-patterns.md`](../automation/cron-patterns.md). All three guides were checked against the production host on 2026-10-17.
