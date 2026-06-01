# Backup & Recovery

How to protect your OpenClaw workspace, configuration, and memory from data loss. Encrypted backups, restore testing, and disaster recovery planning.

**Tested on:** OpenClaw 2026.5.x on Ubuntu 24.04. Two encrypted restic repositories - a local SMB NAS twice daily and Google Drive (via rclone) weekly - plus a separate two-minute canonical sync for a KeePass database.
**Last updated:** 2026-05-31

---

## What Needs Backup

Your OpenClaw instance has three categories of data, each with different backup priorities:

### Critical (Lose This, Start Over)

| Data | Location | Why Critical |
|------|----------|-------------|
| OpenClaw config | `~/.openclaw/openclaw.json` | Agent definitions, model assignments, channel tokens, all settings |
| Workspace files | `~/.openclaw/workspace/` | SOUL.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, all personality and operational files |
| Knowledge cards | `~/.openclaw/workspace/memory/cards/` | Curated long-term memory, hard to reconstruct |
| Skills | `~/.openclaw/workspace/skills/` | Custom skills you've written or configured |
| SSH keys | `~/.ssh/` | Access to remote machines |
| Environment variables | `~/.bashrc`, `~/.env` | API keys, tokens, paths |

### Important (Painful to Lose)

| Data | Location | Why Important |
|------|----------|--------------|
| Daily memory logs | `~/.openclaw/workspace/memory/` | Session history, can be reconstructed but time-consuming |
| Rules | `~/.openclaw/workspace/rules/` | Behavioral rules, corrections, learned patterns |
| Hooks | `~/.openclaw/hooks/` | Custom hook scripts |
| PM2 config | `ecosystem.config.cjs` | Service management, port assignments |
| Cron jobs | Stored in OpenClaw | Scheduled tasks (can be recreated but tedious) |

### Nice to Have (Replaceable)

| Data | Location | Notes |
|------|----------|-------|
| Project repos | `~/repos/` | Stored on GitHub, can be re-cloned |
| Node modules | `node_modules/` | Reinstallable via npm |
| Build artifacts | `dist/`, `.next/`, etc. | Regenerated from source |
| Ollama models | `~/.ollama/` | Re-downloadable |

## Backup Strategy

### Why Restic

The `tar + gpg` pattern in the previous version of this guide works but has two weaknesses: every backup is a full archive (no deduplication), and restoration requires the entire archive to be intact. We've since migrated to [restic](https://restic.net/), which deduplicates across snapshots, encrypts at rest by default, and lets you mount old snapshots as filesystems for partial restores.

### Two Repos, Two Cadences

The same backup paths are written into **two independent encrypted restic repositories**:

| Repo | Location | Cadence | restic tag |
|------|----------|---------|-----------|
| NAS (primary) | `/mnt/nas/backups/openclaw-restic` | twice daily, 3am + 3pm | `nightly-nas` |
| Google Drive (off-site) | `rclone:gdrive:Backup/openclaw-restic` | weekly, Sunday 4am | `nightly` |

These are two separate repos, not one repo copied to the other. restic runs a fresh, deduplicated backup into each. A corrupt NAS repo can't propagate to Drive, and the two have independent retention.

