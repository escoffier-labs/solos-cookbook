# Service Isolation: One Service Per Container

I run my homelab as a pile of small, boring, unprivileged LXC containers. One service each. Not one fat VM with a docker-compose monolith, not a single Debian box hand-fed twelve daemons. This guide is the discipline behind that choice: why I do it, where the blast radius gets drawn, and the handful of cases where a full VM is actually the right call.

This is the *why*, not the map. For the inventory of what runs where, see [`homelab-topology.md`](homelab-topology.md).

**Tested on:** Proxmox VE 9.2 on a single Intel Ultra 9 node, 32GB RAM, unprivileged LXC + a few QEMU VMs. ~8 service containers running, ~5 build containers stopped-on-demand.
**Last updated:** 2026-06-04

---

## The Rule: One Service, One Container

Every long-lived service gets its own unprivileged LXC. DNS in one, the SIEM in another, the photo server in a third, the social-automation stack in a fourth. They share a kernel (that's what makes LXC cheap) but nothing else: separate rootfs, separate network interface, separate resource caps, separate snapshot timeline.

The instinct early on is to consolidate. "Why spin up five containers when one Debian box could run all five daemons?" Because consolidation trades a one-time setup cost for a permanent operational tax, and the tax compounds every time something breaks.

### What one-service-per-container actually buys you

- **Independent restarts.** Restarting the photo server doesn't blink DNS. On a shared box, `systemctl restart` of one daemon plus a config reload that needs a reboot takes the whole household offline.
- **Independent upgrades.** I can `apt full-upgrade` the monitoring container and reboot it without touching the DNS resolver. Upgrade windows stop being all-or-nothing. (See [`upgrade-hygiene.md`](upgrade-hygiene.md) for the per-service version of this.)
- **Independent failure.** When one service eats all its RAM and gets OOM-killed, the cap is per-container. It dies alone. On a shared box, one runaway daemon starves everything.
- **Independent blast radius for me, the operator.** When I (or an agent acting on my behalf) run a destructive command, it lands in one container. `pct rollback` puts that one service back. Nothing else noticed.

That last point is the real reason. The threat model isn't just "software crashes." It's "I am tired, it is late, and I am about to paste a command I half-understand into a root shell." Isolation means that mistake costs me one service, not the whole lab. 🦞

## Blast-Radius Thinking

Draw the boundary at the unit you'd want to restore independently. For me that's "one service." Ask three questions per container:

1. **If this is compromised, what else can it reach?** A container with a NAS mount and SSH keys is a bigger prize than a stateless DNS resolver. Keep the credential-heavy services small and few, and don't co-locate a public-facing service with your secrets. This is the container-level version of the agent-side rules in [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md).
2. **If this dies, what dies with it?** The answer should be "only this service." If killing container A also kills container B, you've built a hidden monolith with extra steps. The classic trap here is shared bind-mounts (see the next section).
3. **If I have to roll this back, what state do I lose?** Snapshot scope equals blast radius. A rollback reverts everything in that container's rootfs to the snapshot point. Smaller containers mean rollbacks lose less.

### The bind-mount trap

The fastest way to accidentally couple two "isolated" containers is a shared dependency that lives outside both of them. I learned this the expensive, silent way.

My photo server (its own LXC) bind-mounts a directory from a NAS share into the container so uploads land on bulk storage. One morning the NAS CIFS mount on the Proxmox host failed to come up after a reboot race. The host mount point existed but was empty, so the container's bind-mount pointed at an empty directory. The photo server's app container couldn't create its upload path and exited. Postgres, the ML worker, and Redis in the same stack all stayed healthy and reported green. The phone app just silently stopped backing up. Nothing crashed loudly. The dependency that took the service down lived *between* the host and the container, in a place neither one's health check was watching.

Two lessons baked in:

- **A bind-mount is a dependency edge.** It couples the container to host-side state (the mount). "Isolated container" is only true until you bind-mount shared storage into it. When you do, that mount becomes part of the container's blast radius even though it isn't in the rootfs.
- **Harden the host mount so an empty mount fails loud, not quiet.** Use `x-systemd.automount` and `_netdev` so the bind-mount source is actually present before the container's storage tries to use it, and add a health check that asserts the mount is non-empty rather than just "the daemon is running."

The fix was two lines (remount the NAS share, restart the one app container). The diagnosis took an hour because everything *looked* fine. Isolation didn't fail here. It worked: only one service went down. But a hidden shared dependency is the seam where isolation leaks, so go find your bind-mounts and treat each one as a coupling you signed up for on purpose.

## Per-Container Resource Caps

Isolation without caps is a polite fiction. If every container can burst to all 32GB of host RAM, one of them will, and you're back to shared-fate. Set caps at create time and treat them as the contract.

```bash
# A small, stateless service: DNS resolver. Tiny on purpose.
pct create 100 local:vztmpl/debian-12-standard_amd64.tar.zst \
  --hostname dns \
  --cores 1 --memory 512 --swap 512 \
  --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --onboot 1 --start 1
```

```bash
# A heavy service: SIEM. Gets real resources, still capped.
pct create 105 local:vztmpl/debian-12-standard_amd64.tar.zst \
  --hostname siem \
  --cores 4 --memory 8192 --swap 512 \
  --rootfs local-lvm:50 \
  --features nesting=1,keyctl=1 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --onboot 1 --start 1
```

Adjust caps live when a service genuinely needs more, but do it deliberately:

```bash
pct set 105 --memory 8192     # bump RAM
pct set 105 --cores 4         # bump CPU
pct resize 105 rootfs +10G    # grow disk (can grow, cannot shrink)
```

Sizing principles I actually follow:

- **Default small.** A DNS resolver gets 512MB and one core. A sync helper gets 256MB. You can always `pct set` upward. Starting big just normalizes waste.
- **Disk is the cap people forget.** A container that fills its rootfs takes itself down, and if it shares the LVM-thin pool with everything else, a runaway log can starve the whole pool. Cap rootfs per service and watch pool usage, not just per-container usage.
- **`unprivileged 1` is non-negotiable for services.** An unprivileged LXC maps container root to an unprivileged host UID. If the container is popped, the attacker is `nobody` on the host, not root. The only reason to run privileged is a specific feature that needs it, and that's usually a sign you wanted a VM (see below).
- **`nesting=1` only when the service runs containers itself.** My docker-based stacks (the social-automation box runs Docker inside the LXC) need `nesting=1,keyctl=1`. Don't hand it out by default; it widens the container's capabilities.

## The Ephemeral Build-Container Pattern

Here's the pattern I'm proudest of. PR builds, smoke tests, and CI-style jobs do not get a permanent home and they do not run on a service container. They get a dedicated container that is **stopped by default** and started only for the duration of the job.

The host keeps several of these around, stopped, as ready-to-go templates. One per project that needs clean-room builds:

```
112  openclaw-prbuild   stopped   clean OpenClaw build/test sandbox
113  tokenjuice-prbuild  stopped   tokenjuice PR/build sandbox
115  mcp-smoke           stopped   MCP smoke-test sandbox
119  orca-prbuild        stopped   project build/test sandbox
120  gh-runner           stopped   CI runner sandbox
```

The workflow is: clone or reset, start, build, capture result, stop.

```bash
# Spin up a clean build CT for a PR, run the build, tear it back down.
ssh hypervisor "pct start 112"
ssh hypervisor "pct exec 112 -- bash -lc '
  cd /root/openclaw && git fetch origin && git checkout pr-branch &&
  pnpm install && pnpm build && pnpm test
'"
ssh hypervisor "pct stop 112"
```

Why a dedicated stopped container per project instead of a shared build box or just running it on the dev machine:

- **Clean room every time.** A PR build that passes only because of leftover state from the last build is a lie. A snapshot-restored or freshly-reset container guarantees the build sees what a fresh checkout sees.
- **Zero idle cost.** Stopped LXCs consume disk and nothing else. No RAM, no CPU. Keeping five of them around costs me disk I already have. They're templates that happen to also be runnable.
- **Blast radius of a build is one throwaway container.** A malicious or buggy build script (npm postinstall hooks, anyone?) runs in a container with no secrets, no NAS mount, and a firewall on its NIC. When it's done, `pct stop` and the next run starts clean. Compare to running untrusted PR builds on your actual workstation.
- **`firewall=1` on the build NIC.** Build containers get the Proxmox firewall enabled on their interface (`net0: ...,firewall=1`). A PR build does not need to phone home. Service containers I trust more; build containers I trust not at all.

### Reset between runs with snapshots

Pair build containers with a "pristine" snapshot so each run starts identical:

```bash
# One time: get the CT to a known-good state, then snapshot it.
pct snapshot 112 pristine

# Before each build job: roll back to pristine, then start.
pct rollback 112 pristine
pct start 112
# ... run build ...
pct stop 112
```

### The ephemeral-state gotcha

Ephemeral containers have a sharp edge: state you *want* to keep can live in the part of the container that gets thrown away. I hit this with a Docker-based automation service whose SSH `known_hosts` file lived in the container's writable layer rather than in a mounted data volume. Every container recreate wiped `known_hosts`, and SSH-using workflows started failing silently with host-key verification errors because the new layer didn't trust any hosts yet.

The rule that falls out: **if it's ephemeral, treat anything outside an explicit persistent volume as gone on the next reset.** For build containers that's a feature. For services that happen to recreate their app containers (Docker-in-LXC), it's a trap. Audit where each service keeps its must-survive state, and make sure it's in a named volume or a bind-mount, not the disposable layer.

## Snapshot Before Change

The cheap habit that makes everything above safe: snapshot the container before you change it.

```bash
pct snapshot 105 pre-maint-$(date +%Y%m%d-%H%M)
# ... do the risky thing: apt full-upgrade, config edit, version bump ...
# if it went sideways:
pct rollback 105 pre-maint-20260604-1430
```

Before my last host-wide maintenance window I snapshotted every service container that supported it (`pre-maint-<timestamp>`), upgraded, and verified. The snapshot timeline is per-container, so a botched upgrade on the monitoring box rolls back in seconds without touching anything else. That's isolation paying off again: a per-service rollback is only possible because services aren't sharing a rootfs.

Two caveats from the field:

- **Not every container supports snapshots.** Containers with certain mount or storage configs (some bind-mount layouts, the backup-server CT itself) can't be snapshotted on Proxmox. For those, lean on the off-host backup instead. See [`backup-recovery.md`](backup-recovery.md).
- **A snapshot is not a backup.** It lives on the same disk as the container. Disk dies, snapshot dies with it. Snapshots are for "undo my last 20 minutes." Backups are for "the node is gone." You need both, and they answer different questions.

## When a Full VM Is Actually Justified

I default to LXC, but the discipline includes knowing when LXC is the wrong tool. Reach for a QEMU VM when:

- **You need a different or custom kernel.** LXC shares the host kernel. Anything that needs its own kernel modules, a different kernel version, or kernel-level features the host doesn't expose has to be a VM.
- **The workload is a desktop or GUI.** Full desktop environments, anything wanting a real display server, and "I want a whole separate machine I can RDP into" are VM territory. I run a peer's whole separate environment as a 14GB VM precisely because it's a full OS install they manage independently, not a single service. Manage it with `qm`, not `pct`, and leave it alone during host maintenance.
- **You need hard isolation, not just namespace isolation.** Unprivileged LXC is strong, but it's still a shared kernel. For genuinely untrusted multi-tenant workloads or anything where a kernel escape is in your threat model, a VM's hardware-level boundary is worth the overhead.
- **The thing flatly refuses to run unprivileged.** Some software needs capabilities that only make sense in a VM. If you find yourself reaching for a privileged LXC to make something work, that's usually the signal to make it a VM instead. A privileged container is most of the cost of a VM with less of the isolation.

What does *not* justify a VM: "it's a big service," "it has a database," "it runs Docker." LXC handles all of those fine. Heavy and isolated are different axes. My SIEM is 8GB and 4 cores in an LXC and it's still isolated from everything else.

## Verification

Run these on the Proxmox node to confirm the isolation posture matches what this guide promises:

```bash
# One service per container: the list should read like a service inventory
pct list
qm list

# Every service container is unprivileged and capped
pct config <CTID> | grep -E 'memory|cores|unprivileged'
# expected: memory: <cap>, cores: <cap>, unprivileged: 1

# The snapshot habit is real: a pre-maint snapshot exists from the last window
pct listsnapshot <CTID>
# expected: at least one pre-maint-<timestamp> entry above "current"
```

If `pct config` shows no `unprivileged: 1` on a service container, or `pct listsnapshot` comes back empty on a box you upgraded last week, the discipline has drifted from the design.

## Gotchas

1. **CTID and VMID share one numbering pool.** On Proxmox, `pct list` shows only LXC, `qm list` shows only VMs, and they draw from the same ID space. ID 110 can be a VM while 111 and 112 are containers. Always check *both* before assuming an ID is free or "doesn't exist."

2. **A bind-mount is a coupling, not a convenience.** Every shared mount you bind into a container extends that container's blast radius to include host-side state. Inventory them. The silent failures (empty mount after a boot race) are the ones that cost you an afternoon.

3. **Stopped build containers still need upkeep.** They're templates, but a `pristine` snapshot from six months ago builds against six-month-old toolchains. Periodically start, update, re-snapshot, stop. Otherwise your "clean room" is a museum.

4. **`unprivileged 1` can't always be toggled after create.** Flipping a container between privileged and unprivileged isn't a simple `pct set`; UID mapping changes how files on the rootfs are owned. Decide at create time. For services, the answer is always unprivileged.

5. **Resource caps are a contract you have to enforce.** Setting `--memory 512` caps the container, but a service that genuinely needs more will OOM-loop quietly inside its cap. Cap deliberately, then actually watch for the service hitting the ceiling instead of assuming the number you picked at 2am was right.

6. **Snapshot before change is a habit, not a feature you enable.** Proxmox won't snapshot for you. The discipline is yours: `pct snapshot` before every upgrade, config edit, or risky command. The five seconds it costs is the cheapest insurance in the lab.

## Related

- [`homelab-topology.md`](homelab-topology.md) - the actual map: what runs in which container, the hypervisor layout, the LXC/VM split
- [`backup-recovery.md`](backup-recovery.md) - off-host backups for the state snapshots can't protect
- [`upgrade-hygiene.md`](upgrade-hygiene.md) - per-service upgrade windows, which isolation makes possible
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - the agent-side blast-radius rules that pair with container-side isolation
