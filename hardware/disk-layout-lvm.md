# Disk Layout with LVM

> Two NVMe drives, one volume group, one growable home. The installer's default LVM is a trap. Lay this out by hand once and you'll never have to resize on a Sunday afternoon.

## What this is

A two-disk LVM layout for a single agent host. The OS sits on a fixed partition on the first drive. The data partition spans both drives through one volume group. You can grow the data pool by adding a third drive without touching root, and you can reinstall the OS without nuking data.

This is the layout in production. It is unfashionable. It is also boring, which is the entire point.

## Why this way

The fashionable alternatives all lose:

| Layout | Why people pick it | Why it loses |
|--------|--------------------|--------------|
| Single big root partition | Installer default, one less abstraction | Reinstall destroys data; `apt clean` does not save you when /home fills root |
| Two unrelated partitions | "Simple" | First time `/home` fills up you start moving directories with symlinks |
| ZFS root | Snapshots, send/recv, looks clever | Out-of-tree DKMS module; one kernel upgrade kills the boot |
| btrfs everywhere | Built-in snapshots | The agent writes a lot of small files; btrfs metadata cost shows up in latency |
| LVM with thin pools | Snapshots, overprovisioning | Thin pools that fill up corrupt everything; thick LVs are predictable |
| RAID 1 across both drives | "Survives a drive failure" | Doubles cost per byte; cold backups already solve the failure mode you care about |

