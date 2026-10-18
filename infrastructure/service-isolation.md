# Service Isolation: One Service Per Container

I run my homelab as a pile of small, boring, unprivileged LXC containers. One service each. Not one fat VM with a docker-compose monolith, not a single Debian box hand-fed twelve daemons. This guide is the discipline behind that choice: why I do it, where the blast radius gets drawn, and the handful of cases where a full VM is actually the right call.

This is the *why*, not the map. For the inventory of what runs where, see [`homelab-topology.md`](homelab-topology.md).

**Tested on:** Proxmox VE 9.2 on a single Intel Ultra 9 node, 32GB RAM, unprivileged LXC plus two QEMU VMs. 15 service containers running. The stopped-on-demand build container tier described in earlier versions of this guide is retired (see below).
**Last updated:** 2026-10-17

---

## The Rule: One Service, One Container

Every long-lived service gets its own unprivileged LXC. DNS in one, the SIEM in another, the photo server in a third, the automation stack in a fourth. They share a kernel (that's what makes LXC cheap) but nothing else: separate rootfs, separate network interface, separate resource caps, separate snapshot timeline.

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
- **`nesting=1` only when the service runs containers itself.** My docker-based stacks (the automation box runs Docker inside the LXC) need `nesting=1,keyctl=1`. The fleet hub, which runs no containers, has `nesting=0`. Don't hand it out by default, because it widens the container's capabilities.

## The Ephemeral Build-Container Pattern (Retired)

Earlier versions of this lab ran a tier of PR-build and smoke-test containers. Each was **stopped by default** and started only for the duration of a job, with a `pristine` snapshot rolled back before every run. That whole tier was destroyed in a September 2026 cleanup, and none of it exists today. I'm keeping the pattern here as history and as a recipe, because the isolation reasoning still holds and you may want it on a bigger box.

What it looked like: one stopped container per project that needed clean-room builds, plus a smoke-test container for MCP integration tests and a QEMU smoke template. The workflow was reset, start, build, capture, stop:

```bash
# Spin up a clean build CT for a PR, run the build, tear it back down.
ssh hypervisor "pct rollback <ctid> pristine && pct start <ctid>"
ssh hypervisor "pct exec <ctid> -- bash -lc '
  cd /root/project && git fetch origin && git checkout pr-branch &&
  pnpm install && pnpm build && pnpm test
'"
ssh hypervisor "pct stop <ctid>"
```

Why it was worth doing while it lasted:

- **Clean room every time.** A PR build that passes only because of leftover state from the last build is a lie. A snapshot-restored container sees what a fresh checkout sees.
- **Zero idle RAM.** Stopped LXCs consume disk and nothing else.
- **Blast radius of a build was one throwaway container.** A buggy build script (npm postinstall hooks, anyone?) ran in a container with no secrets, no NAS mount, and `firewall=1` on its NIC.

What it cost, and why I don't run it now:

- **Disk is not free.** A stopped container still holds its full volume on the thin pool, and the pool is now about two-thirds full.
- **Templates rot.** A `pristine` snapshot from months ago builds against months-old toolchains. Without a scheduled refresh, the clean room turns into a museum.
- **The IDs get reused.** Three of the freed IDs now belong to long-lived library containers, so the old numbering no longer reads as a build tier.

If you do keep a tier like this, schedule the start, update, re-snapshot, stop cycle so the snapshots stay current, and keep the build NIC firewalled. The one container from that era that survived is the CI runner, which now runs as an ordinary always-on service container.

### The ephemeral-state gotcha

Ephemeral containers have a sharp edge: state you *want* to keep can live in the part of the container that gets thrown away. I hit this with a Docker-based automation service whose SSH `known_hosts` file lived in the container's writable layer rather than in a mounted data volume. Every container recreate wiped `known_hosts`, and SSH-using workflows started failing silently with host-key verification errors because the new layer didn't trust any hosts yet.

The rule that falls out: **if it's ephemeral, treat anything outside an explicit persistent volume as gone on the next reset.** For disposable build containers that was a feature. For services that recreate their app containers (Docker-in-LXC), it's a trap, and it still applies to the automation and photo stacks today. Audit where each service keeps its must-survive state, and make sure it's in a named volume or a bind-mount, not the disposable layer.

## Snapshot Before Change

The cheap habit that makes everything above safe: snapshot the container before you change it.

```bash
pct snapshot 105 pre-maint-$(date +%Y%m%d-%H%M)
# ... do the risky thing: apt full-upgrade, config edit, version bump ...
# if it went sideways:
pct rollback 105 pre-maint-20261003-1430
```

Before each host-wide maintenance window I snapshot every service container that supports it, upgrade, and verify. The October 2026 windows used `pre-fleet-update-20261003` and `pre-vendor-update-20261003`, one name per batch of containers. The snapshot timeline is per-container, so a botched upgrade on the monitoring box rolls back in seconds without touching anything else. That's isolation paying off again: a per-service rollback is only possible because services aren't sharing a rootfs.

Two caveats from the field:

- **Not every container supports snapshots.** Containers with certain mount or storage configs (some bind-mount layouts, the backup-server CT itself) can't be snapshotted on Proxmox. For those, lean on the off-host backup instead. See [`backup-recovery.md`](backup-recovery.md).
- **A snapshot is not a backup.** It lives on the same disk as the container. Disk dies, snapshot dies with it. Snapshots are for "undo my last 20 minutes." Backups are for "the node is gone." You need both, and they answer different questions.

## When a Full VM Is Actually Justified

I default to LXC, but the discipline includes knowing when LXC is the wrong tool. Reach for a QEMU VM when:

- **You need a different or custom kernel.** LXC shares the host kernel. Anything that needs its own kernel modules, a different kernel version, or kernel-level features the host doesn't expose has to be a VM.
- **The workload is a desktop or GUI.** Full desktop environments, anything wanting a real display server, and "I want a whole separate machine I can RDP into" are VM territory. I run a peer's whole separate environment as an 8GB VM precisely because it's a full OS install they manage independently, not a single service. Manage it with `qm`, not `pct`, and leave it alone during host maintenance.
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

# The snapshot habit is real: a pre-change snapshot exists from the last window
pct listsnapshot <CTID>
# expected: at least one dated pre-update entry above "current"
```

If `pct config` shows no `unprivileged: 1` on a service container, or `pct listsnapshot` comes back empty on a box you upgraded last week, the discipline has drifted from the design.

## Gotchas

1. **CTID and VMID share one numbering pool.** On Proxmox, `pct list` shows only LXC, `qm list` shows only VMs, and they draw from the same ID space. ID 110 can be a VM while 109 and 111 are containers. Always check *both* before assuming an ID is free or "doesn't exist."

2. **A bind-mount is a coupling, not a convenience.** Every shared mount you bind into a container extends that container's blast radius to include host-side state. Inventory them. The silent failures (empty mount after a boot race) are the ones that cost you an afternoon.

3. **Stopped containers still need upkeep, and they still cost disk.** This is the lesson of the retired build tier. A `pristine` snapshot from six months ago builds against six-month-old toolchains, and the idle volume holds thin-pool space the whole time. Refresh on a schedule or don't keep the tier.

4. **`unprivileged 1` can't always be toggled after create.** Flipping a container between privileged and unprivileged isn't a simple `pct set`. UID mapping changes how files on the rootfs are owned. Decide at create time. For services, the answer is always unprivileged.

5. **Resource caps are a contract you have to enforce.** Setting `--memory 512` caps the container, but a service that genuinely needs more will OOM-loop quietly inside its cap. Cap deliberately, then actually watch for the service hitting the ceiling instead of assuming the number you picked at 2am was right.

6. **Snapshot before change is a habit, not a feature you enable.** Proxmox won't snapshot for you. The discipline is yours: `pct snapshot` before every upgrade, config edit, or risky command. The five seconds it costs is the cheapest insurance in the lab.

## Related

- [`homelab-topology.md`](homelab-topology.md) - the actual map: what runs in which container, the hypervisor layout, the LXC/VM split
- [`backup-recovery.md`](backup-recovery.md) - off-host backups for the state snapshots can't protect
- [`upgrade-hygiene.md`](upgrade-hygiene.md) - per-service upgrade windows, which isolation makes possible
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - the agent-side blast-radius rules that pair with container-side isolation
