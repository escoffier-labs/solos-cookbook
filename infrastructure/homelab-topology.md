# Homelab Topology: The Map

This is the floor plan of my homelab. One hypervisor, a pile of LXC containers, a couple of VMs, and a backup server that lives on the same box it protects. It covers what runs where, how I split LXC versus VM, how RAM and disk are carved up, the network shape, and how off-host backup wires in. 🦞

If you want the *why* behind one-service-per-container and the throwaway build-container pattern, that's a separate guide: [`service-isolation.md`](service-isolation.md). This one is the map, not the manifesto.

**Tested on:** Proxmox VE 9.2.3, Intel Core Ultra 9 285 (24 threads), 32GB RAM, ~954GB NVMe, NVIDIA RTX Ada 2000 16GB. Single node, no cluster.
**Last updated:** 2026-06-04

---

## The Shape

One physical node. Everything is a guest on it. There is no separate NAS box running compute, no second hypervisor, no Kubernetes. The host does exactly one job: run guests and back them up. All service logic lives inside containers and VMs, never on the host itself.

```
Hypervisor (PVE 9.2.3, 24 threads, 30Gi usable RAM, ~954GB NVMe)
│
├── LXC containers (the default)   ── one service each, unprivileged where possible
│     ├── 100  adguard              DNS ad-blocking
│     ├── 101  twingate-connector   zero-trust network access
│     ├── 105  wazuh                SIEM / security monitoring
│     ├── 109  social-automation    n8n + Postiz publishing stack
│     ├── 111  immich               self-hosted photo backup
│     ├── 116  librenms             network monitoring
│     ├── 118  adguard-sync         DNS config sync sidecar
│     └── 121  pbs                  Proxmox Backup Server (privileged)
│
├── LXC containers (ephemeral, stopped)  ── spun up for a task, stopped after
│     ├── 112  *-prbuild            clean OSS build/test sandbox
│     ├── 113  *-prbuild            another build sandbox
│     ├── 115  mcp-smoke            MCP smoke-test sandbox
│     ├── 119  *-prbuild            build sandbox
│     └── 120  gh-runner            CI runner / SOC stack sandbox
│
└── VMs (the exception)
      ├── 110  full desktop VM      a workload that needs a real desktop session
      └── 103  qemu-smoke           stopped template / smoke-test VM
```

The persistent services are eight always-on containers. Everything else is either an on-demand sandbox that spends most of its life stopped, or one full VM that earns its weight by needing a real desktop.

## LXC by Default, VM by Exception

The single biggest decision in this lab is **LXC unless you have a concrete reason for a VM**, and I land on LXC the overwhelming majority of the time.

LXC containers share the host kernel. That makes them cheap: a DNS blocker idles at 512MB RAM and 8GB disk, boots in under a second, and adds essentially zero virtualization overhead. On a 32GB box, that frugality is the whole game. I can run eight persistent services plus a backup server and still keep build sandboxes on standby, because each container only costs what it actually uses.

I reach for a full VM only when one of these is true:

- **The workload needs a real kernel of its own.** Custom modules, a different kernel version, or anything that pokes at kernel internals an LXC can't.
- **The workload needs a genuine desktop session.** GUI apps, a windowing environment, a browser that expects a display. That is exactly why VM 110 exists: it is one full desktop VM for a workload that needs a real graphical session, so it gets 14GB RAM and a 200GB disk. That one guest costs roughly as much RAM as my four heaviest containers combined, which is precisely why it is the exception and not the rule.
- **Hard isolation matters more than density.** A VM has its own kernel, so a container-escape class of bug doesn't apply. For most home services that tradeoff isn't worth the RAM, but it's a real reason when it's a real reason.

If none of those hold, it's a container. The default is not a coin flip, it's a strong prior.

### Privileged vs Unprivileged

Inside the LXC tier there's a second split. Almost everything runs **unprivileged** (`unprivileged: 1`), which maps container root to an unprivileged host UID. That's the safe default and where every normal service lives.

The exception is the backup server (CT 121), which runs **privileged** with `nesting=1`. It needs to `chown` chunk files to the backup user (UID 34) and, during its original design phase, needed to mount network shares. An unprivileged container can't do that UID remap cleanly. So PBS gets privileged, and in exchange I keep its attack surface tiny: it talks to the backup datastore and nothing else. Privileged is a deliberate, documented exception for exactly one container, not a convenience I hand out.

Every container also carries `features: nesting=1,keyctl=1` so Docker-in-LXC works for the services that ship as compose stacks (the social-automation and photo-backup stacks both run Docker inside their LXC).

