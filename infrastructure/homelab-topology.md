# Homelab Topology: The Map

This is the floor plan of my homelab. One hypervisor, a pile of LXC containers, two VMs, and a backup server that lives on the same box it protects. It covers what runs where, how I split LXC versus VM, how RAM and disk are carved up, the network shape, and how off-host backup wires in. 🦞

If you want the *why* behind one-service-per-container and the throwaway build-container pattern (now retired, see below), that's a separate guide: [`service-isolation.md`](service-isolation.md). This one is the map, not the manifesto.

**Tested on:** Proxmox VE 9.2 (pve-manager 9.2.21 as reported by the API), Intel Core Ultra 9 285 (24 threads), 32GB RAM, ~954GB NVMe, a 16GB workstation GPU. Single node, no cluster.
**Last updated:** 2026-10-17

---

## The Shape

One physical node. Everything is a guest on it. There is no separate NAS box running compute, no second hypervisor in this lab, no Kubernetes. The host does exactly one job: run guests and back them up. All service logic lives inside containers and VMs, never on the host itself.

```
Hypervisor (PVE 9.2, 24 threads, ~31GiB usable RAM, ~954GB NVMe)
│
├── LXC containers (15, all running, one service each, unprivileged except PBS)
│     ├── 100  DNS filter              DNS ad-blocking
│     ├── 101  zero-trust connector    outbound-only remote access
│     ├── 102  comics / ebook library  read-only mounts from the Windows desktop
│     ├── 103  manga downloader        writes to a share on the Windows desktop
│     ├── 104  game library            ROM library with a 100G data volume
│     ├── 105  SIEM                    security monitoring (the RAM and disk hog)
│     ├── 106  manga downloader        second instance with a different library
│     ├── 107  dashboard               service launcher / status page
│     ├── 108  fleet hub               Brigade fleet coordination hub
│     ├── 109  automation              n8n + Postiz publishing stack
│     ├── 111  photo library           Immich
│     ├── 116  network monitoring      LibreNMS
│     ├── 118  DNS sync sidecar        keeps the second DNS instance in step
│     ├── 120  CI runner               GitHub Actions runner for the SOC stack
│     └── 121  PBS                     Proxmox Backup Server (privileged)
│
└── VMs (the exception, both running)
      ├── 110  full desktop VM         a peer's separate OS, managed independently
      └── 130  agent worker VM         Brigade worker that needs a full OS
```

