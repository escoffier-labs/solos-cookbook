# Proxmox as the Agent Lab Substrate

> One consumer-grade hypervisor runs the always-on agent stack's supporting services, an AI agent inspects and safely operates it through a token-gated MCP, and a separate auditor grades the host against CIS benchmarks. 🦞

**Tested on:** Proxmox VE 9.x, Intel consumer hardware, 32GB RAM single node (no cluster), unprivileged LXC + a few QEMU VMs. proxmox-mcp 0.5.0, ProxGuard 16-rule CIS engine.
**Last updated:** 2026-06-10

---

## What This Is

This is the substrate guide for a home agent lab: the physical box that hosts everything the always-on agent stack leans on, and how an AI agent is allowed to look at and operate that box without being handed root.

The shape is one consumer hypervisor running a pile of small LXC containers and a couple of VMs. The persistent services are the lab's plumbing: a DNS sinkhole, a SIEM, a network monitor, a photo service, an n8n automation stack, and a Proxmox Backup Server living on the same box it protects. Alongside those sit a handful of build and smoke-test containers that spend nearly all their life stopped. A separate hypervisor (a Windows desktop running Hyper-V) carries the heavier SOC VMs, so it stays out of the RAM budget here.

The distinctive part is the operator layer. The agent never gets an SSH root shell on the host. It reaches Proxmox through the operator's own [`proxmox-mcp`](https://github.com/lidless-labs/proxmox-mcp), a Model Context Protocol server that exposes the host through tiered, token-authenticated tools: reads are open, writes need an explicit confirm flag, and destructive operations need a confirm flag plus a destructive flag plus a process-level env gate. Security posture is graded out-of-band by [ProxGuard](https://github.com/solomonneas/proxguard), which parses the host's real config files against CIS Debian benchmarks and emits copy-paste remediation.

If you want the raw inventory of what runs in which container, that map is [`homelab-topology.md`](homelab-topology.md). If you want the discipline behind one-service-per-container and the throwaway build-container pattern, that's [`service-isolation.md`](service-isolation.md). This guide is about using that lab as an *agent-operated* substrate: the MCP boundary, the safe-write tiers, and the audit loop.

## Why Proxmox for an Agent Lab

A few properties make Proxmox a good fit for a lab an agent partly operates:

- **Cheap, fast isolation.** LXC containers share the host kernel, so a DNS blocker idles at 512MB and boots in under a second. On a 32GB box that frugality is the whole game: you can run eight persistent services plus a backup server and still keep build sandboxes on standby. When an agent does something it shouldn't, the blast radius is one container, and `proxmox_rollback_snapshot` puts it back.
- **A real API to gate.** Proxmox VE has a first-class REST API with token auth and per-token ACLs. That means an agent's access can be a *scoped token*, not a shell. You can hand out a read-only token first, confirm the model honors the read tier, then grade up to power-management and snapshot rights. Tokens are revocable instantly from the Datacenter > Permissions > API Tokens UI.
- **Snapshots and backups are primitives, not add-ons.** `pct snapshot` before a risky change and `vzdump` to a backup datastore are built in. The agent can snapshot before it touches a service and the operator can restore without thinking about it.
- **Numbered, inspectable guests.** Every guest is an LXC or VM with a config you can read with one tool call. An agent can answer "what is running, how much RAM does it want, is it privileged" entirely through read-tier tools before it proposes any change.

The point is not that the agent runs the lab. It is that the lab is built so the agent can *see* it fully and *change* it narrowly, with every write behind a flag and every destructive op behind three.

## Prerequisites