## Container Inventory and Roles

Persistent, always-on containers, with their real resource allocations:

| CTID | Role | Cores | RAM | Disk | Priv | Notes |
|------|------|-------|-----|------|------|-------|
| 100 | DNS ad-blocking | 1 | 512MB | 8G | unpriv | Tiny, always on, first line of the network |
| 101 | Zero-trust access | 1 | 1GB | 3G | unpriv | Outbound tunnel connector, no inbound ports |
| 105 | SIEM / monitoring | 4 | 8GB | 50G | unpriv | The RAM and disk hog; security stack |
| 109 | Social automation | 4 | 12GB | 64G | unpriv | n8n + Postiz, Docker compose inside |
| 111 | Photo backup | 4 | 4GB | 32G | unpriv | Immich, Docker compose, ML container |
| 116 | Network monitoring | 4 | 4GB | 32G | unpriv | LibreNMS |
| 118 | DNS sync sidecar | 1 | 256MB | 4G | unpriv | Smallest guest in the lab |
| 121 | Backup server | 2 | 4GB | 16G | **priv** | PBS, chunk store on bind-mounted datastore |

A few principles fall out of this table:

- **Size to the actual job.** The DNS sync sidecar gets 256MB because that's all it ever touches. The SIEM gets 8GB because it genuinely needs it. I don't hand out uniform "2GB to be safe" allocations; that's how you run out of RAM on a 32GB box.
- **One service per container.** Each row is a single logical service (or a single Docker compose stack that *is* that service). The reasoning lives in [`service-isolation.md`](service-isolation.md).
- **The sidecar pattern is allowed.** CT 118 (DNS sync) is a companion to CT 100 (DNS), split out so the sync daemon's failures can't take DNS resolution down with them.

### The Ephemeral Tier

CTIDs 112, 113, 115, 119, and 120 are build and smoke-test sandboxes. They spend nearly all their time **stopped**, consuming disk but zero RAM. I start one when I need a clean room to build an OSS pull request or smoke-test something, then stop it again. A stopped LXC costs nothing but a disk volume, which is exactly why this pattern is cheap enough to keep five of them around. Full treatment of the ephemeral build-container pattern is in [`service-isolation.md`](service-isolation.md).

## Resource Allocation Reality

The persistent services request more RAM on paper than the host physically has, and that's fine because they don't all peak at once. But "fine" has a ceiling, and I've hit it.

On a 32GB box you actually get about **30Gi usable** after the hypervisor takes its cut. With the SIEM (8GB), social-automation (12GB), and the photo stack (4GB) all warm, I've watched real usage climb to around **22Gi of 30Gi used**. That left enough headroom for the always-on tier but not much else, and it's the reason the build sandboxes are stop-on-demand rather than always running. If I left two 6GB prbuild containers running alongside everything else, the host would start swapping and the SIEM would be the first thing to feel it.

The lesson I keep relearning: **on a single 32GB node, RAM is the binding constraint, not CPU and not disk.** The Ultra 9 has 24 threads; I am nowhere near CPU-bound. Disk is a 816GB LVM-thin pool sitting around 37% used. RAM is the thing I plan around. Every time I add a service I ask "what does this push us to at peak?" before I ask anything else.

Storage layout on the node:

| Storage | Type | Role |
|---------|------|------|
| `local` | dir | Host root, ISO/template storage (~96GB) |
| `local-lvm` | lvmthin | All container and VM root disks (~816GB thin pool) |
| `pbs-local-fast` | pbs | The backup datastore, registered as Proxmox storage |

Note the thin pool is over-committed (allocated volumes sum past physical size). That's normal for LVM-thin and works as long as actual usage stays under physical, but it means I watch the *pool* usage, not the sum of the disk sizes I handed out.

## Networking Shape

Flat and boring on purpose. All guests sit on a single Linux bridge (`vmbr0`) on the LAN. Most containers take **DHCP** and register a hostname; I don't hand-assign IPs unless a service needs a stable address.

The two guests that break that pattern do it for a reason:

- **The backup server (CT 121)** gets a **static IP** and `firewall=1` on its NIC, because backup jobs and the PBS web UI need a predictable address that doesn't move on a lease renewal.
- **The zero-trust connector (CT 101)** is the only path for remote access. It dials *out* to a zero-trust mesh, so there are no inbound port-forwards on the router. Nothing in this lab is exposed to the internet directly; remote access rides the connector or it doesn't happen.

DNS for the LAN runs inside the lab itself (CT 100, with CT 118 keeping a second instance in sync). That's a mild bootstrap wrinkle: the thing resolving names is a guest on the box, so if the host is down, so is DNS. For a home lab that's an acceptable circular dependency, but it's worth knowing it exists.

