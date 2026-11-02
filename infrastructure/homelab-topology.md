# Homelab Topology: The Map

This is the floor plan of my homelab. One Proxmox hypervisor runs a pile of LXC containers, a couple of VMs, and a backup server that lives on the same box it protects. The security tooling that would not fit there runs as Hyper-V VMs on the Windows desktop. It covers what runs where, how I split LXC versus VM, how RAM and disk are carved up, the network shape, and how off-host backup wires in. 🦞

If you want the *why* behind one-service-per-container and the throwaway build-container pattern (now retired, see below), that's a separate guide: [`service-isolation.md`](service-isolation.md). This one is the map, not the manifesto.

**Tested on:** Proxmox VE 9.2 (pve-manager 9.2.21 as reported by the API), single node, no cluster. Hyper-V on Windows 11 Pro for the SOC VMs.
**Last updated:** 2026-11-02

---

## The Shape

One physical node for services. Everything is a guest on it. There is no NAS box running compute and no Kubernetes. The host does exactly one job: run guests and back them up. All service logic lives inside containers and VMs, never on the host itself.

```
Proxmox hypervisor (single node)
│
├── LXC containers (one service each, unprivileged except PBS)
│     ├── DNS filter              DNS ad-blocking
│     ├── DNS sync sidecar        keeps the second DNS instance in step
│     ├── zero-trust connector    outbound-only remote access
│     ├── SIEM                    Wazuh (the RAM and disk hog)
│     ├── dashboard               service launcher / status page
│     ├── fleet hub               Brigade fleet coordination hub
│     ├── automation              n8n + Postiz publishing stack
│     ├── photo library           Immich
│     ├── network monitoring      LibreNMS
│     ├── CI runner               GitHub Actions runner for the SOC stack
│     ├── PBS                     Proxmox Backup Server (privileged)
│     └── a few personal containers that are not part of this stack
│
└── VMs (the exception)
      ├── full desktop VM         a peer's separate OS, managed independently
      └── agent worker VM         Brigade worker that needs a full OS, started on demand

Windows desktop (Hyper-V, the SOC tier)
│
├── TheHive + Cortex VM           case management and observable analysis
└── MISP VM                       threat-intel platform
```

