# Proxmox as the Agent Lab Substrate

> One consumer-grade hypervisor runs the always-on agent stack's supporting services, an AI agent inspects and safely operates it through a token-gated MCP, and a separate auditor grades the host against CIS benchmarks. 🦞

**Tested on:** Proxmox VE 9.2, Intel consumer hardware, 32GB RAM single node (no cluster), 15 LXC containers plus 2 QEMU VMs. proxmox-mcp 0.11.0 from the repository (96 tools). The npm registry still serves 0.5.1 as `latest`, so see the install note below. ProxGuard 16-rule CIS engine.
**Last updated:** 2026-10-17

---

## What This Is

This is the substrate guide for a home agent lab: the physical box that hosts everything the always-on agent stack leans on, and how an AI agent is allowed to look at and operate that box without being handed root.

The shape is one consumer hypervisor running a pile of small LXC containers and a couple of VMs. The services are the lab's plumbing: a DNS sinkhole, a SIEM, a network monitor, a photo service, an n8n automation stack, a fleet coordination hub, a self-hosted CI runner, a few media libraries, and a Proxmox Backup Server living on the same box it protects. Everything is always on. The stopped build and smoke-test container tier this guide used to describe was destroyed in a September 2026 cleanup. A separate hypervisor (a Windows desktop running Hyper-V) carries the heavier SOC VMs, so it stays out of the RAM budget here.

The distinctive part is the operator layer. The agent never gets an SSH root shell on the host. It reaches Proxmox through the operator's own [`proxmox-mcp`](https://github.com/lidless-labs/proxmox-mcp), a Model Context Protocol server that exposes the host through tiered, token-authenticated tools: reads are open, writes need an explicit confirm flag, and destructive operations need a confirm flag plus a destructive flag plus a process-level env gate. Security posture is graded out-of-band by [ProxGuard](https://github.com/solomonneas/proxguard), which parses the host's real config files against CIS Debian benchmarks and emits copy-paste remediation.

If you want the raw inventory of what runs in which container, that map is [`homelab-topology.md`](homelab-topology.md). If you want the discipline behind one-service-per-container (and the retired throwaway build-container pattern), that's [`service-isolation.md`](service-isolation.md). This guide is about using that lab as an *agent-operated* substrate: the MCP boundary, the safe-write tiers, and the audit loop.

## Why Proxmox for an Agent Lab

A few properties make Proxmox a good fit for a lab an agent partly operates:

- **Cheap, fast isolation.** LXC containers share the host kernel, so a DNS blocker idles at 512MB and boots in under a second. On a 32GB box that frugality is the whole game: you can run fifteen small containers and two VMs on one node. When an agent does something it shouldn't, the blast radius is one container, and `proxmox_rollback_snapshot` puts it back.
- **A real API to gate.** Proxmox VE has a first-class REST API with token auth and per-token ACLs. That means an agent's access can be a *scoped token*, not a shell. You can hand out a read-only token first, confirm the model honors the read tier, then grade up to power-management and snapshot rights. Tokens are revocable instantly from the Datacenter > Permissions > API Tokens UI.
- **Snapshots and backups are primitives, not add-ons.** `pct snapshot` before a risky change and `vzdump` to a backup datastore are built in. The agent can snapshot before it touches a service and the operator can restore without thinking about it.
- **Numbered, inspectable guests.** Every guest is an LXC or VM with a config you can read with one tool call. An agent can answer "what is running, how much RAM does it want, is it privileged" entirely through read-tier tools before it proposes any change.

The point is not that the agent runs the lab. It is that the lab is built so the agent can *see* it fully and *change* it narrowly, with every write behind a flag and every destructive op behind three.

## Prerequisites