## How Backup Wires In

Backup is not bolted on from outside; it's a first-class guest. **Proxmox Backup Server runs as CT 121 on the same node it protects.** That sounds like putting the lifeboat on the ship, and it would be a problem if PBS were the *only* copy. It isn't. The design is one fast local tier plus two off-host mirrors:

1. **Local PBS datastore** on the node's own LVM-thin pool. PBS does content-addressed chunk dedup, so a daily backup of all guests only writes the chunks that actually changed (a few GB a day, not a full image). Restores are fast because the data is local.
2. **NAS mirror**, weekly. The host rsyncs the datastore to a CIFS-mounted NAS share. Because PBS chunk filenames are content hashes, unchanged chunks have unchanged names and mtimes, so rsync ships only what changed.
3. **Cloud mirror**, weekly. CT 121 runs an rclone sync of the datastore to cloud object storage, throttled during the day and unleashed overnight.

So the on-node PBS is the fast tier, and the NAS plus cloud copies are the "the whole node caught fire" tier. If the hypervisor dies, the backups survive on two independent off-host locations. The full restore mechanics and the restic-based backup of the *agent host* (a separate machine) live in [`backup-recovery.md`](backup-recovery.md).

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
ssh <hypervisor> "pct list"      # LXC containers only
ssh <hypervisor> "qm list"       # VMs only

# Per-guest config (RAM, cores, disk, priv flag, network)
ssh <hypervisor> "pct config 105"

# Storage pools and headroom
ssh <hypervisor> "pvesm status"

# Live RAM pressure on the node, the constraint that actually matters
ssh <hypervisor> "free -h"

# Confirm the backup server is up and its datastore is mounted
ssh <hypervisor> "pct exec 121 -- proxmox-backup-manager datastore list"
```

If `pct list` shows a guest you expected and `qm list` shows another, that's not a bug: LXC and VM share the ID pool, so a VM at 110 happily coexists with containers at 109 and 111.

## Gotchas

1. **`pct list` and `qm list` are two different worlds.** Containers and VMs share one CTID/VMID number pool but show up in different commands. Check both before creating an ID or declaring one missing. I have absolutely confused myself by running only `pct list` and concluding a guest didn't exist when it was a VM.

2. **RAM is the budget, not CPU.** On a 32GB node the host gives you ~30Gi usable, and real peak usage hits ~22Gi with the heavy services warm. Plan additions against peak RAM. The 24-thread CPU and the 816GB disk pool are not what runs out first.

3. **Privileged containers are an exception you justify, not a default.** Only the backup server runs privileged, because it needs UID-remapped `chown` on chunk files. Everything else is unprivileged. If you find yourself making a container privileged "to make it work," figure out the actual capability you need first.

4. **Stopped guests cost disk, not RAM.** The ephemeral build sandboxes live stopped. That's what makes it affordable to keep five of them around on a memory-constrained box. A stopped LXC is just a volume on the thin pool.

5. **The thin pool is over-committed by design.** Allocated disk sizes sum past physical capacity. That's fine for LVM-thin as long as *actual* usage stays under physical, but it means you monitor pool usage (`pvesm status`), not the arithmetic sum of disk sizes you handed out. Tune `thin_pool_autoextend_threshold` so the pool warns before it fills.

6. **DNS lives inside the lab.** The resolver is a guest on the same host it serves. If the node is down, LAN DNS is down with it. Acceptable for home, but know the circular dependency is there before you debug a "the internet is broken" panic that's really "the hypervisor rebooted."

7. **Backup target write semantics matter more than backup target speed.** PBS assumes atomic rename. A consumer NAS over NFS couldn't deliver it, and no mount option fixed appliance firmware. Local datastore plus a weekly rsync mirror beat a clever-but-broken direct-to-NAS datastore. Match your storage to your backup tool's assumptions.

8. **One node has no failover.** This is a single hypervisor. If it dies, every service is down until it's back. The mitigation is not high availability (overkill for home), it's good off-host backups so a dead node is a restore, not a catastrophe. See [`backup-recovery.md`](backup-recovery.md).

## Related

- [`service-isolation.md`](service-isolation.md) - why one service per container, and the ephemeral build-container pattern
- [`backup-recovery.md`](backup-recovery.md) - restic backup of the agent host, restore procedures, disaster recovery
- [`openclaw-host-topology.md`](openclaw-host-topology.md) - the agent host that runs OpenClaw, a peer to this lab rather than a guest on it
