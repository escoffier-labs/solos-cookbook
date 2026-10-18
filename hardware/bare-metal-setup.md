# Bare-Metal Agent Host

Last updated: 2026-10-17. Tested on Ubuntu 24.04.5 LTS, OEM kernel 6.17.0-1033-oem, Intel Core Ultra 9 285, 62 GiB RAM, a 16 GB workstation GPU.

> The primary Linux box in the fleet, picked once, lives for years. Spec it for the workload that already gives you grief, not the workload you imagine you'll have someday.

## What this is

This is the physical layer behind the control side of the cookbook: a primary x86-64 box running Ubuntu Desktop as the host OS for an always-on multi-agent AI stack, browser automation, local LLMs, and the tools that coordinate a wider bare-metal fleet. Other machines can run OpenClaw nodes near their own tools and data, but this host keeps the canonical workspace. No virtualization at the host layer, no container OS, no remote bare metal for the agent brain. One control host, one disk pool, one user, one canonical workspace.

If you are deciding whether to host the control plane on a VPS, a NAS, or a Raspberry Pi cluster, read [`philosophy/why-one-host.md`](../philosophy/why-one-host.md) first. This guide assumes the decision is made.

## Why this way

Three things drive the spec:

1. **An agent stack is a latency game, not a throughput game.** Most of the wall-clock time the agent burns is waiting on a model. The model is usually remote. Your local machine's job is to be fast at the boring stuff: filesystem walks, JSON parsing, sqlite reads, sub-process spawn. A modern desktop CPU is more than enough. The bottleneck is single-thread responsiveness, not core count.

2. **Browser automation and local LLMs both want RAM.** A persistent Chromium with a few logged-in profiles, plus an Ollama model held in cache, plus the agent's working memory, plus the rest of the desktop will sit at 25-30 GB resident comfortably. 64 GB is the floor. 32 GB will work but you'll feel it the first time the agent tries to keep three browser sessions warm.

3. **Two SSDs in an LVM pool is the cheapest insurance you can buy.** One drive owns root, both drives feed the data pool. Lose one and you reinstall the OS, the data survives. See [`disk-layout-lvm.md`](disk-layout-lvm.md) for the full layout.

The temptation is to put this on a server in a closet. Resist it. A desktop with a monitor and a keyboard is recoverable when SSH is broken, and that matters once a year.

## Prerequisites

- Comfort with a clean Ubuntu install from a USB key
- Willingness to skip the installer's automatic LVM and partition by hand
- Ethernet, not Wi-Fi, for the primary connection
- An external USB drive for the first-pass backup before you trust anything

## Before / After

**Before:** the stack runs on a laptop, a VPS, or a NUC bought for something else. The CPU pegs during browser automation, the disk fills up because root and data are the same partition, and reboots are scheduled around when nobody needs the machine.

**After:** the control plane runs on one purpose-built box that wakes from suspend in two seconds, holds the agent and the browser and a local model all warm, and has separate disks for OS-recovery and data-survival. Other machines can still serve as OpenClaw nodes, homelab nodes, desktops, storage, and managed endpoints.

## Implementation

### Spec target

| Component | Target | Why |
|-----------|--------|-----|
| CPU | Recent desktop class, 16+ threads, P/E hybrid is fine | Single-thread responsiveness over core count |
| RAM | 64 GB DDR5 minimum | Browser + Ollama + agent + desktop |
| Primary storage | 1 TB NVMe, PCIe 4.0 or 5.0 | Hot disk for root + most data |
| Secondary storage | 1 TB NVMe, same generation | LVM extension, recovery margin |
| Network | Onboard 2.5 GbE | Skip the USB dongle drama |
| GPU | Integrated is enough for the agent. A discrete card is optional | The main models are remote. A discrete GPU only pays off for local inference, transcoding, or CUDA tooling |
| Case | Mid-tower with two M.2 slots and at least one 3.5" bay | Future external pool over USB or SATA |
| PSU | 80+ Gold, sized 2x peak load | The fan is silent when the load is half of rated |

Notes on real choices:

