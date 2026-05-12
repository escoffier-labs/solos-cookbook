# Kernel Tuning for an Always-On AI Host

> Six sysctl knobs, one I/O scheduler decision, and a swap policy. Almost everything else the kernel ships with is fine. The defaults are tuned for "every workload," which means they are tuned for none.

## What this is

A small set of kernel knobs that matter for a host running an agent stack, browser automation, local LLMs, and a desktop, all on one box. Mostly memory and I/O. The goal is not maximum throughput on synthetic benchmarks; it is keeping the agent responsive when the browser is loaded, the model is streaming, and a backup is in flight.

## Why this way

The Linux kernel defaults are conservative for a reason: they target the median workload across desktops, servers, laptops, and embedded devices. For an always-on agent host with 64 GB of RAM and two fast NVMe drives, you can do better with five minutes of sysctl tuning than with any "performance" governor or third-party tool.

Three principles:

1. **Memory should be used, not hoarded.** With 64 GB and a workload that comfortably fits in 30, the default `vm.swappiness=60` is too eager to push process pages to swap. Lower it.
2. **Dirty-page writeback should be smooth, not bursty.** The default `vm.dirty_ratio=20` means up to ~12 GB of write cache before the kernel forces a flush. On modern NVMe, that turns into multi-second stalls.
3. **Inotify and file descriptors are the limits agents trip first.** Editors, file watchers, n8n, browsers, and the agent itself all consume the same inotify pool. Raise it once.

Everything else (CPU governor, NIC queues, transparent huge pages, BFQ vs none) is either already correct on a current kernel or has tradeoffs that are not worth the maintenance cost for a single-host setup.

## Prerequisites

- A current kernel (6.x or newer). Tuning advice for 5.x is similar but not identical
- 32 GB+ RAM (some advice below assumes RAM is plentiful)
- NVMe storage as primary disk; rotational disks invert several of the recommendations
- Root access via sudo

## Before / After

**Before:** `vm.swappiness=60`, `vm.dirty_ratio=20`, `fs.inotify.max_user_watches=65536`. The agent is happy until you launch a third browser tab and the desktop hitches. `iostat` shows multi-second `await` spikes during backups. VS Code occasionally drops file-watch on a large repo.

**After:** lower swap pressure, smoother writeback, larger inotify pool. The desktop stays responsive when the agent is busy. Backups do not stall foreground work. File watching survives the largest repo in the stack.

## Implementation

### The whole tuning file

Drop one file in `/etc/sysctl.d/`. Pick a number that puts it after distro defaults but before any local one-offs (so 90- is good).

```bash
sudo tee /etc/sysctl.d/90-agent-host.conf <<'EOF'
# --- Memory ---

# We have 64 GB and a working set that fits in <40. Don't aggressively swap.
vm.swappiness = 10

# Inode/dentry cache vs page cache balance. Default 100 evicts both equally.
# Agents read the same config files thousands of times - keep inodes hot.
vm.vfs_cache_pressure = 50

# Background writeback at 5% (~3.2 GB on 64 GB RAM), hard flush at 10%.
# Default 10/20 buffers too much for NVMe and causes multi-second stalls.
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10

# Reclaim policy: don't let kswapd thrash on a host that mostly fits.
vm.watermark_scale_factor = 200

# --- File watchers and descriptors ---

# Editors, browsers, n8n, agents all pull from this pool.
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
fs.inotify.max_queued_events = 65536

# File descriptor limit ceiling. Per-process limit is set in limits.conf.
fs.file-max = 2097152

# --- Network (modest, only what matters for agent + local services) ---

# Bigger socket buffers help SSH bulk transfers and rclone bisync.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

# BBR congestion control is materially better on long-haul links.
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
EOF

sudo sysctl --system
```

Verify it took:

```bash
sysctl vm.swappiness vm.dirty_ratio fs.inotify.max_user_watches net.ipv4.tcp_congestion_control
```

### Swap policy

The Ubuntu installer creates `/swap.img` at boot, sized small (2-8 GiB). With 64 GB of RAM and `vm.swappiness=10`, that is fine. Do not size swap to "twice RAM" - that advice predates the SSD era and was for hibernate, which you are not using on this host (see [`bare-metal-setup.md`](bare-metal-setup.md)).

Keep the swap file, but make sure:

```bash
# Swap is on, file-backed, small.
swapon --show

# It is not on a slow filesystem.
findmnt -no FSTYPE -T /swap.img    # should be ext4 on the OS partition
```

If swap usage creeps above ~50 % consistently, the answer is more RAM, not more swap.

### I/O scheduler

Modern NVMe drives run faster than any scheduler can be smart about. The current kernel defaults to `none` (multi-queue, no scheduler) on NVMe and `mq-deadline` on rotational. Both are correct. Do not switch to BFQ on NVMe - it adds latency without adding fairness in any way you will notice.

Check:

