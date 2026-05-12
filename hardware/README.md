# Hardware & host

The physical layer. Choosing the box, partitioning the disk, deciding what the host OS owns vs what gets virtualized.

## Guides

- [`bare-metal-setup.md`](bare-metal-setup.md) - choosing hardware, OS install, baseline tuning for an always-on agent host
- [`disk-layout-lvm.md`](disk-layout-lvm.md) - two-disk LVM design that survives "I need to grow this" without a reinstall
- [`kernel-tuning.md`](kernel-tuning.md) - sysctl, swap behavior, scheduler choices, per-user limits

> Per-guide format: [`../automation/cron-patterns.md`](../automation/cron-patterns.md). All three guides verified on the production host.
