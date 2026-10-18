# Kernel Tuning for an Always-On AI Host

> Two sysctl files, a 16 GB swap file, and a handful of defaults left alone on purpose. This guide documents what the production host actually runs, not a tuning wishlist. A short optional section at the end covers knobs I looked at and did not apply.

Last updated: 2026-10-17. Tested on Ubuntu 24.04.5 LTS, OEM kernel 6.17.0-1033-oem, 24-core Intel Core Ultra 9 285, 62 GiB RAM, two 1 TB NVMe drives.

## What this is

The kernel settings on one box that runs an agent stack, browser automation, local LLMs, a desktop, and a few dozen long-lived services. Everything below was read from the live host with `sysctl`, `swapon`, `/sys`, and `/etc/sysctl.d/`. The goal is a host that stays responsive when the browser is loaded, a model is streaming, and a backup is in flight.

## Why this way

The Ubuntu defaults are already sensible for a 64 GB desktop-class machine on a current kernel. The host overrides only what caused a real failure or a measurable annoyance:

1. **Swap eagerness.** With tens of GB free, the default `vm.swappiness=60` still pushed process pages out. Dropping it to 10 stopped that.
2. **Inotify exhaustion.** Electron apps, editors, file watchers, and local services share one per-user pool. The stock limits ran out on large repos.
3. **Fork failures despite free RAM.** Processes with big virtual address spaces (VMs, browsers, model runtimes) pushed `Committed_AS` far past `CommitLimit`, and `fork()` returned `EAGAIN` with gigabytes free. `vm.overcommit_memory=1` fixed it.

Everything else (dirty-page ratios, socket buffers, congestion control, watermark scale, CPU governor, THP, I/O scheduler) is at the distro default, and I have not found a reason to change any of it.

## Prerequisites

- A current kernel (6.x or newer)
- 32 GB+ RAM. The swap and overcommit choices below assume memory is plentiful
- NVMe primary storage
- Root access via sudo

## Before / After

**Before:** `vm.swappiness=60`, default inotify limits, default overcommit heuristic. The kernel swapped with tens of GB free, file watchers ran out on large repos, and a big-VM `fork()` failed with `EAGAIN` while `free` showed plenty of memory.

**After:** swappiness 10, a 524288-watch inotify pool, and `vm.overcommit_memory=1`. Swap sits at a few GB used out of 16 GB, watchers survive the largest repo, and the fork failures stopped.

## Implementation

### What runs on the host

Two local files under `/etc/sysctl.d/` carry every override. The numeric prefix `99-` puts them after the distro defaults (`10-*`), which also set `vm.max_map_count` and the `fq_codel` qdisc.

The memory file (named by host and purpose, so I describe it by content here):

```bash
sudo tee /etc/sysctl.d/99-memory.conf <<'EOF'
# Fix fork() EAGAIN on big-VM processes despite free RAM (Committed_AS >> CommitLimit)
vm.overcommit_memory = 1
# Stop needless swapping with tens of GB free
vm.swappiness = 10
EOF
```

The inotify file:

```bash
sudo tee /etc/sysctl.d/99-inotify-capacity.conf <<'EOF'
# File-watching capacity for Electron applications and local development services.
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
fs.inotify.max_queued_events = 32768
EOF

sudo sysctl --system
```

Live values after `sysctl --system`:

| Knob | Value | Source |
|------|-------|--------|
| `vm.swappiness` | 10 | local memory file |
| `vm.overcommit_memory` | 1 | local memory file |
| `fs.inotify.max_user_watches` | 524288 | local inotify file |
| `fs.inotify.max_user_instances` | 1024 | local inotify file |
| `fs.inotify.max_queued_events` | 32768 | local inotify file |
| `vm.max_map_count` | 1048576 | Ubuntu default (`10-map-count.conf`) |
| `vm.vfs_cache_pressure` | 100 | kernel default |
| `vm.dirty_background_ratio` / `vm.dirty_ratio` | 10 / 20 | kernel default |
| `vm.watermark_scale_factor` | 10 | kernel default |
| `net.ipv4.tcp_congestion_control` | `cubic` | kernel default |
| `net.core.default_qdisc` | `fq_codel` | Ubuntu default (`10-bufferbloat.conf`) |
| `net.core.rmem_max` / `wmem_max` | 212992 | kernel default |