```bash
for d in /sys/block/nvme*/queue/scheduler; do
  echo "$d: $(cat "$d")"
done
```

Expected: `[none]` on each NVMe device.

### Transparent huge pages

Default is `madvise` on modern kernels. Leave it. The advice to set THP to `never` is from the Postgres / MongoDB world where THP defragmentation costs visible latency. The agent stack does not have that profile.

Verify:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
```

Expected: `always madvise [never]` is fine, `always [madvise] never` is fine, do not change it.

### CPU governor

On a desktop class CPU running an interactive workload, the `schedutil` (or `intel_pstate` powersave with HWP) defaults are correct. Do not lock the governor to `performance`:

- It pegs CPU frequency, raising idle power draw and fan noise.
- It does not measurably help an LLM-bound workload because the wait is on the network, not the CPU.
- It interacts badly with thermal throttling on small-form-factor cases.

Verify:

```bash
cpupower frequency-info | grep -E 'driver|governor'
```

Expected: driver is `intel_pstate` (or `amd-pstate`), governor is `powersave` or `schedutil`.

### Per-user resource limits

The systemd default for per-user open files is 1024 soft / 4096 hard. The agent will trip this the first time it watches a large repo with many file handles. Bump it:

```bash
sudo tee /etc/security/limits.d/90-agent.conf <<'EOF'
*  soft  nofile  65536
*  hard  nofile  1048576
*  soft  nproc   32768
*  hard  nproc   65536
EOF

# Plus systemd's own ceiling for user services:
sudo mkdir -p /etc/systemd/system.conf.d
sudo tee /etc/systemd/system.conf.d/90-agent.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=65536:1048576
DefaultLimitNPROC=32768:65536
EOF

sudo systemctl daemon-reexec
```

Log out and back in for `limits.conf` to apply.

## Verification

```bash
# Swap policy.
sysctl vm.swappiness | grep -q '= 10' && echo OK
sysctl vm.dirty_ratio | grep -q '= 10' && echo OK

# Inotify ceiling.
sysctl fs.inotify.max_user_watches | awk '$3>=524288 {print "OK"}'

# Per-user fd limit.
ulimit -n     # >=65536

# BBR is on.
sysctl net.ipv4.tcp_congestion_control | grep -q bbr && echo OK

# No third-party I/O scheduler is in the way.
cat /sys/block/nvme0n1/queue/scheduler | grep -q '\[none\]' && echo OK
```

Real-world sanity check: run a backup while opening a browser tab. Neither should stutter.

## Gotchas

**Setting `vm.swappiness=0` looks aggressive and breaks OOM behavior.** Zero tells the kernel to never swap process pages, even when reclaim is failing. The OOM killer then fires earlier than you want. Use 10, not 0. The difference between 10 and 0 in practice is invisible; the difference in OOM behavior is not.

**`fs.inotify.max_user_watches` is per-user, not per-process.** If the agent user, the desktop user, and a docker container all share UID 1000 (which is a separate problem), they share the inotify pool. Each gets less than you raised it to. Run the agent and the desktop under different users if you find yourself bumping inotify limits weekly.

**Lowering `vm.dirty_ratio` increases sync I/O during heavy writes.** This is the point - smoother writeback, fewer multi-second stalls - but it shows up on synthetic write benchmarks as lower peak throughput. Do not benchmark this knob with `dd`; benchmark it with "is the desktop responsive while a backup runs?"

**BBR is great on long-haul, neutral on LAN.** Switching to BBR on a fully-LAN workload changes nothing measurable. Keep it on for the SSH-over-VPN case to a NAS or to a cloud backup target; it costs nothing to enable.

**`cpupower` setting the governor to `performance` will silently revert on suspend/resume on some firmware.** If you actually need `performance` (you do not), set it via a systemd service that re-applies on `resume.target`, not via `/etc/default/cpufrequtils`.

**Tuned, ananicy, irqbalance, and similar daemons fight your sysctl file.** Install one or zero of these, not several. Each one ships with its own opinions about swappiness and dirty ratios and will quietly override your settings on its own schedule.

**THP defrag set to `always` causes visible hitches on a heavy fork() workload.** The default is `madvise` and is correct. If you have ever seen a recommendation to set defrag to `always` for performance, ignore it.

## Templates

This guide does not ship a template; the inline sysctl file above is the template. Pair with:

- [`../security/linux-hardening.md`](../security/linux-hardening.md) - the security-side `/etc/sysctl.d/` knobs (rp_filter, accept_redirects, etc.)

## Related

- [`bare-metal-setup.md`](bare-metal-setup.md) - hardware choices that make this tuning matter
- [`disk-layout-lvm.md`](disk-layout-lvm.md) - the storage layout these dirty-page settings interact with
- [`../security/linux-hardening.md`](../security/linux-hardening.md) - sysctl knobs for network security, complementary to these performance knobs