- A Proxmox VE 9.x host you control, single node is fine. Consumer hardware is fine; this lab runs on a 32GB box.
- SSH access to the host for the operator (the MCP uses host SSH for in-guest `pct exec`, file reads, and writes).
- A Proxmox API token. Start read-only: a role with `Datastore.Audit + VM.Audit + Sys.Audit`. Grade up to `VM.PowerMgmt + VM.Snapshot + VM.Backup` only after the read tier is verified.
- [`proxmox-mcp`](https://github.com/lidless-labs/proxmox-mcp) installed in whatever agent harness you run (Claude Desktop, Claude Code, OpenClaw, Codex CLI, Hermes are all documented upstream).
- [ProxGuard](https://github.com/solomonneas/proxguard) for the audit pass. It runs entirely client-side in the browser; nothing leaves the machine.
- For self-signed lab certs, you'll want `PROXMOX_TLS_INSECURE=true` on the MCP. See the gotchas; this is the only place that toggle belongs.

## CT and VM Layout: Service vs Ephemeral, and the RAM Budget

The layout follows two tiers, and the split is the whole sizing strategy.

**Long-lived service CTs.** These are the always-on plumbing, one service per unprivileged LXC, sized to the actual job rather than a uniform "2GB to be safe":

| Role | RAM (typical) | Priv | Why |
|------|---------------|------|-----|
| DNS sinkhole | 512MB | unpriv | Tiny, always on, first line of the network |
| DNS sync sidecar | 256MB | unpriv | Companion to DNS so its failures can't take resolution down |
| SIEM (Wazuh) | 8GB | unpriv | The RAM hog; security event pipeline |
| Network monitoring (LibreNMS) | 4GB | unpriv | Polls the LAN |
| Photo service | 4GB | unpriv | Docker compose inside the LXC |
| n8n automation | up to 12GB | unpriv | n8n plus publishing stack, Docker inside |
| Proxmox Backup Server | 4GB | **priv** | Needs UID-remapped `chown` on chunk files |

**Ephemeral build and smoke CTs.** These are the distinctive pattern. PR builds, integration smoke tests, and CI-style jobs do not get a permanent home and do not run on a service container. Each gets a dedicated container that is **stopped by default** and started only for the duration of a job:

```
*-prbuild   stopped   clean-room OSS build/test sandbox (one per project)
mcp-smoke   stopped   MCP integration smoke sandbox
gh-runner   stopped   CI runner sandbox
```

The workflow is reset, start, build, capture, stop. A stopped LXC consumes a disk volume and **zero RAM**, which is exactly why it is affordable to keep five of them around on a memory-constrained box. They are templates that happen to also be runnable. Pair each with a `pristine` snapshot so every run starts identical, and put `firewall=1` on the build NIC because a PR build does not need to phone home. Full treatment of the pattern lives in [`service-isolation.md`](service-isolation.md).

### The RAM Budget Reality

On a 32GB box you get about **30Gi usable** after the hypervisor takes its cut. With the SIEM (8GB), the automation stack (12GB), and the photo service (4GB) all warm, real usage climbs to roughly **22Gi of 30Gi used**. That leaves enough for the always-on tier but not much else, and it is precisely why the build sandboxes are stop-on-demand rather than always running. Leave two 6GB prbuild containers running alongside everything else and the host starts swapping, with the SIEM the first thing to feel it.

The lesson worth internalizing before you let an agent provision anything: **on a single 32GB node, RAM is the binding constraint, not CPU and not disk.** The CPU has threads to spare and the disk is a thin pool sitting around a third full. RAM is the thing to plan around. Every time the agent proposes a new guest, the first question is "what does this push us to at peak," answered with `proxmox_resource_usage` before anything is created. The SOC-heavy VMs deliberately live on a separate hypervisor for exactly this reason: they would blow the budget here.

## Backups with PBS

Backup is a first-class guest, not a bolt-on. **Proxmox Backup Server runs as a container on the same node it protects.** That sounds like putting the lifeboat on the ship, and it would be if PBS were the only copy. It is the fast local tier in a three-copy design:

1. **Local PBS datastore** on the node's own thin pool. PBS does content-addressed chunk dedup, so a daily backup of all guests only writes the chunks that actually changed (a few GB, not a full image), and restores are fast because the data is local.
2. **Off-host mirror**, periodic. The datastore rsyncs to network storage. Because PBS chunk filenames are content hashes, unchanged chunks keep unchanged names and mtimes, so rsync ships only the delta.
3. **Cloud mirror**, periodic. A throttled-by-day rclone sync of the datastore to object storage.

The on-node PBS is the fast tier; the two off-host copies are the "the whole node caught fire" tier. The PBS container runs **privileged** because it needs to `chown` chunk files to the backup user and an unprivileged container can't do that UID remap cleanly. That is the one documented privileged exception in the lab, and in exchange its attack surface is kept tiny: it talks to the backup datastore and nothing else. Full restore mechanics and the off-host design live in [`backup-recovery.md`](backup-recovery.md).

An agent can trigger and verify backups through the MCP without touching a shell. `proxmox_run_backup` fires a `vzdump` for a vmid (safe-write tier, needs `confirm: true`), `proxmox_wait_task` polls the resulting task to completion, and `proxmox_list_backups` confirms the artifact landed in the datastore. That is a complete backup-and-verify loop with no destructive tool in it.

## Agent Management via proxmox-mcp

The agent's entire relationship with the host is the MCP. The tools split into four tiers (20 open reads, 4 gated guest reads, 13 safe writes, 5 destructive), every write is flagged, and the token is scoped. Here is how that boundary actually behaves.

### Token auth, not a shell

The MCP authenticates to the Proxmox API with a token, configured by three required env vars:

```
PROXMOX_URL=https://pve.example.local:8006
PROXMOX_TOKEN_ID=pve-admin@pam!api-token-1
PROXMOX_TOKEN_SECRET=00000000-0000-0000-0000-000000000000
```

The token secret is registered with a redactor on startup and masked from all log and error output. The in-guest tools (`proxmox_exec`, `proxmox_read_file`, `proxmox_write_file`) reach into containers via host SSH and `pct exec`, or directly into VMs, using a key path you control. The agent never sees that key and never gets an interactive shell. It gets tools.

### Representative safe-tier calls

The read tier (open, no flags) is where the agent lives most of the time. A typical inspection pass before proposing any change:

```
proxmox_status {}                                  # cluster + node health
proxmox_list_containers {}                          # LXC inventory
proxmox_list_vms {}                                 # QEMU inventory
proxmox_get_container_config { "vmid": 105 }        # RAM, cores, priv flag, net
proxmox_resource_usage { "vmid": 105 }              # CPU/mem/disk RRD
proxmox_list_snapshots { "vmid": 105 }              # what's safe to roll back to
proxmox_list_storage {}                             # pool headroom
proxmox_list_backups { "storage": "pbs-local" }     # backup inventory
```

The safe-write tier needs `confirm: true` on every call. A `WriteGateError` fires *before any HTTP traffic* if the flag is missing, so a hallucinated tool call can't accidentally mutate the host. A representative safe-write workflow, snapshot then act then verify:

```
proxmox_snapshot_resource { "vmid": 105, "snapname": "pre-maint", "confirm": true }
proxmox_service_restart  { "vmid": 105, "service": "wazuh-manager", "confirm": true }
proxmox_service_status   { "vmid": 105, "service": "wazuh-manager", "confirm": true }
```

Provisioning a fresh build sandbox and tearing it down stays inside the safe-write tier for everything except the final delete:

```
proxmox_next_vmid {}                                                  # read
proxmox_create_container { "vmid": 130, "confirm": true, ... }        # safe-write
proxmox_start_resource   { "vmid": 130, "confirm": true }             # safe-write
proxmox_exec { "vmid": 130, "command": "...build...", "confirm": true }
proxmox_stop_resource    { "vmid": 130, "confirm": true }             # safe-write
```

The guest-read tools (`proxmox_read_file`, `proxmox_stat_path`, `proxmox_list_directory`, `proxmox_service_status`) are gated with `confirm: true` too, because reading in-guest state goes through host-backed SSH and is more than a metadata peek.

### What is NOT exposed by default

This is the part that makes the boundary trustworthy. The five destructive tools cannot run on flags alone:

- `proxmox_destroy_resource` (permanent LXC/VM deletion)
- `proxmox_rollback_snapshot`
- `proxmox_delete_snapshot`
- `proxmox_force_stop_resource` (non-graceful hard stop)
- `proxmox_cleanup_smoke_resources` (bulk smoke-pool delete)

Every one of them requires `confirm: true` **and** `destructive: true` **and** the process-level env flag `PROXMOX_ENABLE_DESTRUCTIVE=1` on the MCP. All three gates must be satisfied; any one missing throws `WriteGateError` before the resource is even resolved. The env flag is a coarse "I am actively doing destructive cycles" toggle that you leave unset day to day. So an agent running with the default environment literally cannot delete a container or roll back a snapshot, no matter how it phrases the call. It can snapshot, start, stop, reboot, back up, and provision; it cannot destroy. (`proxmox_cleanup_smoke_resources` additionally defaults to `dry_run: true`, so it previews targets without the env gate at all.)

That asymmetry is the design: the common, reversible operations are one flag away, and the irreversible ones are behind a gate you have to consciously open.

## Hardening with proxguard

The MCP governs what the agent can *do*. ProxGuard governs whether the host is configured *safely* in the first place, and it runs out-of-band, client-side, with nothing leaving the machine.

ProxGuard parses the host's actual config files against CIS Debian benchmarks and Proxmox-specific standards, then grades the posture across six weighted categories: SSH (25%), Firewall (25%), Authentication (20%), Container (15%), Storage (10%), API (5%). SSH and Firewall carry the most weight because they are the most common attack surface. The engine runs 16 rules, each tracing to a CIS benchmark (for example "Root SSH with Password Authentication" maps to CIS Debian 11 5.2.10) or a PVE-prefixed rule where no direct CIS mapping exists.

### The audit-and-remediate flow

1. On the host, gather the configs ProxGuard reads:
   - `/etc/ssh/sshd_config` (SSH hardening)
   - `/etc/pve/firewall/cluster.fw` (firewall rules)
   - `/etc/pve/user.cfg` (users, roles, 2FA)
   - `/etc/pve/storage.cfg` (NFS/CIFS mounts)
   - `pveum apitoken list` output (API token privileges and expiry)
2. Paste them into ProxGuard's Audit tab. It parses each file, runs all 16 rules, and produces an overall A-to-F grade plus per-category breakdown.
3. Click any failed finding for its severity, CIS reference, and a **copy-paste remediation script**. A critical (-40) like root SSH with password auth, a high (-25) like no 2FA, a medium (-10) like SSH still on port 22 each comes with the exact shell commands to fix it.
4. Apply the remediation on the host, re-paste the updated configs, confirm the grade moved.

Two ProxGuard findings map directly onto this lab's own design decisions, which is a useful sanity check that the rules are real:

- **Privileged LXC Containers Detected** (High, PVE-CT-001) will flag the PBS container. That is the one justified privileged exception, so it is an *accepted* finding, not a regression. Documenting why a flagged container is privileged is the right response, not silencing the rule.
- **Container Nesting Enabled** (Medium, PVE-CT-002) will flag the Docker-in-LXC service containers. Same story: nesting is enabled deliberately for the compose stacks, so the finding is acknowledged rather than "fixed" by breaking those services.

ProxGuard also visualizes firewall rules with conflict detection (shadowing, contradictions, unreachable rules, port overlap, protocol mismatch), which is worth a pass after you add any firewall rule for a new service.

## Verification

A full read-only sanity sweep, half through the MCP read tier and half from the host shell:

```
# Through the MCP (read tier, no flags):
proxmox_status {}                            # node up, cluster healthy
proxmox_list_containers {}                    # expected service CTs present
proxmox_resource_usage {}                     # RAM headroom at peak
proxmox_list_snapshots { "vmid": 105 }        # a recent snapshot exists
proxmox_list_backups { "storage": "pbs-local" }  # last backup landed
```

```bash
# From the host shell (both worlds; CTIDs and VMIDs share one pool):
ssh <host> "pct list"     # LXC containers
ssh <host> "qm list"      # VMs
ssh <host> "free -h"      # the constraint that actually matters
ssh <host> "pct exec <pbs-ctid> -- proxmox-backup-manager datastore list"
```

Confirm the agent is gated, not just trusted: with `PROXMOX_ENABLE_DESTRUCTIVE` unset, a `proxmox_destroy_resource` call (even with both flags) should throw `WriteGateError` and touch nothing. Then run a ProxGuard audit and confirm the grade is where you expect, with only the two accepted PVE-CT findings (privileged PBS, nesting on Docker hosts) outstanding.

## Gotchas

1. **RAM is the ceiling, plan every addition against peak.** On a 32GB node you get ~30Gi usable and real peak hits ~22Gi with the heavy services warm. Before the agent provisions anything, run `proxmox_resource_usage` and ask what it pushes you to at peak. The CPU and disk are not what run out first. This is why the SOC VMs live on a separate hypervisor.

2. **Privileged is an exception you justify, not a default.** Only the backup server runs privileged, because it needs UID-remapped `chown` on chunk files. ProxGuard will flag it (PVE-CT-001); that finding is accepted and documented, not silenced. If you find yourself making a *second* container privileged "to make it work," figure out the actual capability first, and consider whether you really wanted a VM.

3. **`unprivileged` can't be flipped after create.** UID mapping changes how rootfs files are owned, so privileged-vs-unprivileged is a create-time decision, not a `pct set`. For services the answer is always unprivileged.

4. **`PROXMOX_TLS_INSECURE=true` is for self-signed lab certs only.** The toggle exists because homelab Proxmox hosts usually run a self-signed cert. Set it only when that is genuinely the case; leave it `false` in any environment with a real CA-signed cert. It is not a "make the connection work" convenience, it is an explicit "I trust this self-signed cert" statement.

5. **The destructive env gate is the real seatbelt.** The per-tool `confirm` and `destructive` flags are necessary but not sufficient. Leave `PROXMOX_ENABLE_DESTRUCTIVE` unset day to day so the agent structurally cannot delete or force-stop, no matter how a tool call is phrased. Flip it only for the minutes you are actively running destructive cycles, then unset it.

6. **Stopped build CTs are templates, and templates rot.** A `pristine` snapshot from six months ago builds against six-month-old toolchains. Periodically start, update, re-snapshot, stop, or your "clean room" is a museum.

7. **CTID and VMID share one number pool.** `pct list` shows only LXC, `qm list` shows only VMs, and they draw from the same ID space. Check both before assuming an ID is free. The MCP's `proxmox_next_vmid` handles this for you when provisioning; the manual shell path does not.

8. **Start the token read-only, grade up after.** Hand the MCP a `*.Audit`-only token first, verify the read tools work end-to-end and the redactor masks your secret in transcripts, *then* grade up to power-management and snapshot rights. Tokens are revocable instantly from the Proxmox UI, so the cost of being conservative is near zero.

## Related

- [`homelab-topology.md`](homelab-topology.md) - the map: what runs in which container, the LXC/VM split, the storage and network layout
- [`service-isolation.md`](service-isolation.md) - the why: one service per container, per-container caps, and the ephemeral build-container pattern
- [`backup-recovery.md`](backup-recovery.md) - off-host restore mechanics and the three-copy backup design
- [`adguard-dns-sinkhole.md`](adguard-dns-sinkhole.md) - the DNS sinkhole that is one of the always-on service CTs
- [`../security/mcp-incident-response.md`](../security/mcp-incident-response.md) - driving incident response through MCP tools, the same boundary pattern applied to the SIEM
