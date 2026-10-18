# NAS and Network Storage Mounts

How to wire network storage into a Linux host so a powered-off peer never hangs your boot, an agent never deletes irreplaceable data, and a consumer NAS never silently corrupts a backup chunkstore. This is the **mount layer**, not the backup pipeline. The restic schedule, encryption, and disaster recovery live in [`backup-recovery.md`](backup-recovery.md) and I link to it below instead of repeating it.

**Tested on:** Ubuntu 24.04 agent host, a consumer SMB/CIFS NAS, a Windows daily-driver desktop sharing two SMB drives, and Proxmox LXC containers bind-mounting the NAS. SMB 3.1.1, `cifs-utils`, systemd automount.
**Last updated:** 2026-10-17

---

## The Core Problem

A homelab has machines that come and go. The NAS reboots for firmware. The desktop gets shut down at night. If you put a naive `cifs` line in `/etc/fstab`, a peer being offline at boot turns into a hung mount unit, a 90-second systemd timeout, and sometimes a shell that freezes the moment something `ls`-es the dead mountpoint. The whole design goal here is: **an offline peer should be a no-op, not an incident.**

The option strings below are the actual value of this guide. Copy them exactly. Every flag earns its place.

## The fstab Pattern

Three real lines from a live host, IPs, usernames, and paths sanitized but every mount option kept verbatim. One is the guest-auth NAS, the other two are the two drives the Windows desktop shares:

```fstab
# Guest-auth NAS share, used for backups and bulk storage
//192.0.2.70/share /mnt/nas cifs guest,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,nofail,x-systemd.automount,x-systemd.idle-timeout=300 0 0

# Credentials-file desktop shares, one line per drive (share names are placeholders)
//192.0.2.61/data1 /mnt/desktop/data1 cifs credentials=/etc/smbcreds-desktop,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,nofail,x-systemd.automount,x-systemd.idle-timeout=300 0 0
//192.0.2.61/data2 /mnt/desktop/data2 cifs credentials=/etc/smbcreds-desktop,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,nofail,x-systemd.automount,x-systemd.idle-timeout=300 0 0
```

### Why each option is there

| Option | What it buys you |
|--------|------------------|
| `nofail` | Boot continues even if the share is unreachable. Without this, a powered-off NAS drops you to an emergency shell at boot. Non-negotiable for peer storage. |
| `x-systemd.automount` | The mount is **lazy**. systemd creates an autofs trigger at the mountpoint and only mounts on first access. A dead peer costs nothing until something actually touches `/mnt/nas`. |
| `x-systemd.idle-timeout=300` | After 5 minutes idle, unmount. Combined with automount, a flaky peer self-heals: the stale mount gets torn down and the next access remounts cleanly instead of returning `ESTALE` forever. |
| `uid=1000,gid=1000` | CIFS has no real Unix ownership over guest SMB, so the kernel fakes it. Pin everything to your user so files are readable without `sudo`. |
| `file_mode=0644,dir_mode=0755` | Same reason. Presents sane permissions on a filesystem that does not carry them. |
| `guest` vs `credentials=` | Guest auth for an open household NAS, a root-owned `chmod 600` credentials file for an authenticated share. Never inline `username=`/`password=` in fstab, it is world-readable. |

### The credentials file

For the authenticated desktop shares (both lines reference the same file):

```bash
sudo tee /etc/smbcreds-desktop >/dev/null <<'EOF'
username=youruser
password=yourpassword
domain=WORKGROUP
EOF
sudo chown root:root /etc/smbcreds-desktop
sudo chmod 600 /etc/smbcreds-desktop
```