**Why the cloud copy is weekly, not twice-daily:** we originally ran both destinations on the same twice-daily schedule. Daily restic-over-rclone writes exhausted the Google Drive API quota, and because the script used `set -e`, the failing Drive phase aborted the whole run and took the NAS backup down with it. We split the cadence (NAS twice daily, Drive weekly) and dropped `set -e` so a Drive hiccup can never block the local backup. See [Drive Quota and Over-Syncing](#drive-quota-and-over-syncing) below.

```bash
#!/usr/bin/env bash
# backup-restic.sh [nas|gdrive|both]
# NAS twice daily (3am+3pm), GDrive weekly (Sun 4am).
set -uo pipefail                       # NOT set -e: a Drive failure must not abort the NAS phase
export PATH="${HOME}/bin:${PATH}"

TARGET="${1:-both}"
RESTIC_PASSWORD_FILE="${HOME}/.openclaw/.restic-password"
RESTIC_REPO_NAS="/mnt/nas/backups/openclaw-restic"
RESTIC_REPO_GDRIVE="rclone:gdrive:Backup/openclaw-restic"
export RESTIC_PASSWORD_FILE

# Conservative rclone backend: Google Drive rejects bursty writes when other
# rclone jobs are active. One transfer at a time, throttled, generous retries.
export RCLONE_TRANSFERS="${RCLONE_TRANSFERS:-1}"
export RCLONE_CHECKERS="${RCLONE_CHECKERS:-2}"
export RCLONE_TPSLIMIT="${RCLONE_TPSLIMIT:-4}"
export RCLONE_TPSLIMIT_BURST="${RCLONE_TPSLIMIT_BURST:-4}"
export RCLONE_DRIVE_PACER_MIN_SLEEP="${RCLONE_DRIVE_PACER_MIN_SLEEP:-500ms}"
export RCLONE_RETRIES="${RCLONE_RETRIES:-8}"
export RCLONE_LOW_LEVEL_RETRIES="${RCLONE_LOW_LEVEL_RETRIES:-20}"

PATHS=(
  "$HOME/.openclaw"                    # config, workspace, hooks, vendor (ACPX)
  "$HOME/repos" "$HOME/bin" "$HOME/notes" "$HOME/Obsidian"
  "$HOME/.bashrc" "$HOME/.profile" "$HOME/.gitconfig" "$HOME/.npmrc"
  "$HOME/.ssh"                         # remote access keys
  "$HOME/.claude" "$HOME/.codex"       # Claude Code + Codex OAuth state
)
EXCLUDES=( --exclude='node_modules' --exclude='.git/objects' --exclude='.venv'
  --exclude='dist' --exclude='build' --exclude='.next' --exclude='*.pyc'
  --exclude='*.jsonl' --exclude='.ollama' --exclude='.pm2/logs' )

backup_repo() {
  local label="$1" repo="$2" tag="$3"
  export RESTIC_REPOSITORY="$repo"
  restic snapshots &>/dev/null || restic init || { echo "WARN: $label repo unreachable, skipping"; return 1; }
  restic unlock --remove-all 2>/dev/null || true          # clear stale locks from a killed run
  restic backup --tag "$tag" "${EXCLUDES[@]}" "${PATHS[@]}" || { echo "ERROR: $label backup failed"; return 1; }
  restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune || echo "WARN: $label prune failed (backup ok)"
}

[[ "$TARGET" == nas    || "$TARGET" == both ]] && mountpoint -q /mnt/nas && backup_repo nas    "$RESTIC_REPO_NAS"    nightly-nas
[[ "$TARGET" == gdrive || "$TARGET" == both ]] && backup_repo gdrive "$RESTIC_REPO_GDRIVE" nightly
```

### Drive Quota and Over-Syncing

The single most important lesson from running this in production: **Google Drive throttles you when too many rclone jobs hit it at once, and over-frequent syncing makes it worse, not better.** Two defenses are baked in.

**1. Throttle the rclone backend.** The `RCLONE_*` env vars above force one transfer at a time with a pacer and deep retry counts. Restic-over-rclone with default parallelism will burst dozens of API calls and trip Drive's per-user rate limit, after which every job spins in a quota-retry loop and nothing finishes.

**2. Don't run two rclone jobs against Drive simultaneously.** We also run an Obsidian vault bisync (rclone → Drive) every two minutes. If the weekly restic Drive backup overlaps it, both jobs fight for the same quota and both stall. The backup script pauses the Obsidian sync timer for the duration of the Drive phase and resumes it on exit:

```bash
# pause before the gdrive phase, resume on EXIT (trap)
trap 'systemctl --user start obsidian-sync.timer 2>/dev/null || true' EXIT
systemctl --user stop obsidian-sync.timer obsidian-sync.service 2>/dev/null || true
# ... run restic gdrive backup ...
```

The general rule: serialize anything that talks to Drive. More frequent syncing does not give you a fresher off-site copy - it gives you a rate-limited one. Weekly restic to Drive plus the two-minute single-file KeePass sync (below) is deliberately the most Drive traffic we allow.

### Set Up the Passphrase

```bash
openssl rand -base64 32 > ~/.openclaw/.restic-password
chmod 600 ~/.openclaw/.restic-password
```

Store this passphrase somewhere outside your machine (password manager, printed copy in a safe). If you lose it, both restic repositories become unreadable.

### Initialize the Repositories (One Time)

```bash
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password
restic -r /mnt/nas/backups/openclaw-restic init
restic -r rclone:gdrive:Backup/openclaw-restic init
```

### Schedule the Backups

Two separate jobs, separate cadences:

```bash
crontab -e
# NAS: twice daily, 3am and 3pm
0 3,15 * * * /path/to/scripts/backup-restic.sh nas    >> ~/.openclaw/workspace/logs/backup.log 2>&1
# Google Drive: weekly, Sunday 4am
0 4   * * 0 /path/to/scripts/backup-restic.sh gdrive >> ~/.openclaw/workspace/logs/backup.log 2>&1
```

Or use an OpenClaw cron job to verify the backup ran:

```json
{
  "name": "backup-check",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run: restic -r /mnt/nas/backups/openclaw-restic snapshots --latest 1. Confirm the newest NAS snapshot is under 16 hours old and report its timestamp."
  },
  "sessionTarget": "isolated"
}
```

## Backup Destinations

### Local NAS (Primary)

Fast restores and large backups. We use an SMB NAS mounted at `/mnt/nas` via fstab automount with guest access. The NAS is the household storage tier; the OpenClaw backup pool sits alongside unrelated data, so treat it as shared infrastructure.

```bash
# fstab entry (automount on demand)
//<NAS_HOST>/backups /mnt/nas cifs guest,vers=3.0,_netdev,noauto,x-systemd.automount 0 0
```

Rule we enforce locally: **NAS is read-only by default.** The only process allowed to write is `backup-restic.sh`. This prevents an agent from accidentally modifying or deleting the irreplaceable photo archive while exploring the mount.

### Cloud Storage (Off-Site)

Google Drive via rclone. Restic handles encryption; the rclone transport is just the storage tier.

```bash
rclone config  # one-time: authenticate against Google Drive
```

### The 3-2-1 Rule

- **3 copies** of your data
- **2 different storage types** (local disk + NAS, or local + cloud)
- **1 off-site** copy (cloud or physically separate location)

For a homelab OpenClaw setup, "local disk + NAS + cloud" covers all three.

## KeePass Canonical Sync

The restic repos are append-only snapshot history. A password database is different: it changes constantly, you edit it from more than one place, and you need a single canonical copy that's always current - not a snapshot from this morning. We keep one KeePass `.kdbx` and sync it between the NAS and Google Drive on a short timer with **newer-mtime-wins** resolution.

This is *not* part of the restic backup. It's a separate, lightweight, bidirectional single-file sync whose only job is to keep the two copies byte-identical so neither location is ever stale.

```bash
#!/bin/bash
# keepass-sync.sh - bidirectional, newer-mtime-wins (5s drift tolerance)
set -uo pipefail
NAS_FILE="/mnt/nas/share/vault.kdbx"
GDRIVE_REMOTE="gdrive:vault/vault.kdbx"
TOLERANCE=5

# flock so overlapping timer ticks exit cleanly instead of racing the file
exec 200>/tmp/keepass-sync.lock
flock -n 200 || exit 0

[ -f "$NAS_FILE" ] || { echo "ERROR: NAS file missing"; exit 1; }
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

Run it from a systemd user timer every two minutes:

```ini
# keepass-sync.timer
[Timer]
OnBootSec=45
OnUnitActiveSec=2min
AccuracySec=10s

# keepass-sync.service (Type=oneshot, Nice=10, After=network-online.target)
[Service]
Type=oneshot
ExecStart=%h/bin/keepass-sync.sh
Nice=10
```

Design notes that matter:

- **Newer-mtime-wins, not a merge.** KeePass databases don't merge at the file level. Last writer wins. The 5-second tolerance absorbs clock drift between the local clock and Drive's `ModTime` so a sync doesn't ping-pong a file that's effectively identical.
- **`flock` prevents overlap.** A two-minute timer plus a slow Drive round-trip can stack. The lock makes a late tick exit immediately rather than fight the previous run.
- **It only transfers on real divergence.** Within tolerance it does zero Drive writes. That's deliberate - it keeps the KeePass sync from adding to the Drive quota pressure described in [Drive Quota and Over-Syncing](#drive-quota-and-over-syncing). A two-minute cadence is safe precisely because an idle database costs nothing.
- **Conflict caveat.** Edit the database on two machines inside the same two-minute window and the later mtime overwrites the earlier - one set of edits is lost. With a single editor this never happens; if you have multiple editors, close the DB on one before editing on another, or move to a sync tool with real conflict copies.

## Restore Procedure

### Test Your Restores

A backup you've never restored from is a backup that doesn't exist. Test quarterly.

### Full Restore Steps

```bash
export RESTIC_PASSWORD_FILE=/root/.restic-passphrase

# 1. List available snapshots (from either destination)
restic -r /mnt/nas/backups/openclaw-restic snapshots
# Pick a snapshot ID to restore from

# 2. Restore to a temp location for inspection
restic -r /mnt/nas/backups/openclaw-restic restore <SNAPSHOT_ID> --target /tmp/restore-test

# 3. Verify contents
ls -la /tmp/restore-test/home/*/.openclaw/
jq . /tmp/restore-test/home/*/.openclaw/openclaw.json > /dev/null && echo "✓ Config parses"

# 4. Check critical files exist
for f in SOUL.md AGENTS.md MEMORY.md USER.md TOOLS.md; do
  [ -f /tmp/restore-test/home/*/.openclaw/workspace/$f ] && echo "✓ $f" || echo "✗ $f MISSING"
done

# 5. Count knowledge cards
CARDS=$(ls /tmp/restore-test/home/*/.openclaw/workspace/memory/cards/*.md 2>/dev/null | wc -l)
echo "Knowledge cards: $CARDS"

# 6. Clean up test
rm -rf /tmp/restore-test
```

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

```bash
# 1. Install OpenClaw on the new machine
sudo npm install -g openclaw

# 2. Install restic, copy the passphrase, point at either repo
sudo apt install restic -y
export RESTIC_PASSWORD_FILE=/root/.restic-passphrase

# 3. Restore the latest snapshot to $HOME
restic -r /path/to/repo restore latest --target /

# 4. Verify
openclaw --version
jq . ~/.openclaw/openclaw.json > /dev/null && echo "✓ Config parses"

# 5. Install Ollama and pull models
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-embedding:8b

# 6. Re-install ACPX and Claude Code for the escalation lane
# (see configuration/claude-cli-to-acp-migration.md)

# 7. Restart the gateway and verify channels
systemctl --user restart openclaw-gateway
# Send a test message on each configured channel
```

### Recovery Time Objective

With a good backup and documented procedure, you should be able to rebuild from scratch on new hardware in under an hour:

| Step | Time |
|------|------|
| Install OS + Node.js | 15 min |
| Install OpenClaw | 2 min |
| Restore backup | 5 min |
| Install Ollama + models | 10 min |
| Verify channels | 5 min |
| Test agent responses | 5 min |
| **Total** | **~45 min** |

## Database Backup Warning

If your agent uses SQLite databases (code search index, analytics, etc.), be aware:

- **Ubuntu's SQLite has SECURE_DELETE compiled in.** Deleted data is zeroed on disk. Once gone, it's gone. No "undelete" recovery.
- **Back up databases separately** if they contain data that's expensive to reconstruct (our code search index cost $30 in API calls to rebuild after a sub-agent deleted it).
- **Use `.backup` command** for consistent SQLite backups:

```bash
sqlite3 /path/to/database.db ".backup /path/to/backups/database-$(date +%Y-%m-%d).db"
```

## Verification

```bash
export RESTIC_PASSWORD_FILE=~/.openclaw/.restic-password

echo "=== Latest Snapshot (NAS, expect < 16h old) ==="
restic -r /mnt/nas/backups/openclaw-restic snapshots --latest 1 2>/dev/null || echo "✗ NAS repo unavailable"

echo ""
echo "=== Latest Snapshot (Google Drive, expect < 8 days old) ==="
restic -r rclone:gdrive:Backup/openclaw-restic snapshots --latest 1 2>/dev/null || echo "✗ rclone repo unavailable"

echo ""
echo "=== Passphrase File ==="
[ -f ~/.openclaw/.restic-password ] && echo "✓ Passphrase file exists" || echo "✗ Passphrase file missing!"

echo ""
echo "=== Cron Entries (expect nas + gdrive) ==="
crontab -l 2>/dev/null | grep backup-restic || echo "✗ No backup cron found"

echo ""
echo "=== KeePass Sync Timer ==="
systemctl --user is-active keepass-sync.timer 2>/dev/null && echo "✓ keepass-sync.timer active" || echo "✗ keepass-sync.timer not active"

echo ""
echo "=== NAS Repo Integrity (fast check) ==="
restic -r /mnt/nas/backups/openclaw-restic check --read-data-subset=1% 2>/dev/null | tail -5
```

## Gotchas

1. **Test your restores.** Seriously. Encrypt a backup, delete it from the original location (in a safe environment), and restore it. If you can't restore, you don't have a backup.

2. **Store the passphrase separately.** If your backup passphrase is on the same disk as your backups, a disk failure loses both. Put it in a password manager or print it.

3. **API keys in backups.** Your encrypted backup contains API keys, tokens, and SSH keys. Treat the backup file itself as sensitive. Don't upload unencrypted backups to public cloud storage.

4. **Ollama models aren't in the backup.** They're large (GBs) and re-downloadable. Don't bloat your backups with them. Just re-pull after restore.

5. **Cron jobs live in OpenClaw's state, not in files.** If you recreate your OpenClaw install from config alone, you'll need to re-create your cron jobs. Consider exporting them periodically (`openclaw cron list > cron-export.json`).

6. **Restic `forget --prune` is destructive by design.** The retention flags (`--keep-daily`, `--keep-weekly`, `--keep-monthly`) delete snapshots that don't match. If you typo the keep counts, you lose snapshots. Dry-run the first few prune cycles with `--dry-run` before trusting the schedule.

7. **Back up OAuth state files, not just OpenClaw config.** `~/.codex/auth.json` and `~/.claude/` (ACP session state) aren't in `~/.openclaw/`, but losing them means re-authenticating every subscription after a restore. Include them in your backup paths.

8. **The agent can write to the NAS if you let it.** We enforce read-only-by-default on `/mnt/nas` via mount options, and the only writer is `backup-restic.sh`. If an agent ever gets a writable NAS mount, assume it will eventually touch files it shouldn't. The photos on that NAS are irreplaceable - the mount policy is deliberate, not paranoid.

9. **Never use `set -e` across two backend phases.** With `set -e`, a failed Google Drive phase aborts the script before the NAS backup runs - one flaky off-site write costs you your local backup too. Use `set -uo pipefail`, run each repo in a function that returns non-zero on failure, and report a per-repo exit summary instead of bailing on the first error.

10. **More syncing is not fresher syncing.** Restic-over-rclone with default parallelism, or two rclone jobs hitting Drive at once, trips Google Drive's rate limit and everything stalls in quota-retry loops. Throttle the rclone backend (`RCLONE_TRANSFERS=1`, a pacer, high retry counts), serialize anything that touches Drive, and keep the cloud cadence low (weekly here). The frequent, always-current copy is the local NAS; Drive is the off-site insurance copy.