- The current build is an Intel Core Ultra 9 285 (24 cores, no SMT) with 64 GB DDR5 (62 GiB usable) and two 1 TB NVMe drives. A Ryzen 7/9 of the same generation works identically. Pick the platform with the better Linux firmware support in your region.
- The host also carries a discrete 16 GB workstation-class NVIDIA GPU (RTX 2000 Ada) next to the CPU's integrated graphics. It runs the NVIDIA open kernel modules (driver 595 series) from the OEM kernel's driver package. Nothing in the agent stack requires it, and no GPU process was running when I checked.
- **Do not over-spec the GPU.** Local LLMs through Ollama work on CPU for the tasks listed in [`ai-stack/local-llm-fallback.md`](../ai-stack/local-llm-fallback.md) (embeddings, commit drafts, triage). A discrete card adds heat, power draw, and driver upkeep. If you add one, a 16 GB workstation card is plenty for this workload. 70 B-class models do not fit and do not belong on the same host as your main agent.
- **Skip the consumer NAS appliance.** The home network already needs a separate NAS for cold backups (see [`infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md)). The agent host should not also try to be the NAS.

### Host OS

Ubuntu 24.04 LTS Desktop. Reasons:

- **Desktop, not Server.** A keyboard-and-monitor recovery path is worth more than the few hundred MB the desktop adds. Server installs cost you the first time the network is misconfigured.
- **LTS, not the latest interim release.** OpenClaw, ACPX, Ollama, and most of the MCP servers in this stack pin against the LTS-supported toolchain. Interim releases land kernel bumps that break OEM drivers.
- **Snap Firefox is the Ubuntu default and is still installed here.** Ubuntu's `firefox` package is a transitional stub that installs the Snap, and `apt purge firefox` removes that stub, not a separate deb. This host keeps the Snap build for desktop browsing. If your browser automation points Firefox at a persistent profile directory, test that path first, because Snap confinement can block access outside the user's home.

Install steps (single user, full encryption optional):

```bash
# After base install, before installing anything else:
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl jq ripgrep htop tmux \
                    nvme-cli smartmontools ufw fail2ban unattended-upgrades
```

Then install the OEM kernel for the hardware in question:

```bash
sudo apt install -y linux-oem-24.04d  # Or whichever OEM kernel ships current for your CPU generation
```

This host runs `linux-oem-24.04d`, which tracks the 6.17 OEM series.

The OEM kernel is the one that picks up new CPU power management, NIC drivers, and NVMe firmware features. The HWE kernel is the alternative if no OEM kernel ships for your platform. Pick one, do not stack both.

#### Pruning old OEM kernels

OEM kernels ship often and accumulate. Each install keeps the previous kernel as a fallback, and removed kernels leave behind package config (`rc` state in `dpkg -l`) and small stale directories under `/usr/lib/modules/`. On this host the running kernel and one fallback stay installed. Eight versions had accumulated, and six of them were already removed packages with leftover config and module directories. Root is a 100 GB partition, so installed kernels (about 200 MB of modules each, plus initrd images in `/boot`) add up.

```bash
# List installed and half-removed kernel packages.
dpkg -l 'linux-image-*' 'linux-modules-*' | awk '/^(ii|rc)/ {print $1, $2}'

# Remove old kernels you do not need (keeps the running one and the metapackage's current one).
sudo apt autoremove --purge -y

# Purge the config residue of already-removed kernels.
dpkg -l | awk '/^rc +linux-(image|modules|headers)/ {print $2}' | xargs -r sudo apt purge -y

# Check what remains.
ls /usr/lib/modules
```

Keep the running kernel and exactly one older one. Never purge the running kernel, and reboot into a new kernel before pruning the one you came from.

### User layout

One user, owned by the agent. Add the user that runs the agent service early, even if it is your own login:

```bash
sudo adduser agentuser
sudo usermod -aG sudo,docker,plugdev agentuser
sudo loginctl enable-linger agentuser   # User services start at boot, not at login
```

`enable-linger` is the part most guides skip and the reason the agent gateway doesn't start until you log in graphically. Without it, every reboot leaves the stack down until someone opens the desktop.

### Baseline tuning

Two cheap wins before anything stack-specific:

```bash
# Higher inotify limit - editors, file watchers, agents all share this pool.
sudo tee /etc/sysctl.d/99-inotify-capacity.conf <<'EOF'
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 1024
fs.inotify.max_queued_events = 32768
EOF

# Disable Ubuntu Pro nag and motd-news lookups.
sudo pro config set apt_news=false || true
sudo systemctl mask motd-news.service motd-news.timer || true

sudo sysctl --system
```

The rest of kernel tuning (swappiness, dirty-page ratios, scheduler choices) lives in [`kernel-tuning.md`](kernel-tuning.md).

### Power and sleep

The agent host should never suspend on its own.

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Then set screen blanking but not suspend in GNOME settings. The box stays on, the monitor turns off, the agent keeps running.

If the box is on a UPS, install `nut-client` or `apcupsd` and wire `shutdown` to fire on prolonged battery. Verify with a real pull of the wall plug before you trust it. Without that test, your "UPS-protected" host is one outage away from a hard crash.

## Verification

After the first install, the following should all be true:

```bash
# OEM kernel is running, not the generic.
uname -r | grep -E 'oem|hwe' && echo OK

# No more than two kernel images are installed.
[ "$(dpkg -l 'linux-image-[0-9]*' | grep -c '^ii')" -le 2 ] && echo OK

# Lingering is enabled for the agent user.
loginctl show-user agentuser --property=Linger | grep -q yes && echo OK

# Suspend is masked.
systemctl status sleep.target | grep -q "masked" && echo OK

# Inotify watch limit is high.
sysctl fs.inotify.max_user_watches | awk '$3>=524288 {print "OK"}'

# Both NVMe drives are visible and healthy.
sudo nvme list
sudo smartctl -a /dev/nvme0n1 | grep -i "Critical Warning"
sudo smartctl -a /dev/nvme1n1 | grep -i "Critical Warning"
```

A healthy box shows zero critical warnings, both drives present, the generic Ubuntu kernel replaced by an OEM kernel with at most one fallback, and the user that owns the agent stack able to keep user services running across reboot.

## Gotchas

**`apt purge firefox` does not get rid of the Snap Firefox.** On Ubuntu 24.04 the `firefox` deb is a stub that installs the Snap. Purging it and `snapd-desktop-integration` in the install script, as an earlier version of this guide did, does not leave you with a deb Firefox. This host still runs the Snap build (`snap list firefox`). If you need a non-Snap browser for automation, install one from a vendor repository on purpose and pin it with `apt preferences`. Snap's AppArmor confinement limits where the browser can write, so test any persistent profile path before you depend on it.

**Auto-installer LVM picks 100 GB for root and stops there.** The Ubuntu installer's default LVM layout reserves the whole disk to root, then resizes it down to 100 GB and leaves the rest unallocated for "future use." There is no future use. Partition by hand or follow [`disk-layout-lvm.md`](disk-layout-lvm.md) before you click install, or you will be `pvextend`-ing within a month.

**Hibernate corrupts the swap file the second time you upgrade the kernel.** The auto-installed `/swap.img` works for swap and fails for resume-from-hibernate the moment its physical block list changes. Disable hibernate (`sudo systemctl mask hibernate.target`) and use suspend-to-RAM only on machines that need it. The agent host should not be doing either.

**`linger` does not survive `userdel` and re-creation.** If you delete and re-add the agent user (for example, swapping UIDs to match a NAS export), you need to re-run `loginctl enable-linger`. The systemd state file under `/var/lib/systemd/linger/` does not get migrated.

**`unattended-upgrades` will reboot at 6 am unless you tell it not to.** The default Ubuntu config is fine for desktops, hostile for an always-on agent. Either set `Unattended-Upgrade::Automatic-Reboot "false";` in `/etc/apt/apt.conf.d/50unattended-upgrades` and run reboots from a maintenance window, or leave it on and accept the daily restart.

**OEM kernels are not picked by `do-release-upgrade`.** Major Ubuntu LTS upgrades fall back to the generic kernel and leave the OEM package in a half-installed state. Pin the OEM kernel via `apt-mark hold` before any release upgrade, and re-install the matching version for the new release manually.

## Templates

- [`../templates/bootstrap/`](../templates/bootstrap/) - the workspace files you will install after the host is up
- [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) - host-level scheduled work after the OS is in place

## Related

- [`disk-layout-lvm.md`](disk-layout-lvm.md) - LVM design that survives "I need to grow this"
- [`kernel-tuning.md`](kernel-tuning.md) - sysctl, swap, scheduler choices for an always-on AI host
- [`../security/linux-hardening.md`](../security/linux-hardening.md) - UFW, SSH hardening, fail2ban after the box is up
- [`../infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md) - what you back up once data starts to land
- [`../philosophy/why-one-host.md`](../philosophy/why-one-host.md) - the case for one canonical control host in a bare-metal fleet