The chosen layout: a fixed ext4 root on partition 2 of drive 1, an EFI partition on partition 1 of drive 1, and an LVM physical volume on the remainder of drive 1 plus all of drive 2. One volume group, one thick logical volume formatted ext4, mounted at `/home`. Cold backups via restic to a NAS and to cloud handle the disk-failure case (see [`infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md)).

You give up snapshots, send/recv, and any survives-a-drive-failure story. You get a layout that boots with one drive present, grows by adding more physical volumes, and reinstalls cleanly when needed.

## Prerequisites

- Two NVMe SSDs of the same size, both visible to the installer
- Ubuntu 24.04 Desktop install media
- Comfort with the manual partitioning screen
- A pre-installed backup target (NAS, USB drive, second machine) before you trust this with real data

## Before / After

**Before:** the installer's default LVM. One 100 GB root logical volume in a 1 TB volume group, 900 GB of free PE that has to be `lvextend`-ed manually. `/home` is inside root. Anything that fills `/home` fills root.

**After:** EFI on `nvme0n1p1`, ext4 root on `nvme0n1p2`, LVM on `nvme0n1p3` + `nvme1n1p1`. Volume group spans both drives, one large `home-lv` formatted ext4 mounted at `/home`. Root cannot fill. Data grows by extending the volume group.

```
nvme0n1               953 GiB                                  disk
├─nvme0n1p1               1 GiB  vfat        /boot/efi          part
├─nvme0n1p2             101 GiB  ext4        /                  part
└─nvme0n1p3             852 GiB  LVM2_member                    part
  └─home-lv             1.8 TiB  ext4        /home              lvm
nvme1n1               953 GiB                                  disk
└─nvme1n1p1             953 GiB  LVM2_member                    part
  └─home-lv             1.8 TiB  ext4        /home              lvm
```

The two PVs merge into one LV. `/home` reads from both drives in parallel for sequential workloads.

## Implementation

### Partition during install

Boot the Ubuntu installer, choose "Something else" or "Manual" partitioning. Do not let the installer pick LVM for you.

On `nvme0n1`:

| Number | Size | Type | Use as | Mount |
|--------|------|------|--------|-------|
| 1 | 1 GiB | EFI System Partition | EFI System Partition | `/boot/efi` |
| 2 | 100 GiB | ext4 | Format ext4 | `/` |
| 3 | rest of disk | Reserved for LVM | leave unformatted | (none) |

On `nvme1n1`:

| Number | Size | Type | Use as | Mount |
|--------|------|------|--------|-------|
| 1 | whole disk | Reserved for LVM | leave unformatted | (none) |

The installer will not let you create an LVM PV directly. That is fine: finish the install with just root + EFI, then create the volume group from a live terminal after first boot.

### Build the volume group after first boot

```bash
sudo apt install -y lvm2

# Mark both partitions as LVM PVs.
sudo pvcreate /dev/nvme0n1p3 /dev/nvme1n1p1

# Create one volume group spanning both PVs. Name it something specific to this host.
sudo vgcreate claw-vg /dev/nvme0n1p3 /dev/nvme1n1p1

# Carve one logical volume that takes all free extents.
sudo lvcreate -l 100%FREE -n home-lv claw-vg

# Format and mount.
sudo mkfs.ext4 -L home /dev/claw-vg/home-lv
sudo mkdir -p /mnt/home-new
sudo mount /dev/claw-vg/home-lv /mnt/home-new
```

### Migrate /home onto the LV

The first install put `/home` inside `/`. Move it.

```bash
# Make sure nothing in /home is open.
sudo systemctl isolate multi-user.target          # GUI off
sudo loginctl terminate-user agentuser || true      # User session out

# Copy everything across, preserving everything.
sudo rsync -aHAXxv /home/ /mnt/home-new/

# Sanity check before you cut over.
sudo diff -r /home /mnt/home-new | head -20

# Unmount, swap, remount permanently.
sudo umount /mnt/home-new
sudo mv /home /home.old
sudo mkdir /home
echo '/dev/claw-vg/home-lv  /home  ext4  defaults  0  2' | sudo tee -a /etc/fstab
sudo mount -a

# Verify, then nuke the old copy.
df -h /home
sudo rm -rf /home.old
```

Reboot once. If the box comes up clean and `/home` is on the LV, you are done.

### Growing the pool later

Two ways to grow `/home` once it fills:

```bash
# 1. Add a third drive. After installing it physically:
sudo pvcreate /dev/nvme2n1p1
sudo vgextend claw-vg /dev/nvme2n1p1
sudo lvextend -l +100%FREE /dev/claw-vg/home-lv
sudo resize2fs /dev/claw-vg/home-lv

# 2. Replace a smaller drive with a larger one. After cloning the partition table:
sudo pvresize /dev/nvme0n1p3        # If you grew that partition
sudo lvextend -l +100%FREE /dev/claw-vg/home-lv
sudo resize2fs /dev/claw-vg/home-lv
```

Both run online. No reboot, no unmount, no downtime for the agent.

## Verification

```bash
# Both PVs are present and clean.
sudo pvs

# Volume group has both PVs and no free extents.
sudo vgs claw-vg

# Logical volume is mounted at /home.
findmnt /home

# Filesystem is healthy.
sudo tune2fs -l /dev/claw-vg/home-lv | grep -E 'Filesystem state|Last checked'

# /boot/efi and / are on partition 1 and 2 of the same NVMe.
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,TYPE
```

A healthy layout shows two PVs, one VG, one LV at 100 % usage of the VG, `/home` mounted ext4 with state "clean."

## Gotchas

**You cannot boot if `/boot/efi` is on the LV.** Keep the EFI partition outside LVM, on the first drive, formatted vfat. Some installers will helpfully suggest putting `/boot` inside LVM. Decline. Grub can find LVM root, but UEFI cannot find an EFI partition that lives inside LVM.

**Removing a drive from the VG is destructive if any LV extent lives on it.** Before pulling a drive (RMA, capacity upgrade), run `pvmove /dev/<old> /dev/<new>` to evacuate extents. `vgreduce` only works on PVs that have zero allocated extents.

**ext4 resize is online, xfs grow is online, btrfs shrink is not.** If you picked btrfs for the home LV for snapshots, you cannot shrink it later. ext4 supports online grow and offline shrink. Stick with ext4 unless you have a specific reason not to.

**The installer wipes partition signatures even if you set "do not format."** Run a `sfdisk -d /dev/nvme0n1 > parttable.bak` of the disks before launching the installer if you have data on them. Recovering from a wiped partition table is doable; not having to is better.

**`pvremove` on a non-empty PV looks like it worked.** It will refuse, but the message scrolls past the install summary. Always check `pvs` after a partition change. If the PV reappears with old metadata after a reboot, you skipped the empty check.

**Drive enumeration is not stable across BIOS firmware updates.** `nvme0n1` can become `nvme1n1` after a UEFI update on some boards. `/etc/fstab` should mount by UUID or by LVM device name (`/dev/claw-vg/home-lv`), never by `/dev/nvmeXn1pN`. Same applies to `/etc/crypttab` if you encrypt.

**LVM PV header lives in the first 1 MiB of the partition.** A `dd` to an LVM-backed partition does not destroy your data immediately. It destroys the PV header, and LVM stops seeing the volume on next reboot. You can recover with `pvcreate --uuid ... --restorefile` from a metadata backup in `/etc/lvm/archive/`. Back those up to off-host before you ever touch a PV.

## Templates

LVM does not need a template - the commands above are the template. Pair this guide with:

- [`../infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md) for what to back up off the LV
- [`../templates/security/`](../templates/security/) for the post-incident note format when a disk does fail

## Related

- [`bare-metal-setup.md`](bare-metal-setup.md) - hardware spec and OS install that this layout fits inside
- [`kernel-tuning.md`](kernel-tuning.md) - `vm.dirty_*` tuning that interacts with the LV's write cache behavior
- [`../infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md) - why the disk-failure case is solved by backups, not RAID
