# Backup & Recovery

How to protect your OpenClaw workspace, configuration, and memory from data loss. Encrypted backups, restore testing, and disaster recovery planning.

**Tested on:** OpenClaw 2026.4.x on Ubuntu 24.04, restic to Google Drive (rclone) + an SMB-mounted NAS, twice-daily schedule
**Last updated:** 2026-04-19

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

### Twice-Daily Backup to Two Destinations

We run restic twice daily (3am and 3pm) with two destinations: Google Drive (via rclone) and a local NAS (`/mnt/nas/backups/openclaw-restic`). Losing one doesn't lose the other.

```bash
#!/bin/bash
# backup-restic.sh
set -euo pipefail

export RESTIC_PASSWORD_FILE=/root/.restic-passphrase

PATHS=(
  "$HOME/.openclaw/openclaw.json"
  "$HOME/.openclaw/workspace"
  "$HOME/.openclaw/hooks"
  "$HOME/.openclaw/vendor"          # ACPX binary and related
  "$HOME/.ssh"
  "$HOME/.bashrc"
  "$HOME/.openclaw/workspace/.env"
  "$HOME/.codex/auth.json"          # OpenAI Codex OAuth state
  "$HOME/.claude"                   # Claude Code auth (ACP path)
)

# Destination 1: rclone-backed Google Drive
restic -r rclone:gdrive:openclaw-restic backup "${PATHS[@]}" --tag auto
restic -r rclone:gdrive:openclaw-restic forget --tag auto --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune

# Destination 2: local NAS
if mountpoint -q /mnt/nas; then
  restic -r /mnt/nas/backups/openclaw-restic backup "${PATHS[@]}" --tag auto
  restic -r /mnt/nas/backups/openclaw-restic forget --tag auto --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune
else
  echo "WARN: NAS not mounted, skipping local backup" >&2
fi
```

### Set Up the Passphrase

```bash
openssl rand -base64 32 > /root/.restic-passphrase
chmod 600 /root/.restic-passphrase
```

Store this passphrase somewhere outside your machine (password manager, printed copy in a safe). If you lose it, both restic repositories become unreadable.

### Initialize the Repositories (One Time)

```bash
restic -r rclone:gdrive:openclaw-restic init
restic -r /mnt/nas/backups/openclaw-restic init
```

### Schedule the Backup

```bash
crontab -e
# Twice daily: 3am and 3pm
0 3,15 * * * /home/your-user/scripts/backup-restic.sh >> /var/log/openclaw-backup.log 2>&1
```

Or use an OpenClaw cron job to verify the backup ran:

```json
{
  "name": "backup-check",
  "schedule": {
    "kind": "cron",
    "expr": "0 8 * * *",
    "tz": "America/New_York"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Check that today's backup exists in /path/to/backups/openclaw/. Report the file size and confirm it was created within the last 24 hours."
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
export RESTIC_PASSWORD_FILE=/root/.restic-passphrase

echo "=== Latest Snapshot (NAS) ==="
restic -r /mnt/nas/backups/openclaw-restic snapshots --latest 1 2>/dev/null || echo "✗ NAS repo unavailable"

echo ""
echo "=== Latest Snapshot (rclone:gdrive) ==="
restic -r rclone:gdrive:openclaw-restic snapshots --latest 1 2>/dev/null || echo "✗ rclone repo unavailable"

echo ""
echo "=== Passphrase File ==="
[ -f /root/.restic-passphrase ] && echo "✓ Passphrase file exists" || echo "✗ Passphrase file missing!"

echo ""
echo "=== Cron Entry ==="
crontab -l 2>/dev/null | grep backup-restic || echo "✗ No backup cron found"

echo ""
echo "=== Repo Integrity (fast check) ==="
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

8. **The agent can write to the NAS if you let it.** We enforce read-only-by-default on `/mnt/nas` via mount options, and the only writer is `backup-restic.sh`. If an agent ever gets a writable NAS mount, assume it will eventually touch files it shouldn't. The photos on that NAS are irreplaceable — the mount policy is deliberate, not paranoid.