The old ephemeral tier of stopped build and smoke-test containers is gone. See [The Ephemeral Tier (Retired)](#the-ephemeral-tier-retired).

The persistent tier is fifteen always-on containers and two VMs. Nothing sits stopped on a shelf anymore.

## LXC by Default, VM by Exception

The single biggest decision in this lab is **LXC unless you have a concrete reason for a VM**, and I land on LXC the overwhelming majority of the time.

LXC containers share the host kernel. That makes them cheap: a DNS blocker idles at 512MB RAM, boots in under a second, and adds essentially zero virtualization overhead. On a 32GB box that frugality is the whole game. I can run fifteen containers plus two VMs because each container only costs what it actually uses.

I reach for a full VM only when one of these is true:

- **The workload needs a real kernel of its own.** Custom modules, a different kernel version, or anything that pokes at kernel internals an LXC can't.
- **The workload needs a genuine desktop session or its own full OS.** That is why VM 110 exists: it is one full OS install that is managed independently, so it gets 8 cores, 8GB RAM, and a 300GB disk. That one guest holds as much RAM as my four heaviest containers combined, which is precisely why it is the exception and not the rule. VM 130 is a worker VM for agent jobs that want a whole machine (4 cores, 6GB, 64GB disk).
- **Hard isolation matters more than density.** A VM has its own kernel, so a container-escape class of bug doesn't apply. For most home services that tradeoff isn't worth the RAM, but it's a real reason when it's a real reason.

If none of those hold, it's a container. The default is not a coin flip, it's a strong prior.

### Privileged vs Unprivileged

Inside the LXC tier there's a second split. Fourteen of fifteen containers run **unprivileged** (`unprivileged: 1`), which maps container root to an unprivileged host UID. That's the safe default and where every normal service lives.

The exception is the backup server (CT 121), which runs **privileged** with `nesting=1`. It needs to `chown` chunk files to the backup user (UID 34) and, during its original design phase, needed to mount network shares. An unprivileged container can't do that UID remap cleanly. So PBS gets privileged, and in exchange I keep its attack surface tiny: it talks to the backup datastore and nothing else. Privileged is a deliberate, documented exception for exactly one container, not a convenience I hand out.

Most containers carry `features: nesting=1,keyctl=1` so Docker-in-LXC works for the services that ship as compose stacks (the automation and photo stacks both run Docker inside their LXC). The fleet hub runs with `nesting=0` because it does not run containers, and it gets `/dev/net/tun` passed through for its overlay-network daemon.

## Container Inventory and Roles

Always-on containers with their configured allocations (from `pct config`, read 2026-10-17):

| CTID | Role | Cores | RAM | Disk | Priv | Notes |
|------|------|-------|-----|------|------|-------|
| 100 | DNS filter | 1 | 512MB | 16G | unpriv | Tiny, always on, first line of the network |
| 101 | Zero-trust connector | 1 | 1GB | 3G | unpriv | Outbound tunnel connector, no inbound ports |
| 102 | Comics / ebook library | 2 | 1GB | 16G | unpriv | Library shares bind-mounted read-only |
| 103 | Manga downloader | 2 | 2GB | 16G | unpriv | Writes to a bind-mounted share |
| 104 | Game library | 2 | 2GB | 30G + 100G | unpriv | Separate 100G library volume, excluded from backup |
| 105 | SIEM | 4 | 8GB | 100G | unpriv | The RAM and disk hog, security stack |
| 106 | Manga downloader | 2 | 2GB | 16G | unpriv | Second instance, separate library |
| 107 | Dashboard | 2 | 2GB | 8G | unpriv | Service launcher |
| 108 | Fleet hub | 1 | 512MB | 4G | unpriv | Coordination hub, reachable only over the overlay network |
| 109 | Automation | 2 | 3GB | 64G | unpriv | n8n + Postiz, Docker compose inside, 2GB swap |
| 111 | Photo library | 4 | 4GB | 32G | unpriv | Immich, Docker compose, ML container, NAS bind-mount |
| 116 | Network monitoring | 4 | 4GB | 32G | unpriv | LibreNMS, `firewall=1` on the NIC |
| 118 | DNS sync sidecar | 1 | 256MB | 4G | unpriv | Smallest guest in the lab |
| 120 | CI runner | 2 | 4GB | 30G | unpriv | Self-hosted runner, `onboot` off |
| 121 | Backup server | 2 | 4GB | 16G | **priv** | PBS, datastore bind-mounted from the host |

VMs:

| VMID | Role | Cores | RAM | Disk | Notes |
|------|------|-------|-----|------|-------|
| 110 | Full desktop VM | 8 | 8GB | 300G | An independently managed desktop VM, hands off during host maintenance |
| 130 | Agent worker VM | 4 | 6GB | 64G | Runs Brigade worker jobs |

A few principles fall out of this table:

- **Size to the actual job.** The DNS sync sidecar gets 256MB because that's all it ever touches. The SIEM gets 8GB because it genuinely needs it. The automation CT was 12GB in June and is now 3GB with 2GB of swap. Uniform "2GB to be safe" allocations are how you run out of RAM on a 32GB box.
- **One service per container.** Each row is a single logical service (or a single Docker compose stack that *is* that service). The reasoning lives in [`service-isolation.md`](service-isolation.md).
- **The sidecar pattern is allowed.** CT 118 (DNS sync) is a companion to CT 100 (DNS), split out so the sync daemon's failures can't take DNS resolution down with them.
- **Bind-mounts are part of the blast radius.** The library containers and the photo CT mount shares from the host (a NAS and the Windows desktop). Those mounts are read-only where the container does not need to write.

### The Ephemeral Tier (Retired)

This lab used to keep a tier of build and smoke-test sandboxes (clean-room OSS PR builds, an MCP smoke container, a QEMU smoke template) that sat stopped until a job needed them. Those containers were destroyed in a September 2026 cleanup, and three of the freed IDs now belong to the library containers. A stopped container still holds its disk on the thin pool, which matters now that the pool is two-thirds full. The retired pattern is described as history in [`service-isolation.md`](service-isolation.md). The one survivor from that era is the CI runner (CT 120), which is now an ordinary long-lived container.

## Resource Allocation Reality

The guests request more RAM on paper than the host physically has, and that's fine because they don't all peak at once. But "fine" has a ceiling, and I've hit it.

The configured RAM for the 15 containers sums to about 38GB, and the two VMs add 14GB more, so roughly 52GB is promised against about 31GiB usable after the hypervisor takes its cut. On 2026-10-17 the node reported about 23GiB in use of 31GiB. That leaves headroom for the always-on tier and not much else. The SIEM (8GB), the automation stack, and the photo stack carry most of the real usage.

The lesson I keep relearning: **on a single 32GB node, RAM is the binding constraint, not CPU and not disk.** The Ultra 9 has 24 threads and the node idles at about 5% CPU. Disk is no longer comfortable either: the 816GiB LVM-thin pool is 69% used (it was 37% in June), mostly VM 110's 300GB disk, the game library, and the SIEM. RAM is still the thing I plan around, and disk is the next one to watch. Every time I add a service I ask "what does this push us to at peak?" before I ask anything else.

Storage layout on the node (from `pvesm status`):

| Storage | Type | Role |
|---------|------|------|
| `local` | dir | Host root, ISO/template storage (~94GiB, 41% used) |
| `local-lvm` | lvmthin | All container and VM root disks (~816GiB thin pool, 69% used) |
| `pbs-local-fast` | pbs | The backup datastore, registered as Proxmox storage (~245GiB, 72% used) |

Note the thin pool is over-committed (allocated volumes sum past physical size). That's normal for LVM-thin and works as long as actual usage stays under physical, but it means I watch the *pool* usage, not the sum of the disk sizes I handed out.

## Networking Shape

Flat and boring on purpose. All guests sit on a single Linux bridge (`vmbr0`) on the LAN. Most containers take **DHCP** and register a hostname. I don't hand-assign IPs unless a service needs a stable address.

The guests that break that pattern do it for a reason:

- **The backup server (CT 121)** gets a **static IP** and `firewall=1` on its NIC, because backup jobs and the PBS web UI need a predictable address that doesn't move on a lease renewal. The library containers (102, 103, 104, 106) also use static addresses so other tools can find them.
- **The zero-trust connector (CT 101)** is the only path for remote access to the LAN. It dials *out* to a zero-trust mesh, so there are no inbound port-forwards on the router. Nothing in this lab is exposed to the internet directly. Remote access rides the connector or it doesn't happen. The fleet hub (CT 108) listens only on the overlay network.

DNS for the LAN runs inside the lab itself (CT 100, with CT 118 keeping a second instance in sync). A second filter instance runs on separate hardware, which softens the old problem: the primary resolver is a guest on the box, so if the host is down, that instance is down too. For a home lab that's an acceptable circular dependency, but it's worth knowing it exists. See [`adguard-dns-sinkhole.md`](adguard-dns-sinkhole.md).

## How Backup Wires In

Backup is not bolted on from outside. It is a first-class guest. **Proxmox Backup Server runs as CT 121 on the same node it protects.** That sounds like putting the lifeboat on the ship, and it would be a problem if PBS were the *only* copy. The design is one fast local tier plus off-host mirrors:

1. **Local PBS datastore.** One scheduled `vzdump` job (`daily-prod`, 02:00, snapshot mode, zstd) writes to `pbs-local-fast`. It covers 12 guests: the DNS pair, the connector, the SIEM, the dashboard, the hub, the automation and photo stacks, network monitoring, the CI runner, the game library CT, and VM 110. It skips the media downloaders, the worker VM (both rebuildable), and PBS itself. PBS does content-addressed chunk dedup, so a daily backup only writes the chunks that actually changed. The datastore lives on its own host volume, bind-mounted into the PBS container, so a full datastore cannot starve the thin pool that holds guest disks. Restores are fast because the data is local.
2. **NAS mirror**, weekly. The datastore is rsynced to a CIFS-mounted NAS share. Because PBS chunk filenames are content hashes, unchanged chunks have unchanged names and mtimes, so rsync ships only what changed.
3. **Cloud mirror**, weekly, **currently disabled.** An rclone sync from CT 121 to cloud object storage ran until 2026-08-19, when the shared OAuth client hit its API quota. The timer stays off until the job moves to a private client ID and a full manual sync finishes clean. Until then the cloud tier does not exist, and the NAS copy is the only off-host tier.

So the on-node PBS is the fast tier, and the NAS copy is the "the whole node caught fire" tier. If the hypervisor dies, the backups survive on one independent off-host location, which is one fewer than I designed for. The full restore mechanics and the restic-based backup of the *agent host* (a separate machine) live in [`backup-recovery.md`](backup-recovery.md). The datastore itself ran past 90% in early September, so I watch its usage with the same attention as the thin pool.

### The PBS Deployment That Taught Me Something

The original plan was to put the PBS datastore directly on an NFS export from the NAS, so backups landed off-host immediately with no mirror step. It did not work, and the failure was instructive.

PBS writes a chunk to a temp file and then atomically renames it into place. The NAS is a consumer 2-bay unit with 2016-era firmware, and its NFS server could not commit that write-then-rename pattern reliably. First I got stale `readdir` results (`mkstemp ... failed: ENOENT`), which I beat back with aggressive cache-disabling mount options (`lookupcache=none,acdirmin=0,acdirmax=0`). But even with caching off, the atomic rename itself failed: `Atomic rename failed ... No such file or directory`. The chunk write would land, the rename would not commit through the NFS server's metadata layer, and the backup aborted.

There was no mount option that fixed the rename. The constraint was the appliance firmware, not my config. Two more sharp edges along the way: creating the chunkstore over NFS took ~25 minutes because PBS makes 65,536 subdirectories and each `mkdir` round-trips to the NAS at ~33/sec, and the NAS's "Guest Permission: Forced" setting mapped every write to `nobody`, so PBS's `chown 34:34` on chunk files failed with `EPERM`.

So I abandoned NFS-as-datastore entirely. The working design is the one above: **local LVM datastore, weekly rsync to the NAS over CIFS.** I gave up "instantly off-host" and got back atomic renames, fast chunkstore creation, and dedup that carries through to the mirror for free. The takeaway: a backup target has to honor the write semantics your backup tool assumes. PBS assumes atomic rename. Verify your storage actually provides it before you build on it, and don't fight appliance firmware you can't change.

## Verification

Quick read of the whole topology from the node (all read-only):

```bash
# What's running, both kinds. CTIDs and VMIDs share one number pool,
# so always check BOTH before assuming an ID is free or missing.
ssh <hypervisor> "pct list"      # LXC containers only (expect 15, all running)
ssh <hypervisor> "qm list"       # VMs only (expect 2)

# Per-guest config (RAM, cores, disk, priv flag, network)
ssh <hypervisor> "pct config 105"

# Proxmox version
ssh <hypervisor> "pveversion"

# Storage pools and headroom
ssh <hypervisor> "pvesm status"

# Scheduled backup jobs
ssh <hypervisor> "pvesh get /cluster/backup --output-format json-pretty"

# Live RAM pressure on the node, the constraint that actually matters
ssh <hypervisor> "free -h"

# Confirm the backup server is up and its datastore is mounted
ssh <hypervisor> "pct exec 121 -- proxmox-backup-manager datastore list"
```

If `pct list` shows a guest you expected and `qm list` shows another, that's not a bug: LXC and VM share the ID pool, so a VM at 110 happily coexists with containers at 109 and 111.

## Gotchas

1. **`pct list` and `qm list` are two different worlds.** Containers and VMs share one CTID/VMID number pool but show up in different commands. Check both before creating an ID or declaring one missing. I have absolutely confused myself by running only `pct list` and concluding a guest didn't exist when it was a VM.

2. **RAM is the budget, not CPU.** On a 32GB node the host gives you ~31GiB usable, and real usage sits near 23GiB with everything warm. Plan additions against peak RAM. The 24-thread CPU is never the limit. Disk is now the second constraint.

3. **Privileged containers are an exception you justify, not a default.** Only the backup server runs privileged, because it needs UID-remapped `chown` on chunk files. Everything else is unprivileged. If you find yourself making a container privileged "to make it work," figure out the actual capability you need first.

4. **Destroyed IDs get reused.** After the September cleanup, three freed container IDs were handed to new library containers. Notes, dashboards, and backup selections that reference an ID by number will quietly point at a different service. Re-check ID-based references after any cleanup.

5. **The thin pool is over-committed by design.** Allocated disk sizes sum past physical capacity. That's fine for LVM-thin as long as *actual* usage stays under physical, but it means you monitor pool usage (`pvesm status`), not the arithmetic sum of disk sizes you handed out. Tune `thin_pool_autoextend_threshold` so the pool warns before it fills.

6. **DNS lives inside the lab.** The primary resolver is a guest on the same host it serves. If the node is down, that resolver is down with it. A second instance on separate hardware catches most of it, but know the circular dependency is there before you debug a "the internet is broken" panic that's really "the hypervisor rebooted."

7. **Backup target write semantics matter more than backup target speed.** PBS assumes atomic rename. A consumer NAS over NFS couldn't deliver it, and no mount option fixed appliance firmware. Local datastore plus a weekly rsync mirror beat a clever-but-broken direct-to-NAS datastore. Match your storage to your backup tool's assumptions.

8. **A disabled mirror is a missing tier.** The cloud mirror timer has been off since 2026-08-19. A backup design with three copies on paper and two in practice should say so in the doc, and the doc should be updated when the third copy returns.

9. **One node has no failover.** This is a single hypervisor. If it dies, every service is down until it's back. The mitigation is not high availability (overkill for home), it's good off-host backups so a dead node is a restore, not a catastrophe. See [`backup-recovery.md`](backup-recovery.md).

## Related

- [`service-isolation.md`](service-isolation.md) - why one service per container, and the ephemeral build-container pattern
- [`backup-recovery.md`](backup-recovery.md) - restic backup of the agent host, restore procedures, disaster recovery
- [`openclaw-host-topology.md`](openclaw-host-topology.md) - the agent host that runs OpenClaw, a peer to this lab rather than a guest on it