The old ephemeral tier of stopped build and smoke-test containers is gone. See [The Ephemeral Tier (Retired)](#the-ephemeral-tier-retired).

## LXC by Default, VM by Exception

The single biggest decision in this lab is **LXC unless you have a concrete reason for a VM**, and I land on LXC the overwhelming majority of the time.

LXC containers share the host kernel. That makes them cheap: a DNS blocker idles at 512MB RAM, boots in under a second, and adds essentially zero virtualization overhead. On a single small node that frugality decides how many services fit, because each container only costs what it actually uses.

I reach for a full VM only when one of these is true:

- **The workload needs a real kernel of its own.** Custom modules, a different kernel version, or anything that pokes at kernel internals an LXC can't.
- **The workload needs a genuine desktop session or its own full OS.** That is why the desktop VM exists: it is one full OS install that is managed independently, so it gets 8 cores, 8GB RAM, and a 300GB disk. That one guest holds as much RAM as my four heaviest containers combined, which is precisely why it is the exception and not the rule. The agent worker VM is for jobs that want a whole machine (4 cores, 6GB, 64GB disk). It stays stopped until a job needs it.
- **Hard isolation can outweigh density.** A VM has its own kernel, so a container-escape class of bug doesn't apply. For most home services that tradeoff isn't worth the RAM, but it's a real reason when it's a real reason.

If none of those hold, it's a container. The default is not a coin flip, it's a strong prior.

### Privileged vs Unprivileged

Inside the LXC tier there's a second split. Every container except one runs **unprivileged** (`unprivileged: 1`), which maps container root to an unprivileged host UID. That's the safe default and where every normal service lives.

The exception is the backup server, which runs **privileged** with `nesting=1`. It needs to `chown` chunk files to the backup user (UID 34) and, during its original design phase, needed to mount network shares. An unprivileged container can't do that UID remap cleanly. So PBS gets privileged, and in exchange I keep its attack surface tiny: it talks to the backup datastore and nothing else. Privileged is a deliberate, documented exception for exactly one container, not a convenience I hand out.

Most containers carry `features: nesting=1,keyctl=1` so Docker-in-LXC works for the services that ship as compose stacks (the automation and photo stacks both run Docker inside their LXC). The fleet hub also runs with `nesting=1` now, and it gets `/dev/net/tun` passed through for its overlay-network daemon.

## Container Inventory and Roles

Service containers with their configured allocations (from `pct config`, read 2026-11-02):

| Role | Cores | RAM | Disk | Priv | Notes |
|------|-------|-----|------|------|-------|
| DNS filter | 1 | 512MB | 32G | unpriv | Tiny, always on, first line of the network |
| DNS sync sidecar | 1 | 256MB | 4G | unpriv | Smallest guest in the lab |
| Zero-trust connector | 1 | 1GB | 3G | unpriv | Outbound tunnel connector, no inbound ports |
| SIEM | 4 | 8GB | 100G | unpriv | The RAM and disk hog, security stack |
| Dashboard | 2 | 2GB | 8G | unpriv | Service launcher |
| Fleet hub | 1 | 512MB | 8G | unpriv | Coordination hub, reachable only over the overlay network |
| Automation | 2 | 3GB | 64G | unpriv | n8n + Postiz, Docker compose inside, 2GB swap |
| Photo library | 4 | 4GB | 32G | unpriv | Immich, Docker compose, ML container, NAS bind-mount |
| Network monitoring | 4 | 4GB | 32G | unpriv | LibreNMS, `firewall=1` on the NIC |
| CI runner | 2 | 4GB | 30G | unpriv | Self-hosted runner, `onboot` off |
| Backup server | 2 | 4GB | 16G | **priv** | PBS, datastore bind-mounted from the host |

VMs on the hypervisor:

| Role | Cores | RAM | Disk | Notes |
|------|-------|-----|------|-------|
| Full desktop VM | 8 | 8GB | 300G | An independently managed desktop VM, hands off during host maintenance |
| Agent worker VM | 4 | 6GB | 64G | Runs Brigade worker jobs, stopped between jobs |

A few principles fall out of this table:

- **Size to the actual job.** The DNS sync sidecar gets 256MB because that's all it ever touches. The SIEM gets 8GB because it needs it. The automation CT was 12GB in June and is now 3GB with 2GB of swap. Uniform "2GB to be safe" allocations are how a small node runs out of RAM.
- **One service per container.** Each row is a single logical service (or a single Docker compose stack that *is* that service). The reasoning lives in [`service-isolation.md`](service-isolation.md).
- **The sidecar pattern is allowed.** The DNS sync container is a companion to the DNS container, split out so the sync daemon's failures can't take DNS resolution down with them.
- **Bind-mounts are part of the blast radius.** The photo container mounts a share from the NAS. Mounts are read-only wherever the container does not need to write.

### The Ephemeral Tier (Retired)

This lab used to keep a tier of build and smoke-test sandboxes (clean-room OSS PR builds, an MCP smoke container, a QEMU smoke template) that sat stopped until a job needed them. Those containers were destroyed in a September 2026 cleanup, and the freed IDs went to new containers. A stopped container still holds its disk on the thin pool, which matters now that the pool is three-quarters full. The retired pattern is described as history in [`service-isolation.md`](service-isolation.md). The one survivor from that era is the CI runner, which is now an ordinary long-lived container.

## The SOC Tier on Hyper-V

TheHive, Cortex, and MISP do not run on the Proxmox node. Together they want more RAM than the node has spare, and Elasticsearch plus Cassandra under TheHive would take the whole budget on their own. They run as Hyper-V VMs on the Windows desktop, which has RAM and cores sitting idle most of the day (see [`desktop-integration.md`](desktop-integration.md)).

| VM | vCPU | RAM assigned | What runs inside |
|----|------|--------------|------------------|
| TheHive + Cortex | 4 | ~9GB | Docker compose: TheHive 5.7.5, Cortex 4.1, Elasticsearch 8.19, Cassandra 4.1 |
| MISP | 2 | ~6GB | MISP |

The split follows the data flow. Wazuh stays on the hypervisor next to the agents it watches. Case management, analyzers, and threat intel sit on the desktop, and the agent reaches all four over their APIs through MCP servers. The workflow lives in [`../security/mcp-incident-response.md`](../security/mcp-incident-response.md).

I drive the VMs over SSH with PowerShell, so the desktop never needs a GUI session for this:

```powershell
Get-VM | Format-Table Name, State, ProcessorCount
Start-VM -Name <vm-name>
```

The tradeoff is shared fate with a machine I also use for everything else. A desktop reboot takes the case tooling down for a few minutes. Wazuh keeps collecting on the hypervisor in the meantime, so alerts queue rather than vanish.

## Resource Allocation Reality

The guests request more RAM on paper than the host physically has, because they don't all peak at once. That works up to a ceiling, and I've hit it.

The configured RAM across all containers and VMs adds up to roughly 1.7 times the RAM the host can actually hand out. On 2026-11-02 the node had about two-thirds of its usable RAM in use with everything warm. That leaves headroom for the always-on tier and not much else. The SIEM, the automation stack, and the photo stack carry most of the real usage.

The lesson I keep relearning: **on a single node, RAM is the binding constraint, not CPU and not disk.** The node idles at about 5% CPU. Disk is no longer comfortable either: the LVM-thin pool is 77% used (it was 37% in June), mostly the desktop VM's 300GB disk and the SIEM. RAM is still the thing I plan around, and disk is the next one to watch. Every time I add a service I ask "what does this push us to at peak?" before I ask anything else.

Storage layout on the node (from `pvesm status`, 2026-11-02):

| Storage | Type | Role |
|---------|------|------|
| `local` | dir | Host root, ISO/template storage (46% used) |
| `local-lvm` | lvmthin | All container and VM root disks (77% used) |
| `pbs-local-fast` | pbs | The backup datastore, registered as Proxmox storage (66% used) |

Note the thin pool is over-committed (allocated volumes sum past physical size). That's normal for LVM-thin and works as long as actual usage stays under physical, but it means I watch the *pool* usage, not the sum of the disk sizes I handed out.

## Networking Shape

Flat on purpose. All guests sit on a single Linux bridge (`vmbr0`) on the LAN. Most containers take **DHCP** and register a hostname. I don't hand-assign IPs unless a service needs a stable address.

The guests that break that pattern do it for a reason:

- **The backup server** gets a **static IP** and `firewall=1` on its NIC, because backup jobs and the PBS web UI need a predictable address that doesn't move on a lease renewal.
- **The zero-trust connector** is the only path for remote access to the LAN. It dials *out* to a zero-trust mesh, so there are no inbound port-forwards on the router. Nothing in this lab is exposed to the internet directly. Remote access rides the connector or it doesn't happen. The fleet hub listens only on the overlay network. The agent host's own remote access is covered in [`remote-access-tailnet-cloudflared.md`](remote-access-tailnet-cloudflared.md).

DNS for the LAN runs inside the lab itself (the DNS container, with the sync sidecar keeping a second instance in step). A second filter instance runs on separate hardware, which softens the old problem: the primary resolver is a guest on the box, so if the host is down, that instance is down too. For a home lab that's an acceptable circular dependency, but know that it exists. See [`adguard-dns-sinkhole.md`](adguard-dns-sinkhole.md).

## How Backup Wires In

Backup is a first-class guest. **Proxmox Backup Server runs as a container on the same node it protects.** That sounds like putting the lifeboat on the ship, and it would be a problem if PBS were the *only* copy. The design is one fast local tier plus off-host mirrors:

1. **Local PBS datastore.** One scheduled `vzdump` job (`daily-prod`, 02:00, snapshot mode, zstd) writes to `pbs-local-fast`. It covers 12 guests, including every service in the table above and the desktop VM. It skips the worker VM (rebuildable), a trial container, a few personal containers, and PBS itself. PBS does content-addressed chunk dedup, so a daily backup only writes the chunks that actually changed. The datastore lives on its own host volume, bind-mounted into the PBS container, so a full datastore cannot starve the thin pool that holds guest disks. Restores are fast because the data is local.
2. **NAS mirror**, weekly (Sunday 08:00). The datastore is rsynced to a CIFS-mounted NAS share. Because PBS chunk filenames are content hashes, unchanged chunks have unchanged names and mtimes, so rsync ships only what changed. Last run when I checked: 2026-11-01.
3. **Cloud mirror**, weekly, **currently disabled.** An rclone sync from the PBS container to cloud object storage ran until 2026-08-19, when the shared OAuth client hit its API quota. The timer stays off until the job moves to a private client ID and a full manual sync finishes clean. Until then the cloud tier does not exist, and the NAS copy is the only off-host tier.

So the on-node PBS is the fast tier, and the NAS copy is the "the whole node caught fire" tier. If the hypervisor dies, the backups survive on one independent off-host location, which is one fewer than I designed for. The full restore mechanics and the restic-based backup of the *agent host* (a separate machine) live in [`backup-recovery.md`](backup-recovery.md). The datastore itself ran past 90% in early September, so I watch its usage with the same attention as the thin pool.

The SOC VMs on the desktop are outside this job. PBS only backs up Proxmox guests, so Hyper-V VMs need a backup path of their own on the Windows side.

### The PBS Deployment That Taught Me Something

The original plan was to put the PBS datastore directly on an NFS export from the NAS, so backups landed off-host immediately with no mirror step. It did not work, and the failure was instructive.

PBS writes a chunk to a temp file and then atomically renames it into place. The NAS is a consumer unit with 2016-era firmware, and its NFS server could not commit that write-then-rename pattern reliably. First I got stale `readdir` results (`mkstemp ... failed: ENOENT`), which I beat back with aggressive cache-disabling mount options (`lookupcache=none,acdirmin=0,acdirmax=0`). But even with caching off, the atomic rename itself failed: `Atomic rename failed ... No such file or directory`. The chunk write would land, the rename would not commit through the NFS server's metadata layer, and the backup aborted.

There was no mount option that fixed the rename. The constraint was the appliance firmware, not my config. Two more sharp edges along the way: creating the chunkstore over NFS took ~25 minutes because PBS makes 65,536 subdirectories and each `mkdir` round-trips to the NAS at ~33/sec, and the NAS's "Guest Permission: Forced" setting mapped every write to `nobody`, so PBS's `chown 34:34` on chunk files failed with `EPERM`.

So I abandoned NFS-as-datastore entirely. The working design is the one above: **local LVM datastore, weekly rsync to the NAS over CIFS.** I gave up "instantly off-host" and got back atomic renames, fast chunkstore creation, and dedup that carries through to the mirror for free. A backup target has to honor the write semantics your backup tool assumes. PBS assumes atomic rename. Verify your storage actually provides it before you build on it, and don't fight appliance firmware you can't change.

## Verification

Quick read of the whole topology from the node (all read-only):

```bash
# What's running, both kinds. CTIDs and VMIDs share one number pool,
# so always check BOTH before assuming an ID is free or missing.
ssh <hypervisor> "pct list"      # LXC containers only
ssh <hypervisor> "qm list"       # VMs only (expect 2, the worker VM stopped between jobs)

# Per-guest config (RAM, cores, disk, priv flag, network)
ssh <hypervisor> "pct config <ctid>"

# Proxmox version
ssh <hypervisor> "pveversion"

# Storage pools and headroom
ssh <hypervisor> "pvesm status"

# Scheduled backup jobs
ssh <hypervisor> "pvesh get /cluster/backup --output-format json-pretty"

# Live RAM pressure on the node, the constraint that actually matters
ssh <hypervisor> "free -h"

# Confirm the backup server is up and its datastore is mounted
ssh <hypervisor> "pct exec <pbs-ctid> -- proxmox-backup-manager datastore list"
```

For the SOC tier on the desktop:

```bash
ssh <desktop> 'powershell -NoProfile -Command "Get-VM | Format-Table Name,State"'
# Expect the TheHive/Cortex VM and the MISP VM in state Running

curl -s http://<thehive-vm>:9000/api/status | jq -r '.versions.TheHive'
# 5.7.5-1
curl -s http://<thehive-vm>:9001/api/status | jq -r '.versions.Cortex'
# 4.1.0-1
```

If `pct list` shows a guest you expected and `qm list` shows another, that's not a bug: LXC and VM share the ID pool, so a VM can sit at an ID between two containers.

## Gotchas

1. **`pct list` and `qm list` are two different worlds.** Containers and VMs share one CTID/VMID number pool but show up in different commands. Check both before creating an ID or declaring one missing. I have absolutely confused myself by running only `pct list` and concluding a guest didn't exist when it was a VM.

2. **RAM is the budget, not CPU.** Real usage sits near two-thirds of usable RAM with everything warm. Plan additions against peak RAM. The CPU is never the limit. Disk is now the second constraint. This is also why the SOC stack lives on another hypervisor.

3. **Privileged containers are an exception you justify, not a default.** Only the backup server runs privileged, because it needs UID-remapped `chown` on chunk files. Everything else is unprivileged. If you find yourself making a container privileged "to make it work," figure out the actual capability you need first.

4. **Destroyed IDs get reused.** After the September cleanup, the freed container IDs were handed to new containers. Notes, dashboards, and backup selections that reference an ID by number will point at a different service. Re-check ID-based references after any cleanup, and prefer role names in docs.

5. **The thin pool is over-committed by design.** Allocated disk sizes sum past physical capacity. That's fine for LVM-thin as long as *actual* usage stays under physical, but it means you monitor pool usage (`pvesm status`), not the arithmetic sum of disk sizes you handed out. Tune `thin_pool_autoextend_threshold` so the pool warns before it fills.

6. **DNS lives inside the lab.** The primary resolver is a guest on the same host it serves. If the node is down, that resolver is down with it. A second instance on separate hardware catches most of it, but know the circular dependency is there before you debug a "the internet is broken" panic that's really "the hypervisor rebooted."

7. **Small containers fill up too.** The DNS container's disk was grown to 32G and is still about 90% full, mostly query logs. Tiny RAM does not mean tiny disk. Check `df` inside long-lived containers, not only the pool.

8. **Backup target write semantics outrank backup target speed.** PBS assumes atomic rename. A consumer NAS over NFS couldn't deliver it, and no mount option fixed appliance firmware. Local datastore plus a weekly rsync mirror beat a clever-but-broken direct-to-NAS datastore. Match your storage to your backup tool's assumptions.

9. **A disabled mirror is a missing tier.** The cloud mirror timer has been off since 2026-08-19. A backup design with three copies on paper and two in practice should say so in the doc, and the doc should be updated when the third copy returns.

10. **One node has no failover.** This is a single hypervisor. If it dies, every service is down until it's back. The mitigation is not high availability (overkill for home), it's good off-host backups so a dead node is a restore, not a catastrophe. See [`backup-recovery.md`](backup-recovery.md).

## Related

- [`service-isolation.md`](service-isolation.md) - why one service per container, and the ephemeral build-container pattern
- [`backup-recovery.md`](backup-recovery.md) - restic backup of the agent host, restore procedures, disaster recovery
- [`openclaw-host-topology.md`](openclaw-host-topology.md) - the agent host that runs OpenClaw, a peer to this lab rather than a guest on it
- [`desktop-integration.md`](desktop-integration.md) - the Windows desktop that hosts the SOC VMs
- [`../security/mcp-incident-response.md`](../security/mcp-incident-response.md) - how the agent drives Wazuh, TheHive, Cortex, and MISP