- A Proxmox VE 9.x host you control. A single node is fine, and consumer hardware is fine. This lab runs on a 32GB box.
- SSH access to the host for the operator (the MCP uses host SSH for in-guest `pct exec`, file reads, and writes).
- A Proxmox API token. Start read-only: a role with `Datastore.Audit + VM.Audit + Sys.Audit`. Grade up to `VM.PowerMgmt + VM.Snapshot + VM.Backup` only after the read tier is verified.
- [`proxmox-mcp`](https://github.com/lidless-labs/proxmox-mcp) installed in whatever agent harness you run (Claude Desktop, Claude Code, OpenClaw, and Codex CLI are documented upstream). The tool counts below match the repository at 0.11.0. `npm view @solomonneas/proxmox-mcp version` reports 0.5.1, which is the older, smaller tool surface. To get all 96 tools, run the server from a checkout of the repository.
- [ProxGuard](https://github.com/solomonneas/proxguard) for the audit pass. It runs entirely client-side in the browser, so nothing leaves the machine.
- For self-signed lab certs, you'll want `PROXMOX_TLS_INSECURE=true` on the MCP. See the gotchas. This is the only place that toggle belongs.

## CT and VM Layout and the RAM Budget

The layout is one tier now: long-lived service containers, each one service per unprivileged LXC, sized to the actual job rather than a uniform "2GB to be safe". The full inventory with IDs is in [`homelab-topology.md`](homelab-topology.md). The roles that matter for agent work:

| Role | RAM (configured) | Priv | Why |
|------|------------------|------|-----|
| DNS sinkhole | 512MB | unpriv | Tiny, always on, first line of the network |
| DNS sync sidecar | 256MB | unpriv | Companion to DNS so its failures can't take resolution down |
| SIEM (Wazuh) | 8GB | unpriv | The RAM hog, security event pipeline |
| Network monitoring (LibreNMS) | 4GB | unpriv | Polls the LAN |
| Photo service | 4GB | unpriv | Docker compose inside the LXC |
| n8n automation | 3GB (+2GB swap) | unpriv | n8n plus publishing stack, Docker inside |
| Fleet hub | 512MB | unpriv | Coordination hub for the agent fleet, overlay network only |
| CI runner | 4GB | unpriv | Self-hosted GitHub Actions runner |
| Media libraries (4 containers) | 1 to 2GB each | unpriv | Read-only or single-share bind-mounts |
| Proxmox Backup Server | 4GB | **priv** | Needs UID-remapped `chown` on chunk files |

Two VMs sit beside them: a full desktop OS managed by someone else (8GB), and a worker VM for agent jobs that want a whole machine (6GB).

**The ephemeral tier is retired.** Earlier versions of this guide described a set of stopped-by-default build and smoke-test containers that an agent started, used, and stopped again, reset by a `pristine` snapshot. They are gone. The pattern, what it cost, and why I don't run it now are in [`service-isolation.md`](service-isolation.md). The MCP workflow for it (clone or create, start, `proxmox_exec`, stop) still works for any short-lived guest you decide to create.

### The RAM Budget Reality

On a 32GB box you get about **31GiB usable** after the hypervisor takes its cut. The configured RAM across the containers and VMs adds up to roughly 52GB, so the lab is overcommitted on paper by design. On 2026-10-17 the node reported about 23GiB in use. That leaves enough for the always-on tier but not much else. The SIEM, the photo service, and the 8GB desktop VM carry most of it.

The lesson worth internalizing before you let an agent provision anything: **on a single 32GB node, RAM is the binding constraint, not CPU.** The CPU has threads to spare. The disk was a third full in June and is now 69% used on the thin pool, so disk is the second thing to watch. Every time the agent proposes a new guest, the first question is "what does this push us to at peak," answered with `proxmox_resource_usage` before anything is created. The SOC-heavy VMs deliberately live on a separate hypervisor for exactly this reason: they would blow the budget here.

## Backups with PBS

Backup is a first-class guest, not a bolt-on. **Proxmox Backup Server runs as a container on the same node it protects.** That sounds like putting the lifeboat on the ship, and it would be if PBS were the only copy. It is the fast local tier in a design with two off-host mirrors, one of which is currently down:

1. **Local PBS datastore** on the node's own thin pool. PBS does content-addressed chunk dedup, so a daily backup of all guests only writes the chunks that actually changed (a few GB, not a full image), and restores are fast because the data is local.
2. **Off-host mirror**, weekly. The datastore rsyncs to network storage. Because PBS chunk filenames are content hashes, unchanged chunks keep unchanged names and mtimes, so rsync ships only the delta.
3. **Cloud mirror**, weekly, **disabled since 2026-08-19.** The rclone sync of the datastore to object storage hit its shared OAuth client's API quota and stays off until it moves to a private client ID.

The on-node PBS is the fast tier. The network copy is the "the whole node caught fire" tier, and today it is the only one. A single scheduled `vzdump` job (daily at 02:00, snapshot mode, covering the 12 guests that matter) feeds the local datastore. The PBS container runs **privileged** because it needs to `chown` chunk files to the backup user and an unprivileged container can't do that UID remap cleanly. That is the one documented privileged exception in the lab, and in exchange its attack surface is kept tiny: it talks to the backup datastore and nothing else. The `proxmox_list_backup_jobs` read tool shows that job and its selection, so an agent can answer "is this guest covered?" without a shell. Full restore mechanics and the off-host design live in [`backup-recovery.md`](backup-recovery.md).

An agent can trigger and verify backups through the MCP without touching a shell. `proxmox_run_backup` fires a `vzdump` for a vmid (safe-write tier, needs `confirm: true`), `proxmox_wait_task` polls the resulting task to completion, and `proxmox_list_backups` confirms the artifact landed in the datastore. That is a complete backup-and-verify loop with no destructive tool in it.

## Agent Management via proxmox-mcp

The agent's entire relationship with the host is the MCP. The 96 tools split into four tiers (43 open reads, 4 gated guest reads, 41 safe writes, 8 destructive, counted from the repository's tool registry at 0.11.0), every write is flagged, and the token is scoped. Here is how that boundary actually behaves.

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
proxmox_list_backup_jobs {}                         # scheduled vzdump jobs and their selection
proxmox_list_backups { "storage": "<pbs-storage>" } # backup inventory
```

The safe-write tier needs `confirm: true` on every call. A `WriteGateError` fires *before any HTTP traffic* if the flag is missing, so a hallucinated tool call can't accidentally mutate the host. A representative safe-write workflow, snapshot then act then verify:

```
proxmox_snapshot_resource { "vmid": 105, "snapname": "pre-maint", "confirm": true }
proxmox_service_restart  { "vmid": 105, "service": "wazuh-manager", "confirm": true }
proxmox_service_status   { "vmid": 105, "service": "wazuh-manager", "confirm": true }
```

Provisioning a short-lived sandbox and tearing it down stays inside the safe-write tier for everything except the final delete:

```
proxmox_next_vmid {}                                                  # read
proxmox_create_container { "vmid": <new-vmid>, "confirm": true, ... } # safe-write
proxmox_start_resource   { "vmid": <new-vmid>, "confirm": true }      # safe-write
proxmox_exec { "vmid": <new-vmid>, "command": "...build...", "confirm": true }
proxmox_stop_resource    { "vmid": <new-vmid>, "confirm": true }      # safe-write
```

The guest-read tools (`proxmox_read_file`, `proxmox_stat_path`, `proxmox_list_directory`, `proxmox_service_status`) are gated with `confirm: true` too, because reading in-guest state goes through host-backed SSH and is more than a metadata peek.

### What is NOT exposed by default

The eight destructive tools cannot run on flags alone:

- `proxmox_destroy_resource` (permanent LXC/VM deletion)
- `proxmox_rollback_snapshot`
- `proxmox_delete_snapshot`
- `proxmox_force_stop_resource` (non-graceful hard stop)
- `proxmox_cleanup_smoke_resources` (bulk smoke-pool delete)
- `proxmox_delete_volume` (permanent storage-volume deletion)
- `proxmox_node_power` (reboot or shut down the whole node)
- `proxmox_delete_storage` (remove a storage definition)

`proxmox_restore_backup` is a safe write when it restores into a new VMID. Restoring over an existing VMID wipes that guest's disks, so the tool escalates to the destructive gate in that case.

Every one of them requires `confirm: true` **and** `destructive: true` **and** the process-level env flag `PROXMOX_ENABLE_DESTRUCTIVE=1` on the MCP. All three gates must be satisfied, and any one missing throws `WriteGateError` before the resource is even resolved. The env flag is a coarse "I am actively doing destructive cycles" toggle that you leave unset day to day. So an agent running with the default environment literally cannot delete a container or roll back a snapshot, no matter how it phrases the call. It can snapshot, start, stop, reboot, back up, and provision. It cannot destroy, roll back, or power off the node. (`proxmox_cleanup_smoke_resources` also defaults to `dry_run: true`, so it previews targets without the env gate at all.)

That asymmetry is the design: the common, reversible operations are one flag away, and the irreversible ones are behind a gate you have to consciously open.

Two optional features cost nothing to know about. With `PROXMOX_DEFERRED_TOOLS=1` the server advertises a single `proxmox_search_tools` tool at connect time instead of all 96 schemas (the README measures the listing dropping from about 68 KB to 1.4 KB), and the agent loads the tools it needs on demand. Visibility is a token optimization, not a gate: the three destructive gates apply unchanged. It needs a client that honors `notifications/tools/list_changed`, so test yours first. The repository also ships a read-only `proxmoxctl` CLI for shells and cron, and an authenticated Streamable HTTP mode (`proxmoxctl mcp --http`) that is on the main branch but not in a tagged release yet.

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
- **Container Nesting Enabled** (Medium, PVE-CT-002) will flag most of the containers, since 14 of 15 set `nesting=1`. The Docker-in-LXC stacks need it. For those, the finding is acknowledged. Turning it off on a container that runs no Docker is the fix worth making, and the fleet hub already does.

ProxGuard also visualizes firewall rules with conflict detection (shadowing, contradictions, unreachable rules, port overlap, protocol mismatch), which is worth a pass after you add any firewall rule for a new service.

## Verification

A full read-only sanity sweep, half through the MCP read tier and half from the host shell:

```
# Through the MCP (read tier, no flags):
proxmox_status {}                            # node up, cluster healthy
proxmox_list_containers {}                    # expected service CTs present (15 running)
proxmox_resource_usage {}                     # RAM headroom at peak
proxmox_list_snapshots { "vmid": 105 }        # a recent snapshot exists
proxmox_list_backup_jobs {}                    # the daily job exists and is enabled
proxmox_list_backups { "storage": "<pbs-storage>" }  # last backup landed
```

```bash
# From the host shell (both worlds; CTIDs and VMIDs share one pool):
ssh <host> "pct list"     # LXC containers
ssh <host> "qm list"      # VMs
ssh <host> "free -h"      # the constraint that actually matters
ssh <host> "pct exec <pbs-ctid> -- proxmox-backup-manager datastore list"
```

Confirm the agent is gated, not just trusted: with `PROXMOX_ENABLE_DESTRUCTIVE` unset, a `proxmox_destroy_resource` call (even with both flags) should throw `WriteGateError` and touch nothing. Then run a ProxGuard audit and confirm the grade is where you expect, with only the accepted PVE-CT findings (privileged PBS, nesting where Docker needs it) outstanding.

## Gotchas

1. **RAM is the ceiling, plan every addition against peak.** On a 32GB node you get ~31GiB usable and real usage sits near 23GiB with everything warm. Before the agent provisions anything, run `proxmox_resource_usage` and ask what it pushes you to at peak. The CPU is not what runs out, and the thin pool is the second thing to watch (69% used). This is why the SOC VMs live on a separate hypervisor.

2. **Privileged is an exception you justify, not a default.** Only the backup server runs privileged, because it needs UID-remapped `chown` on chunk files. ProxGuard will flag it (PVE-CT-001). That finding is accepted and documented, not silenced. If you find yourself making a *second* container privileged "to make it work," figure out the actual capability first, and consider whether you really wanted a VM.

3. **`unprivileged` can't be flipped after create.** UID mapping changes how rootfs files are owned, so privileged-vs-unprivileged is a create-time decision, not a `pct set`. For services the answer is always unprivileged.

4. **`PROXMOX_TLS_INSECURE=true` is for self-signed lab certs only.** The toggle exists because homelab Proxmox hosts usually run a self-signed cert. Set it only when that is genuinely the case, and leave it `false` in any environment with a real CA-signed cert. It is not a "make the connection work" convenience, it is an explicit "I trust this self-signed cert" statement.

5. **The destructive env gate is the seatbelt that matters.** The per-tool `confirm` and `destructive` flags are necessary but not sufficient. Leave `PROXMOX_ENABLE_DESTRUCTIVE` unset day to day so the agent structurally cannot delete or force-stop, no matter how a tool call is phrased. Flip it only for the minutes you are actively running destructive cycles, then unset it.

6. **Retired is not the same as gone from the config.** If you reuse the pattern, stopped build containers are templates, and templates rot. A `pristine` snapshot from six months ago builds against six-month-old toolchains, and the idle volume still holds thin-pool space. Refresh on a schedule or don't keep the tier.

7. **CTID and VMID share one number pool.** `pct list` shows only LXC, `qm list` shows only VMs, and they draw from the same ID space. Check both before assuming an ID is free. The MCP's `proxmox_next_vmid` handles this for you when provisioning, and the manual shell path does not. Also remember that freed IDs get reused, so an agent's notes about "VM 130" can point at a different guest after a cleanup.

8. **Start the token read-only, grade up after.** Hand the MCP a `*.Audit`-only token first, verify the read tools work end-to-end and the redactor masks your secret in transcripts, *then* grade up to power-management and snapshot rights. Tokens are revocable instantly from the Proxmox UI, so the cost of being conservative is near zero.

## Related

- [`homelab-topology.md`](homelab-topology.md) - the map: what runs in which container, the LXC/VM split, the storage and network layout
- [`service-isolation.md`](service-isolation.md) - the why: one service per container, per-container caps, and the retired ephemeral build-container pattern
- [`backup-recovery.md`](backup-recovery.md) - off-host restore mechanics and the three-copy backup design
- [`adguard-dns-sinkhole.md`](adguard-dns-sinkhole.md) - the DNS sinkhole that is one of the always-on service CTs
- [`../security/mcp-incident-response.md`](../security/mcp-incident-response.md) - driving incident response through MCP tools, the same boundary pattern applied to the SIEM
