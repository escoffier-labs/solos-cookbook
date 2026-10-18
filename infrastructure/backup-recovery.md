# Backup & Recovery

How to protect your OpenClaw workspace, configuration, and memory from data loss. Encrypted backups, restore testing, and disaster recovery planning.

**Tested on:** OpenClaw 2026.10.4, brigade 0.28.0, restic with rclone, Ubuntu 24.04. Three encrypted restic repositories (a local SMB NAS, a cloud repo on Google Drive, and an add-only photo archive), a Proxmox Backup Server for the hypervisor guests, and a separate two-minute canonical sync for a KeePass database.
**Last updated:** 2026-10-17

---

## What Needs Backup

Your OpenClaw instance has three categories of data, each with different backup priorities:

### Critical (Lose This, Start Over)

| Data | Location | Why Critical |
|------|----------|-------------|
| OpenClaw config | `~/.openclaw/openclaw.json` | Agent definitions, model assignments, channel tokens, all settings |
| OpenClaw state databases | `~/.openclaw/` (SQLite files) | Sessions, auth profiles, cron store. Back up a consistent copy, not the live file (see [Consistent state staging](#consistent-state-staging)) |
| Workspace files | `~/.openclaw/workspace/` | SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, all personality and operational files |
| Knowledge cards | `~/.openclaw/workspace/memory/cards/` | Curated long-term memory, hard to reconstruct |
| Skills | `~/.openclaw/workspace/skills/` | Custom skills you've written or configured |
| SSH keys | `~/.ssh/` | Access to remote machines |
| Secrets-render config | `~/.config/` entries for your secrets tooling | Recovery configuration only. Hardware-sealed credentials may need re-enrollment on new hardware |

### Important (Painful to Lose)

| Data | Location | Why Important |
|------|----------|--------------|
| Daily memory logs | `~/.openclaw/workspace/memory/` | Session history, can be reconstructed but time-consuming |
| Rules | `~/.openclaw/workspace/rules/` | Behavioral rules, corrections, learned patterns |
| Hooks | `~/.openclaw/hooks/` | Custom hook scripts |
| Brigade runbooks and receipts | `~/.openclaw/workspace/.brigade/` | The schedule definitions below and their run history |
| Systemd user units | `~/.config/systemd/user/` | Every timer and browser lane on the host |
| OAuth state | `~/.codex/`, `~/.claude/` | Losing these means re-authenticating every subscription after a restore |

### Nice to Have (Replaceable)

| Data | Location | Notes |
|------|----------|-------|
| Project repos | `~/repos/` | Stored on GitHub, can be re-cloned |
| Node modules | `node_modules/` | Reinstallable via npm |
| Build artifacts | `dist/`, `.next/`, etc. | Regenerated from source |
| Ollama models | `~/.ollama/` | Re-downloadable |
| Browser caches | `~/.openclaw/browser/**/Cache` | Volatile and regenerated. Cookies and sessions are still captured |

## Backup Strategy

### Why Restic

The `tar + gpg` pattern in the original version of this guide works but has two weaknesses: every backup is a full archive (no deduplication), and restoration requires the entire archive to be intact. I moved to [restic](https://restic.net/), which deduplicates across snapshots, encrypts at rest by default, and lets you mount old snapshots as filesystems for partial restores.

### The Tiers

The same backup paths are written into **independent** encrypted restic repositories, plus two other tiers that cover different data:

| Tier | Where | Cadence | What it holds |
|------|-------|---------|---------------|
| NAS repo | SMB share, `/mnt/nas/backups/openclaw-restic` | twice daily | OpenClaw config, workspace, state, scripts, repos. Tag `nightly-nas` |
| Cloud repo | Google Drive via rclone, `rclone:gdrive:Backup/openclaw-restic` | weekly | Same paths, independent repo and retention. Tag `nightly` |
| Photo archive | Google Drive via rclone, `rclone:gdrive:Backup/media-restic` | daily | Family photos, phone backups, and Immich originals plus database dumps. Add-only, never pruned |
| Hypervisor guests | Proxmox Backup Server on local fast storage | daily | Snapshot-mode backups of the production containers and VMs |
| KeePass vault | NAS plus Drive, single file | every 2 minutes | Newest-wins file sync, not snapshot history |

The NAS and cloud repos are two separate repos, not one repo copied to the other. restic runs a fresh, deduplicated backup into each. A corrupt NAS repo can't propagate to Drive, and the two have independent retention.

**Why the cloud copy is weekly, not twice-daily:** I originally ran both destinations on the same twice-daily schedule. Daily restic-over-rclone writes exhausted the Google Drive API quota, and because the script used `set -e`, the failing Drive phase aborted the whole run and took the NAS backup down with it. I split the cadence and dropped `set -e` so a Drive hiccup can never block the local backup. The root cause turned out to be rclone's shared client ID, which has a small per-minute query quota. A private OAuth client ID is the real fix. Pacing is the workaround. See [Drive Quota and Over-Syncing](#drive-quota-and-over-syncing).

### How the Schedules Run

Since mid-2026 the restic jobs are not bare crontab lines. Each one is a [Brigade](../tools/brigade.md) runbook: a small JSON file with an `allowed_commands` list and one step that runs the script with a timeout. Running it through `brigade runbook run --approved` writes a reviewed receipt per run under `.brigade/runbooks/runs/`, so a scheduled backup that fails leaves evidence instead of a line in a log nobody reads.

The shape of a runbook (names and paths are examples):

```json
{
  "id": "nas-restic-backup",
  "description": "Twice-daily NAS restic backup.",
  "approved": true,
  "allowed_commands": ["bash"],
  "steps": [
    {
      "id": "backup-nas",
      "run": "bash ~/.openclaw/workspace/scripts/backup-restic.sh nas",
      "timeout_seconds": 7200
    }
  ]
}
```

Who triggers which runbook:

| Runbook | Trigger | Step timeout |
|---------|---------|--------------|
| NAS backup | OpenClaw cron job (`kind: command`), twice daily, announces the result to chat | 2 hours |
| Cloud backup | OpenClaw cron job (`kind: command`), weekly on Sunday | 8 hours |
| Photo archive backup | systemd user timer, daily around 07:30 with a 10 minute random delay | 23 hours |
| Freshness check | systemd user timer, daily 09:00 | 15 minutes |
| Integrity verify | systemd user timer, Mondays 16:00 | 7 hours |
| Restore rehearsal | systemd user timer, first Sunday of the month 06:00 | 2 hours |
| Small app-level backups (search index DB, agent session files, a pull of a second host's OpenClaw state) | crontab lines of the form `brigade runbook run --target <workspace> --approved <runbook>.json` | per runbook |

The cloud runbook points at a thin retry wrapper instead of the backup script directly. It reruns the backup only when the shared lock helper reports that another maintenance job held the lock (exit 75), up to three attempts with a ten minute backoff. Any other exit code is returned on the first occurrence.

Two reasons the schedule is split across cron, systemd, and OpenClaw cron: the OpenClaw cron jobs give a chat announcement of the result for free, and the systemd timers give `Persistent=true` catch-up after a reboot. See [cron patterns](../automation/cron-patterns.md) for choosing a scheduler.

### The Backup Script

One script, `backup-restic.sh [nas|gdrive|both|media] [--no-prune]`, owns every restic write. It has no `set -e`: each repo runs in a function that returns non-zero on failure, and the script reports a per-repo exit summary. An abridged skeleton:

```bash
#!/usr/bin/env bash
# backup-restic.sh [nas|gdrive|both|media] [--no-prune]
set -uo pipefail                       # NOT set -e: a Drive failure must not abort the NAS phase

# 1. One shared lock for every restic job on the host (details below)
source "$(dirname "$0")/restic-shared-lock.sh"
restic_shared_lock_acquire || exit $?

# 2. Scratch space off the root volume
export TMPDIR="$HOME/.cache/restic-tmp"
export RCLONE_TEMP_DIR="$TMPDIR"
mkdir -p "$TMPDIR"

# 3. Conservative rclone backend for Google Drive
export RCLONE_TRANSFERS=1 RCLONE_CHECKERS=2 RCLONE_TPSLIMIT=2
export RCLONE_DRIVE_PACER_MIN_SLEEP=500ms RCLONE_RETRIES=8 RCLONE_LOW_LEVEL_RETRIES=20

run_backup_phase() {                   # label, repo, tag
  export RESTIC_REPOSITORY="$2"
  restic unlock                        # removes only locks whose owner process is gone
  restic snapshots --json &>/dev/null || restic init || return 1
  restic backup --tag "$3" "${EXCLUDES[@]}" "${PATHS[@]}" || return 1
  if [ "$PRUNE" -eq 1 ]; then
    restic forget --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune \
      || echo "WARN: prune failed (backup ok)"
  fi
}
```

The details that earned their place:

- **Targets.** `nas` and `gdrive` run the config backup into their repo. `both` runs both. `media` is explicit-only and never part of `both`, so the config backup is unaffected by the photo archive.
- **`--no-prune`.** Skips `restic forget --prune` for add-only verification runs, for example after changing the source set. The Brigade summary records the prune result as `skipped`.
- **`forget --group-by host,tags`.** restic's default groups by host and paths, so every change to the backup path list starts a new group and old snapshots never expire. Grouping by tags fixed a repo that had quietly kept snapshots for months.
- **Stale lock clearing.** Plain `restic unlock` only deletes locks whose owning process is gone. One stale exclusive lock once blocked seven consecutive NAS runs because every run failed the access check and fell through to a doomed `init`. Do not use `unlock --remove-all` in a scheduled job: it can break a live run.
- **TMPDIR off root.** restic and rclone assemble temp packs in `$TMPDIR`, which defaults to `/tmp` on the root volume. A large cloud pass exhausted a small root volume and died with `no space left on device` even though the remote had terabytes free. Pointing `TMPDIR` and `RCLONE_TEMP_DIR` at a directory on the large data volume fixed it.
- **Timeouts sized to the job.** The cloud runbook gets 8 hours and the photo archive 23, because a first full pass over Drive at 2 transactions per second is slow. Size a runbook timeout to the worst full pass, not the incremental one.
- **Volatile paths excluded.** Browser caches, `node_modules`, build output, and disposable lab sandboxes (their container-owned files are unreadable and made restic exit 3, which the NAS job counted as failure until its cron job auto-disabled) are excluded.
- **Brigade summaries.** After each destination the script writes a small summary file (latest snapshot time, check result, prune result, restore rehearsal result) under `.brigade/backups/`. `brigade work backup doctor` reads these and flags stale fields, and the verify and rehearsal jobs below update the same files.

### Consistent State Staging

OpenClaw keeps live state in SQLite databases. Copying a live SQLite file with a file-level backup can capture a torn page. The script therefore stages a recovery set before restic runs: a consistent snapshot of `~/.openclaw` taken with a snapshot helper (SQLite online backup for each database), the current systemd user units, and a small manifest recording which OpenClaw commit the gateway runs. The live database files are excluded from the restic inputs, the staged copies are included, and the staging directory is deleted after restic finishes. If staging fails, the backup aborts before restic starts rather than writing a snapshot that cannot restore the databases.

### The Shared Lock

Every local restic entrypoint (backup, freshness check, verify, rehearsal) sources one helper and takes the same `flock` on a file under `/run/user/<uid>/`. It waits up to ten minutes (`RESTIC_LOCK_WAIT_SECONDS`), and if the lock is still held it exits 75 without starting any restic command. This is what stops a Monday verify run from colliding with a long cloud backup. The helper intentionally does not clear repository locks. Recovering from a stale repository lock stays an operator action.

### Drive Quota and Over-Syncing

The single most important lesson from running this in production: **Google Drive throttles you when too many rclone jobs hit it at once, and over-frequent syncing makes it worse, not better.** Three defenses are in place.

**1. Throttle the rclone backend.** The `RCLONE_*` env vars force one transfer at a time, a transactions-per-second cap, a pacer, and deep retry counts. Restic-over-rclone with default parallelism bursts dozens of API calls and trips Drive's per-user rate limit, after which every job spins in a quota-retry loop and nothing finishes.

**2. Don't run two rclone jobs against Drive simultaneously.** An Obsidian vault bisync (rclone to Drive) runs every two minutes. If a restic Drive phase overlaps it, both jobs fight for the same quota. The backup script pauses the Obsidian sync timer for the duration of any Drive phase (cloud and photo archive) and resumes it on exit:

```bash
trap 'systemctl --user start obsidian-sync.timer 2>/dev/null || true' EXIT
systemctl --user stop obsidian-sync.timer obsidian-sync.service 2>/dev/null || true
# ... run the Drive phase ...
```

**3. Serialize with the shared lock** so two restic jobs never overlap in the first place.

The general rule: serialize anything that talks to Drive. More frequent syncing does not give you a fresher off-site copy, it gives you a rate-limited one. A shared rclone client ID makes this worse because the quota is shared with every other user of that client. Create your own OAuth client ID for rclone if you can.

### The Encrypted Photo Archive

Family photos and phone backups are the data I cannot regenerate, so they get their own repo with different rules:

- **Add-only.** The `media` phase never runs `forget` or `prune`. A photo that was backed up stays backed up even if it is deleted from the source later.
- **Archival retention, own repo.** It uses a separate Drive repo, but the same passphrase file as the other repos.
- **Sources.** The photo library and phone backups on the NAS, plus the originals uploaded through Immich and its database dumps. Generated thumbnails and encoded video are excluded because Immich can regenerate them.
- **Exit 3 is a warning here.** Source files on a network share can change mid-read (a sync client, a database dump), which makes restic exit 3 with "some source files could not be read". For an archival seed that is a partial success, and a re-run captures the rest. Any other non-zero exit is an error.
- **`--parent`.** When a source path is added, restic's default parent matching re-reads every existing file. The script passes the newest photo snapshot as `--parent` so only new or changed files are read.
- **It is checked too.** The weekly verify samples this repo, and the monthly rehearsal restores a known photo from it and compares hashes.

### Proxmox Backup Server

The hypervisor guests are covered by Proxmox Backup Server, not restic. A scheduled vzdump job runs daily at 02:00 in snapshot mode with zstd compression and covers the production containers and VMs. The PBS datastore lives on local fast storage (its own logical volume), at roughly 70% full when I last looked.

Two design points:

- **PBS stays off the NAS.** A consumer NAS cannot do the atomic write-then-rename that PBS chunk commits need. See [NAS and Network Storage Mounts](nas-and-backups.md#pbs-on-a-nas-resilience-and-what-not-to-do).
- **The NAS mirror runs weekly.** A timer on the hypervisor (weekly, Sunday 08:00, last run 2026-10-11 when I checked) rsyncs the datastore to a share on the NAS over CIFS, so there is one independent off-host copy. The design is in [Homelab Topology](homelab-topology.md) and [NAS and Network Storage Mounts](nas-and-backups.md#pbs-on-a-nas-resilience-and-what-not-to-do).
- **The cloud mirror is off.** A second weekly job used to sync the datastore to Google Drive. It hit the same shared-rclone-client quota described above and was disabled in August 2026 until it can move to a private OAuth client. Until then there are two copies, the local datastore and the NAS mirror, not three. Check that your own mirrors are on and recent before you rely on them (`systemctl list-timers` on the hypervisor shows the last run).

### Set Up the Passphrase

```bash
openssl rand -base64 32 > ~/.openclaw/.restic-password
chmod 600 ~/.openclaw/.restic-password
```

Store this passphrase somewhere outside your machine (password manager, printed copy in a safe). If you lose it, every restic repository becomes unreadable. Because the passphrase file lives under `~/.openclaw`, it is also inside the backup, which only helps if you can already read a repo, so the off-machine copy is not optional.

### Initialize the Repositories (One Time)

The backup script runs `restic init` itself when a repo is missing, but doing it by hand once lets you see errors:

```bash
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password
restic -r /mnt/nas/backups/openclaw-restic init
restic -r rclone:gdrive:Backup/openclaw-restic init
restic -r rclone:gdrive:Backup/media-restic init
```

### Schedule the Backups

Write one runbook per job, then trigger it from the scheduler that fits. A systemd user timer for a daily job looks like this:

```ini
# media-restic-backup.timer
[Timer]
OnCalendar=*-*-* 07:30:00
RandomizedDelaySec=10m
Persistent=true

# media-restic-backup.service (Type=oneshot)
[Service]
ExecStart=%h/.local/bin/brigade runbook run --target %h/.openclaw/workspace --approved %h/.openclaw/workspace/.brigade/runbooks/media-restic-backup.json
TimeoutStartSec=24h
Nice=10
```

Set `TimeoutStartSec` above the runbook step timeout, otherwise systemd kills a backup that the runbook still considers healthy. For the OpenClaw cron route, create a `command`-kind job that runs the same `brigade runbook run` line and announces the result. See [OpenClaw cron](../automation/openclaw-cron-deep-dive.md).

### Monitoring the Backups

Three independent checks sit on top of the backup jobs, each deliberately simple:

| Check | Cadence | What it proves |
|-------|---------|----------------|
| Freshness check | daily 09:00 | The newest snapshot in the NAS and cloud repos is younger than a per-repo threshold (24 hours for NAS, 8 days for the weekly cloud repo). Posts the result to an n8n webhook that alerts on staleness. The webhook secret comes from a 0600 file and reaches curl through a private config file, never argv or the environment |
| Integrity verify | Mondays 16:00 | `restic check --read-data-subset=5%` on the NAS, cloud, and photo repos, each with its own timeout. Writes the result to the Brigade summaries and a small status JSON for a dashboard. A run that is interrupted marks the check `failed`, so an old `ok` cannot linger |
| Restore rehearsal | first Sunday of the month 06:00 | Actually restores something. See below |

A fourth, softer check: a daily chat brief reads the Brigade summaries and the n8n execution list (read-only) and summarizes backup health. That job is forbidden from running restic, rclone, or any backup script itself.

The freshness check does not cover the photo archive. The integrity verify and the rehearsal do, and the daily photo timer leaves a Brigade receipt.

### Restore Rehearsal

A backup you have never restored from is a backup that doesn't exist. The monthly rehearsal script (`openclaw-restic-restore-rehearsal.sh [nas|gdrive|media|all]`) automates the smallest meaningful restore:

1. For the NAS and cloud repos, restore the staged recovery state from the newest snapshot and check that the snapshot manifest, the staged state database, the source-identity manifest, and the gateway unit file are present. Then run `PRAGMA integrity_check` on every SQLite database the manifest lists. It deliberately does not start a gateway: the scope is file and database integrity.
2. Restore one stable sample file from the newest snapshot and compare it byte for byte with `restic dump` of the same path.
3. For the photo archive, do the same sample restore and comparison with a known photo.
4. Record the result and timestamp into the Brigade summaries, so `brigade work backup doctor` can flag a rehearsal that has not run recently.

The script takes the shared lock, so it waits behind a running backup. Treat a failed rehearsal as a real incident. It is the only job that proves the snapshots restore into something usable.

## Backup Destinations

### Local NAS (Primary)

Fast restores and large backups. I use an SMB NAS mounted at `/mnt/nas` via fstab automount with guest access. The NAS is the household storage tier. The OpenClaw backup pool sits alongside unrelated data, so treat it as shared infrastructure.

```bash
# fstab entry (automount on demand)
//<NAS_HOST>/share /mnt/nas cifs guest,uid=1000,gid=1000,nofail,x-systemd.automount,x-systemd.idle-timeout=300 0 0
```

**Write policy is a convention, not a mount flag.** The mount is read-write, because the backup jobs must write to the backup directory. Nothing in the kernel stops an agent or a typo from deleting the photo archive on the same share. The guards are procedural:

- The only scheduled writers are the backup scripts and the Immich service.
- Agent policy treats any `mv`, `rm`, or rename under `/mnt/nas` as confirmation-required.
- The photo archive is also copied off-site by the add-only repo above, so a deletion on the NAS is recoverable.

If you want a real guard, split the share: a read-only mount for general use and a separate authenticated writable mount that only the backup service uses. I have not done that split yet. See [NAS and Network Storage Mounts](nas-and-backups.md) for the mount options.

### Cloud Storage (Off-Site)

Google Drive via rclone. Restic handles encryption, the rclone transport is just the storage tier.

```bash
rclone config  # one-time: authenticate against Google Drive (use your own client ID)
```

### The 3-2-1 Rule

- **3 copies** of your data
- **2 different storage types** (local disk + NAS, or local + cloud)
- **1 off-site** copy (cloud or physically separate location)

For a homelab OpenClaw setup, "local disk + NAS + cloud" covers all three. The photo archive meets it through the NAS original, the add-only Drive repo, and the phone or Immich copy it was ingested from.

## KeePass Canonical Sync

The restic repos are snapshot history. A password database is different: it changes constantly, you edit it from more than one place, and you need a single canonical copy that's always current, not a snapshot from this morning. I keep one KeePass `.kdbx` and sync it between the NAS and Google Drive on a short timer with **newer-mtime-wins** resolution.

This is *not* part of the restic backup. The restic script comments the vault out of its path list on purpose so the vault is never read or copied through that path. It is a separate, lightweight, bidirectional single-file sync whose job is to keep the two copies identical so neither location is ever stale.

Two user timers are live:

| Timer | Cadence | Job |
|-------|---------|-----|
| `keepass-sync.timer` | every 2 minutes (`OnBootSec=45`, `OnUnitActiveSec=2min`) | Newer-mtime-wins sync of the vault between NAS and Drive |
| `op-keepass-mirror.timer` | daily 05:15 with a 5 minute random delay, `Persistent=true` | Mirrors items from the password manager's read-only service account into the vault so the KeePass file is a complete offline copy |

The mirror writes entries under a dedicated group with a title prefix so they cannot collide with runtime entry titles. It matches by the source item id, updates an entry when the source changes, and never deletes one, so the vault keeps an item after it leaves the password manager. It takes a timestamped backup of the vault before every save (keeping the newest 20) and holds the same lock as the sync script while writing, so a mirror run cannot race a sync tick.

```bash
#!/bin/bash
# keepass-sync.sh - bidirectional, newer-mtime-wins (5s drift tolerance)
set -uo pipefail
NAS_FILE="/mnt/nas/share/vault.kdbx"
GDRIVE_REMOTE="gdrive:vault/vault.kdbx"
LOG="$HOME/.openclaw/workspace/logs/keepass-sync-$(date +%Y%m%d).log"
TOLERANCE=5

# flock so overlapping timer ticks exit cleanly instead of racing the file
exec 200>/tmp/keepass-sync.lock
flock -n 200 || exit 0

[ -f "$NAS_FILE" ] || { echo "$(date -Is) ERROR: NAS file missing" >>"$LOG"; exit 1; }
NAS_MTIME=$(stat -c %Y "$NAS_FILE")

GDRIVE_JSON=$(rclone lsjson "$GDRIVE_REMOTE" 2>/dev/null || echo "[]")
GDRIVE_MTIME_ISO=$(echo "$GDRIVE_JSON" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['ModTime'] if d else '')")

if [ -z "$GDRIVE_MTIME_ISO" ]; then              # Drive copy missing -> seed from NAS
  rclone copyto "$NAS_FILE" "$GDRIVE_REMOTE"; exit $?
fi

DIFF=$(( NAS_MTIME - $(date -d "$GDRIVE_MTIME_ISO" +%s) ))
if   [ "$DIFF" -gt  "$TOLERANCE" ]; then rclone copyto "$NAS_FILE" "$GDRIVE_REMOTE"   # NAS newer -> push
elif [ "$DIFF" -lt "-$TOLERANCE" ]; then rclone copyto "$GDRIVE_REMOTE" "$NAS_FILE"   # Drive newer -> pull
fi                                               # within tolerance -> no transfer
```

Design notes that matter:

- **Newer-mtime-wins, not a merge.** KeePass databases don't merge at the file level. Last writer wins. The 5-second tolerance absorbs clock drift between the local clock and Drive's `ModTime` so a sync doesn't ping-pong a file that's effectively identical.
- **`flock` prevents overlap.** A two-minute timer plus a slow Drive round-trip can stack. The lock makes a late tick exit immediately rather than fight the previous run.
- **It only transfers on real divergence.** Within tolerance it does zero Drive writes, which keeps the sync from adding to the quota pressure described in [Drive Quota and Over-Syncing](#drive-quota-and-over-syncing). A two-minute cadence is safe precisely because an idle database costs nothing.
- **Conflict caveat.** Edit the database on two machines inside the same two-minute window and the later mtime overwrites the earlier one, so one set of edits is lost. With a single editor this never happens. With multiple editors, close the DB on one before editing on another, or move to a sync tool with real conflict copies.

## Restore Procedure

### Full Restore Steps

```bash
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password   # restored from your off-machine copy

# 1. List available snapshots (from either destination)
restic -r /mnt/nas/backups/openclaw-restic snapshots
# Pick a snapshot ID to restore from

# 2. Restore to a temp location for inspection
restic -r /mnt/nas/backups/openclaw-restic restore <SNAPSHOT_ID> --target /tmp/restore-test

# 3. Verify contents
ls -la /tmp/restore-test/home/*/.openclaw/
jq . /tmp/restore-test/home/*/.openclaw/openclaw.json > /dev/null && echo "OK config parses"

# 4. Check critical files exist
for f in SOUL.md AGENTS.md MEMORY.md USER.md TOOLS.md; do
  [ -f /tmp/restore-test/home/*/.openclaw/workspace/$f ] && echo "OK $f" || echo "MISSING $f"
done

# 5. Count knowledge cards
CARDS=$(ls /tmp/restore-test/home/*/.openclaw/workspace/memory/cards/*.md 2>/dev/null | wc -l)
echo "Knowledge cards: $CARDS"

# 6. Clean up test
rm -rf /tmp/restore-test
```

For the databases, restore from the staged recovery copy rather than the live file path: the staged snapshot lives under the staging directory path inside the snapshot, and its manifest lists every database. Run `sqlite3 <db> 'PRAGMA integrity_check;'` on each before pointing a gateway at it.

### Mount a Snapshot Without Restoring

One restic advantage: browse old snapshots like a filesystem without pulling anything.

```bash
mkdir -p /tmp/snap-mount
restic -r /mnt/nas/backups/openclaw-restic mount /tmp/snap-mount &
ls /tmp/snap-mount/snapshots/
# Navigate and read any historical file, then:
fusermount -u /tmp/snap-mount
```

### Restore to a New Machine

OpenClaw runs from a release worktree now, not a global npm install, so a rebuild is: restore, rebuild the recorded commit, point the gateway at it. See [Upgrade Hygiene](upgrade-hygiene.md) for the worktree layout.

```bash
# 1. Install the OS, Node (24.x), git, pnpm, restic, rclone
sudo apt install restic -y

# 2. Restore the passphrase from your off-machine copy, then restore the latest snapshot
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password
restic -r /path/to/repo restore latest --target /

# 3. Rebuild OpenClaw from the commit recorded in the restored source manifest
#    (the staged manifest lists the origin URL, commit, and rebuild commands)

# 4. Restore the staged systemd user units, reload systemd, start the gateway
systemctl --user daemon-reload
systemctl --user start openclaw-gateway

# 5. Verify
openclaw --version
jq . ~/.openclaw/openclaw.json > /dev/null && echo "OK config parses"

# 6. Pull local models again and re-authenticate hardware-sealed credentials
ollama pull qwen3-embedding:8b
```

Hardware-sealed credentials (for example a TPM-bound secret) do not transfer to new hardware. Plan to re-enroll them from the password manager.

### Recovery Time Objective

With a good backup and documented procedure, you should be able to rebuild from scratch on new hardware in a couple of hours, most of it build and download time:

| Step | Time |
|------|------|
| Install OS + Node.js | 15 min |
| Restore backup | 10 min |
| Rebuild OpenClaw from the recorded commit | 10 min |
| Install Ollama + models | 10 min |
| Re-enroll sealed credentials, verify channels | 20 min |
| Test agent responses | 10 min |
| **Total** | **~75 min** |

I have rehearsed the restore of state and a sample file monthly, but not a full bare-metal rebuild on spare hardware, so treat the table as an estimate.

## Database Backup Warning

If your agent uses SQLite databases (code search index, analytics, OpenClaw state), be aware:

- **Ubuntu's SQLite has SECURE_DELETE compiled in.** Deleted data is zeroed on disk. Once gone, it's gone. No "undelete" recovery.
- **Back up databases separately** if they contain data that's expensive to reconstruct (our code search index cost $30 in API calls to rebuild after a sub-agent deleted it). The search index has its own twice-daily runbook.
- **Use the online backup API** for consistent SQLite backups, never a plain file copy of a live database:

```bash
sqlite3 /path/to/database.db ".backup /path/to/backups/database-$(date +%Y-%m-%d).db"
```

## Verification

```bash
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password

echo "=== Latest Snapshot (NAS, expect < 16h old) ==="
restic -r /mnt/nas/backups/openclaw-restic snapshots --latest 1 2>/dev/null || echo "NAS repo unavailable"

echo ""
echo "=== Latest Snapshot (Google Drive, expect < 8 days old) ==="
restic -r rclone:gdrive:Backup/openclaw-restic snapshots --latest 1 2>/dev/null || echo "rclone repo unavailable"

echo ""
echo "=== Latest Snapshot (photo archive, expect < 2 days old) ==="
restic -r rclone:gdrive:Backup/media-restic snapshots --latest 1 2>/dev/null || echo "photo repo unavailable"

echo ""
echo "=== Passphrase File ==="
[ -f ~/.openclaw/.restic-password ] && echo "OK passphrase file exists" || echo "passphrase file missing"

echo ""
echo "=== Backup, verify, and rehearsal timers ==="
systemctl --user list-timers --all --no-pager | grep -E 'restic|keepass'

echo ""
echo "=== Brigade backup summaries ==="
jq -c '{destination_label, latest_snapshot_at, latest_check_result, latest_restore_rehearsal_result}' \
  ~/.openclaw/workspace/.brigade/backups/*-summary.json

echo ""
echo "=== OpenClaw cron backup jobs ==="
openclaw cron list --json | jq -r '.jobs[] | select(.name | test("backup"; "i")) | [.name, .enabled, .state.lastStatus] | @tsv'
```

Expected output: the three snapshot lines show timestamps inside the stated windows, the timer list shows `keepass-sync`, `op-keepass-mirror`, `restic-freshness-check`, `openclaw-restic-verify`, `openclaw-restic-restore-rehearsal`, and the photo archive timer with future `NEXT` times, each Brigade summary shows `ok` for check and rehearsal, and each backup cron job reports a last status of `ok`. A `gdrive` snapshot older than eight days or a job in `error` is the signal to read that run's receipt under `.brigade/runbooks/runs/`.

## Gotchas

1. **Test your restores.** Seriously. Encrypt a backup, delete it from the original location (in a safe environment), and restore it. If you can't restore, you don't have a backup. The monthly rehearsal job exists to make this routine.

2. **Store the passphrase separately.** If your backup passphrase is only on the same disk as your backups, a disk failure loses both. Put it in a password manager or print it.

3. **API keys in backups.** Your encrypted backup contains API keys, tokens, and SSH keys. Treat the repository itself as sensitive. Don't upload unencrypted backups to public cloud storage.

4. **Ollama models aren't in the backup.** They're large (GBs) and re-downloadable. Just re-pull after restore.

5. **Schedules live in more than one place.** Cron jobs live in OpenClaw's state, timers live in `~/.config/systemd/user/`, and runbooks live in `.brigade/`. The backup includes all three, but on a rebuild you must restore the OpenClaw cron store and enable the timers again. `openclaw cron list --json > cron-export.json` is a cheap periodic export.

6. **`forget --prune` is destructive by design.** The retention flags delete snapshots that don't match. If you typo the keep counts, you lose snapshots. Dry-run the first few prune cycles with `--dry-run`, and use `--no-prune` when changing the source set. Never prune the add-only photo archive.

7. **Back up OAuth state files, not just OpenClaw config.** `~/.codex/auth.json` and `~/.claude/` aren't in `~/.openclaw/`, but losing them means re-authenticating every subscription after a restore.

8. **The NAS is writable, so the policy is only as good as your habits.** I do not enforce read-only with a mount option, because the backup jobs write there. Keep the add-only off-site photo repo as the real protection, and confirm backup evidence before deleting anything from the NAS.

9. **Never use `set -e` across two backend phases.** With `set -e`, a failed Google Drive phase aborts the script before the NAS backup runs. Use `set -uo pipefail`, run each repo in a function that returns non-zero on failure, and report a per-repo exit summary.

10. **More syncing is not fresher syncing.** Restic-over-rclone with default parallelism, or two rclone jobs hitting Drive at once, trips Google Drive's rate limit and everything stalls in quota-retry loops. Throttle the rclone backend, serialize anything that touches Drive, keep the cloud cadence low, and use your own OAuth client ID. The frequent, always-current copy is the local NAS. Drive is the off-site insurance copy.

11. **Scratch space is part of the design.** restic's temp packs default to `/tmp`. If that is a small root volume, a big pass fails with `no space left on device` while the remote has plenty of room. Set `TMPDIR` and `RCLONE_TEMP_DIR` to the big volume.

12. **A job that auto-disables can hide a failure.** OpenClaw cron disables a job after repeated errors. A NAS backup once went dark this way because unreadable lab files made restic exit 3. Keep an independent staleness alarm that does not depend on the backup job's own scheduler.

13. **A stale-lock `init` loop looks like an outage.** If a killed restic run leaves a lock and your script falls through to `restic init` on any access failure, every later run fails the same way. Clear only dead-owner locks with plain `restic unlock` at the start of each phase.