Point `credentials=` at it, the same path the fstab line above uses. Mode `600`, root-owned. If the path in fstab is wrong or unreadable the mount fails closed, which with `nofail` is silent, so verify with the commands in [Verification](#verification).

### Apply without rebooting

```bash
sudo systemctl daemon-reload     # regenerate the .automount units from fstab
sudo systemctl restart remote-fs.target
ls /mnt/nas                       # first access triggers the actual mount
```

## Soft Mounts vs Hard Mounts

The live mounts report `rw,vers=3.1.1,soft,actimeo=1,rsize=4194304,wsize=4194304`. Note the `rw`: nothing here is mounted read-only. The two flags that matter operationally:

- **`soft`** (the kernel default for CIFS): an I/O operation that the server stops answering eventually returns an error to the application instead of blocking forever. On a consumer NAS that reboots for firmware or just wedges under load, `soft` is what you want. A `hard` mount retries indefinitely, and a process stuck in uninterruptible sleep (`D` state) on a dead NAS cannot even be `kill -9`'d. The tradeoff: `soft` can surface a transient blip as an I/O error mid-write. That is acceptable for a read tier and for backup mirrors that retry on the next schedule. It is **not** acceptable for a live database on the share, but you should not be putting one there anyway.
- **`actimeo=1`**: attribute cache lifetime of one second. Low so directory listings stay fresh across machines. Crank it up only if you are seeing metadata-chatter latency and you control all writers.
- **`rsize`/`wsize=4194304`**: 4 MiB read/write buffers, negotiated up from the old 1 MiB default. Bigger sequential transfers, which is what backup mirrors and media reads do.

## Write Policy for the Agent Host

The NAS holds irreplaceable personal data: family photos and phone backups that exist nowhere else. My rule is that **the NAS is treated as read-only from the agent host, and only the backup jobs and the photo-library service are allowed to write to it.**

Be clear about what kind of rule that is. **It is a convention, not a mount option.** The live mount is `rw`, because the restic jobs write their repository to the same share. A kernel-level guard would break them. So the guard is layered:

- **Agent policy.** Any `mv`, `rm`, or rename under the NAS mount is a confirmation-required action. A small model with a writable mount and a vague cleanup instruction will eventually `rm` something it should not. I have watched an agent find a destructive endpoint and call it three times unprompted, and I assume the same energy applied to a filesystem.
- **An independent copy.** The photo archive is also backed up to an add-only encrypted repo off-site (see [`backup-recovery.md`](backup-recovery.md#the-encrypted-photo-archive)). A deletion on the NAS is recoverable, which matters more than any flag.
- **Evidence before cleanup.** Before deleting anything on the NAS, confirm a recent backup or restore result. Never delete the restic repository directory as generic cleanup.

The stronger design, which I have not built, is to split access: a read-only general mount for everything, plus a separate authenticated writable mount that only the backup service uses. If you want the read-only half of that today, there are two options. Mount a second read-only view with its own fstab line (`ro` in the options). Or, optionally, bind-mount the existing mount read-only for one tool:

```bash
sudo mkdir -p /mnt/nas-ro
sudo mount --bind /mnt/nas /mnt/nas-ro
sudo mount -o remount,ro,bind /mnt/nas-ro       # the remount is what makes it stick
```

I do not run that bind mount on my host. It is an optional hardening step, and the gotcha below applies if you do: `mount --bind -o ro` alone does not honor `ro`.

## Mounting NAS Storage Into Hypervisor Containers

The common homelab move: mount the NAS on the hypervisor host once, then bind-mount it into the LXC containers that need it (a photo server, a backup mirror). This is correct, but it has a sharp failure mode.

One permission detail first. An unprivileged container sees the CIFS files under remapped UIDs. My photo server could write uploads but failed when preserving timestamps with `EPERM: operation not permitted, utime`. Adding `noperm` to the hypervisor's CIFS mount options fixed it, because it stops the client from enforcing Unix permission checks that the share cannot honor anyway.

**The bind-mount inherits the host mount's liveness.** If the host's CIFS mount to the NAS drops (NAS reboot, network blip), the container's bind-mount does not error cleanly, it points at an empty directory. A service inside the container that expects files there can crash, while its sibling services on the same container keep running and look healthy. That asymmetry is the trap: a photo server's web frontend dies on a missing upload path while its database, cache, and ML worker stay green, so your fleet health check reads "mostly fine" and you chase the wrong thing.

Recovery and hardening:

1. **Order the dependency.** The container's service must start *after* the host mount is live. Use `x-systemd.automount` on the host (so the mount is always available on demand) and a `RequiresMountsFor=` or an explicit healthcheck in the container's compose that fails fast if the bind target is empty.
2. **Fail loud, not partial.** Add a sentinel file on the NAS share (e.g. `/mnt/nas/.mounted`) and have the container check for it before starting the service. An empty bind target means the host mount is down. Refuse to start rather than write into a phantom directory.
3. **Recovery is two lines.** Remount on the host, restart the affected container service:
   ```bash
   sudo mount -a                                   # re-trigger the automount on the host
   pct exec <ctid> -- systemctl restart <service>  # or: docker compose restart <svc>
   ```
4. **Harden fstab against the boot race.** The same `nofail,x-systemd.automount` pattern that protects the host also protects the container, because the bind target is never permanently broken, only lazily mounted.

## PBS on a NAS: Resilience and What Not to Do

If you run Proxmox Backup Server, you will be tempted to put its datastore directly on the NAS over NFS. **Do not, on consumer firmware.** This is a hard-won lesson.

PBS stores backups as content-addressed chunks and commits each chunk with a write-then-`rename` pattern. A consumer NAS's NFS server (2016-era firmware here) cannot do that reliably:

- Attribute caching returned stale `readdir` entries, surfacing as `mkstemp ... failed: ENOENT`. Mountable around with `lookupcache=none,acdirmin=0,acdirmax=0`, but that only fixed half of it.
- The atomic `rename` of chunk files still failed (`Atomic rename failed ... No such file or directory`) even with strict caching off. The firmware's metadata layer does not commit the rename atomically across the NFS server. There is no mount option that fixes a firmware limitation.

The working design (**Path B**) keeps PBS off the NAS entirely:

- **PBS datastore lives on local fast storage** (LVM-thin), where chunk dedup and rename work correctly and a backup costs only changed chunks.
- **The NAS is at most a mirror tier, not the live datastore.** A weekly `rsync` of the local datastore to the NAS over the existing **CIFS** mount (not NFS) ships only changed chunks. Because PBS chunk filenames are content hashes, unchanged chunks keep their names and mtimes and rsync skips them, so dedup carries through the mirror for free.
- **Current state.** The daily job writes to the local datastore. The weekly mirror of that datastore to Google Drive has been off since August 2026 because it exceeded the shared rclone client's API quota. Re-enabling it needs a private OAuth client ID and one full manual sync that finishes cleanly. Until then the datastore is a single local copy. See [`backup-recovery.md`](backup-recovery.md#proxmox-backup-server).
- **Guest permission gotcha:** on the NAS, "Guest Permission: Forced" maps all writes to `nobody` (65534), so PBS's `chown 34:34` on chunk files fails with `EPERM`. Set guest permission to **Ignored** so the real UID survives the export. This bites CIFS writes too, not just NFS.

The general principle: a consumer NAS is excellent dumb bulk storage and a fine `rsync`/restic *target*. It is a poor *live datastore* for anything that depends on atomic metadata semantics. Keep the smart storage local, mirror the dumb copy to the NAS.

## Capacity Monitoring When Shares Run Hot

Homelab storage lives at the edge of full. Rough numbers from this fleet: the NAS around two thirds full, and the two desktop drives both above 90%. At those levels two things go wrong: writes start failing unpredictably, and `rsync`/restic runs that normally fit suddenly do not.

Monitor across the mounts, not just local disk:

```bash
# Human-readable usage across every network mount
df -h --output=target,size,used,avail,pcent /mnt/nas /mnt/desktop/* 2>/dev/null

# Alert threshold: anything over 90% is a same-week problem
df --output=target,pcent /mnt/nas | awk 'NR>1 && $2+0 >= 90 {print "FULL: "$1" "$2}'
```

A few hard-learned rules for hot shares:

- **A 92%-full share has effectively zero headroom for a media import or a large rsync.** Rebalance *before* the write, not after it fails. Point new writes at the roomiest target.
- **Mind which app stages where.** A download client defaulting its staging path onto the most-full drive is a slow-motion outage. Stage to the drive with room, then move.
- **Moving files between category paths can trigger mass relocation.** Changing a managed save path made a download client try to relocate thousands of existing files across drives at once. Clear the path, restart, move only what you mean to.
- **Make the agent watch it.** A scheduled job that runs the `df` check above and reports anything over 90% turns "the NAS filled up silently" into a chat nudge. Pair it with the backup freshness check in [`backup-recovery.md`](backup-recovery.md#monitoring-the-backups).

## Verification

```bash
echo "=== fstab automount units generated ==="
systemctl list-unit-files 'mnt-*.automount' --no-legend || echo "no automount units"

echo ""
echo "=== Mounts live and their options ==="
findmnt -t cifs -o TARGET,SOURCE,FSTYPE,OPTIONS

echo ""
echo "=== Confirm soft + version + buffer sizes on the NAS ==="
findmnt -no OPTIONS /mnt/nas | tr ',' '\n' | grep -E 'soft|hard|vers|actimeo|[rw]size'

echo ""
echo "=== Capacity across network mounts (flag >= 90%) ==="
df -h --output=target,pcent /mnt/nas /mnt/desktop/* 2>/dev/null

echo ""
echo "=== Confirm the write policy is a convention (expect rw) ==="
findmnt -no OPTIONS /mnt/nas | tr ',' '\n' | grep -E '^(rw|ro)$'

echo ""
echo "=== Credentials file is locked down ==="
sudo stat -c '%a %U %n' /etc/smbcreds-desktop 2>/dev/null || echo "no creds file (guest-only setup)"

echo ""
echo "=== Offline-peer safety: nofail present on every cifs line ==="
grep cifs /etc/fstab | grep -q nofail && echo "OK: nofail set" || echo "WARN: a cifs line is missing nofail, boot can hang"
```

## Gotchas

1. **`nofail` is the difference between a slow boot and an emergency shell.** A `cifs` line without `nofail` will drop the host to a rescue prompt when the peer is off. Every network mount in a homelab needs it.

2. **`x-systemd.automount` makes a dead peer free.** Without it the mount is attempted at boot and a missing NAS costs a 90-second timeout. With it, nothing happens until first access. The pair `nofail` + `x-systemd.automount` + `x-systemd.idle-timeout` is the whole pattern, do not drop one.

3. **Prefer `soft` for a consumer NAS.** A `hard` CIFS mount on a NAS that reboots leaves processes wedged in uninterruptible sleep that even `kill -9` will not clear, and only a reboot recovers. `soft` returns an I/O error instead. Worth the small risk of a transient error on a flaky write.

4. **`mount --bind -o ro` does not actually go read-only.** Bind mounts ignore `-o ro` on the initial mount. You must `mount -o remount,ro,bind` afterward. People ship "read-only" agent mounts that are silently writable because of this. The `/mnt/nas-ro` view in this guide is optional and not part of my live setup.

5. **A bind-mount into a container fails partial, not clean.** When the host's NAS mount drops, the container's bind target becomes an empty directory and one service crashes while its siblings stay green. Your health check lies to you. Add a sentinel-file check so the service refuses to start on an empty target.

6. **Never inline SMB credentials in fstab.** `/etc/fstab` is world-readable. Use a root-owned `chmod 600` `credentials=` file, or guest auth for an open share.

7. **Consumer NAS NFS cannot host a PBS datastore.** Write-then-rename chunk commits fail atomically on old firmware no matter what mount options you throw at it. Keep PBS on local storage and `rsync`/CIFS-mirror to the NAS instead. See [PBS on a NAS](#pbs-on-a-nas-resilience-and-what-not-to-do).

8. **"Guest Permission: Forced" breaks ownership-sensitive writes.** It maps everything to `nobody`, so any `chown` (PBS chunk files, anything UID-sensitive) fails with `EPERM`. Set it to **Ignored** on the NAS.

9. **"Read-only by default" is a convention here, not a mount flag.** The mount is `rw` because the backup jobs write to it. Check with `findmnt -no OPTIONS /mnt/nas` rather than trusting the policy text. The irreplaceable personal data on that share is why the policy exists, and why the off-site add-only photo repo matters more than any flag.

10. **Hot shares fail writes unpredictably.** At 90% or more full, plan the move before the write. Monitor `df` across all mounts on a schedule and alert, do not wait to discover a 92%-full share when an import fails halfway.

## Related

- [`backup-recovery.md`](backup-recovery.md) - the restic pipeline that writes to this NAS: NAS, cloud, and add-only photo repos, Brigade runbook schedules, PBS, Drive quota gotchas, KeePass canonical sync, restore rehearsal, and full disaster recovery. This guide is the mount layer underneath it.
- [`openclaw-host-topology.md`](openclaw-host-topology.md) - where these mounts sit in the agent host's overall service and config layout.
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - scheduling the capacity-monitor and backup-freshness checks.