### Swap policy

Swap is a 16 GB file at the top of the large home logical volume (`$SWAPFILE` below, a `swap.img` in that volume's mount point), not the installer's default `/swap.img` on the root filesystem. On a typical day a few GB of it is in use even with tens of GB of RAM free, which is expected with `swappiness=10`: cold pages leave, hot ones stay.

```bash
SWAPFILE=$(swapon --show=NAME --noheadings | head -1)   # the active swap file
swapon --show
# NAME           TYPE SIZE USED PRIO
# $SWAPFILE file  16G 4.9G   -2

findmnt -no FSTYPE -T "$SWAPFILE"      # ext4
grep swap /etc/fstab                     # $SWAPFILE none swap sw 0 0
```

The file lives on the ext4 home volume (see [`disk-layout-lvm.md`](disk-layout-lvm.md)), which keeps the 100 GB root partition from filling. Hibernate is masked on this host, so the file does not need to be contiguous or sized for a RAM image (see [`bare-metal-setup.md`](bare-metal-setup.md)). If swap usage sits above half of 16 GB for days, the answer is a closer look at what is resident, or more RAM, not a bigger file.

### I/O scheduler

Both NVMe drives use `none`, the kernel default for multi-queue NVMe. `mq-deadline` is listed as an alternative and is not selected. I did not try BFQ.

```bash
for d in /sys/block/nvme*/queue/scheduler; do
  echo "$d: $(cat "$d")"
done
# /sys/block/nvme0n1/queue/scheduler: [none] mq-deadline
# /sys/block/nvme1n1/queue/scheduler: [none] mq-deadline
```

### Transparent huge pages

THP is at the default: `enabled` is `madvise`, `defrag` is `madvise`. Only applications that ask for huge pages get them, and direct compaction only stalls those callers. Nothing on this host needed THP turned off.

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled   # always [madvise] never
cat /sys/kernel/mm/transparent_hugepage/defrag    # always defer defer+madvise [madvise] never
```

### CPU governor

The CPU runs the `intel_pstate` driver in `active` mode with the `powersave` governor. With hardware-managed P-states (HWP), `powersave` on this driver scales frequency on demand and is not the low-clock mode the name suggests. I have not locked it to `performance`: the agent workload waits on network and model latency, so a pinned clock buys idle power draw and fan noise.

```bash
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver     # intel_pstate
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor   # powersave
cat /sys/devices/system/cpu/intel_pstate/status             # active
```

### Per-user resource limits

No custom `limits.d` or `system.conf.d` files exist on this host. Open-file limits come from systemd's own defaults:

```bash
systemctl show -p DefaultLimitNOFILE   # DefaultLimitNOFILE=524288
ulimit -n                               # 1048576 (soft)
ulimit -Hn                              # 1048576 (hard)
```

The only drop-ins in `/etc/security/limits.d/` are from packages (a game-mode helper and PipeWire real-time limits). The old advice to add `/etc/security/limits.d/` and `system.conf.d` overrides is unnecessary on a current Ubuntu with systemd. If a particular service hits `EMFILE`, raise `LimitNOFILE=` in that unit instead of changing the global default.

### Optional tuning not applied here

These are values from the usual tuning advice. I have no measurement on this host that justifies them, so none are set. Treat them as starting points to test on your own workload, not recommendations.

```ini
# NOT APPLIED on the reference host.
# Smoother writeback on fast NVMe: start background flush earlier.
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10

# Keep inode/dentry caches hotter than page cache.
vm.vfs_cache_pressure = 50

# Larger socket buffers for bulk transfers over fast links.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

# BBR with fq. Matters on long-haul links, not on a LAN.
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
```

The dirty-page ratios are the likeliest to help if you see multi-second `await` spikes in `iostat` during backups. Benchmark them against "is the desktop responsive while a backup runs?", not `dd` throughput. BBR needs the `tcp_bbr` module available and only pays off when the path has real latency.

## Verification

Every line below passes on the reference host as written:

```bash
# Swap policy and overcommit.
sysctl vm.swappiness | grep -q '= 10' && echo OK
sysctl vm.overcommit_memory | grep -q '= 1' && echo OK

# Inotify ceiling.
sysctl fs.inotify.max_user_watches | awk '$3>=524288 {print "OK"}'

# Swap is a file on ext4 and is active.
SWAPFILE=$(swapon --show=NAME --noheadings | head -1)
findmnt -no FSTYPE -T "$SWAPFILE" | grep -q ext4 && echo OK

# Per-user fd limit.
[ "$(ulimit -n)" -ge 65536 ] && echo OK

# No third-party I/O scheduler is in the way.
grep -q '\[none\]' /sys/block/nvme0n1/queue/scheduler && echo OK

# THP is at the default.
grep -q '\[madvise\]' /sys/kernel/mm/transparent_hugepage/enabled && echo OK

# Governor is the intel_pstate default.
grep -q powersave /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor && echo OK
```

Real-world sanity check: run a backup while opening a browser tab. Neither should stutter.

## Gotchas

**Setting `vm.swappiness=0` looks aggressive and breaks OOM behavior.** Zero tells the kernel to never swap process pages, even when reclaim is failing, so the OOM killer fires earlier than you want. Use 10, not 0.

**`vm.overcommit_memory=1` trades safety for fewer spurious failures.** It never refuses an allocation up front, so a genuine memory leak ends in the OOM killer instead of a clean `ENOMEM`. I accepted that because the alternative was `fork()` failing with free RAM. If you do not run big-VM or browser-heavy processes, leave the default heuristic.

**`fs.inotify.max_user_watches` is per-user, not per-process.** If the agent, the desktop, and a container all share one UID, they share one pool. Each gets less than you raised it to. Run them under different users if you keep bumping the limit.

**The swap file is not where the installer puts it.** A stock Ubuntu install creates `/swap.img` on the root filesystem. This host keeps swap on the home volume. If you copy this layout, update `/etc/fstab` and run `swapoff` on any old file before deleting it.

**`powersave` on `intel_pstate` is not slow.** With HWP the governor name is misleading. Check `cpupower frequency-info` or the live MHz before assuming the CPU is throttled.

**Tuned, ananicy, irqbalance, and similar daemons fight your sysctl files.** None of them run on this host (`systemctl is-active` reports inactive). Install one or zero, not several. Each ships its own opinions about swappiness and dirty ratios.

**An earlier version of this guide recommended values the host never used.** It listed bbr/fq, dirty ratios of 5/10, 16 MiB socket buffers, and `watermark_scale_factor=200`, plus `limits.d` and `system.conf.d` overrides. None of those were ever applied here, which is why they now live only in the optional section above.

## Templates

This guide does not ship a template. The two inline sysctl files above are the template. Pair with:

- [`../security/linux-hardening.md`](../security/linux-hardening.md) for the security-side `/etc/sysctl.d/` knobs (rp_filter, accept_redirects, etc.)

## Related

- [`bare-metal-setup.md`](bare-metal-setup.md) for the hardware choices that make this tuning matter
- [`disk-layout-lvm.md`](disk-layout-lvm.md) for the storage layout the swap file and dirty-page behavior sit on
- [`../security/linux-hardening.md`](../security/linux-hardening.md) for network-security sysctl knobs, complementary to these
