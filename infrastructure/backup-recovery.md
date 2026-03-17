# Backup & Recovery

How to protect your OpenClaw workspace, configuration, and memory from data loss. Encrypted backups, restore testing, and disaster recovery planning.

**Tested on:** OpenClaw on Ubuntu 24.04, backup to NAS and cloud
**Last updated:** 2026-03-17

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

### Daily Automated Backup

Create a backup script that runs via cron:

```bash
#!/bin/bash
# backup-openclaw.sh
set -euo pipefail

BACKUP_DIR="/path/to/backups/openclaw"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="$BACKUP_DIR/openclaw-$DATE.tar.gz.gpg"
PASSPHRASE_FILE="/root/.backup-passphrase"

# Create backup directory if needed
mkdir -p "$BACKUP_DIR"

# Archive critical files
tar czf - \
  ~/.openclaw/openclaw.json \
  ~/.openclaw/workspace/ \
  ~/.openclaw/hooks/ \
  ~/.ssh/ \
  ~/.bashrc \
  ~/.env \
  2>/dev/null | \
  gpg --symmetric --cipher-algo AES256 \
    --batch --passphrase-file "$PASSPHRASE_FILE" \
    > "$BACKUP_FILE"

# Verify the backup was created
if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "Backup created: $BACKUP_FILE ($SIZE)"
else
  echo "ERROR: Backup failed" >&2
  exit 1
fi

# Rotate: keep 30 days
find "$BACKUP_DIR" -name "openclaw-*.tar.gz.gpg" -mtime +30 -delete

echo "Backup complete. Rotation done."
```

### Set Up the Passphrase

```bash
# Generate a strong passphrase
openssl rand -base64 32 > /root/.backup-passphrase
chmod 600 /root/.backup-passphrase
```

Store this passphrase somewhere outside your machine (password manager, printed copy in a safe, etc.). If you lose it, your encrypted backups are useless.

### Schedule the Backup

```bash
# Add to crontab
sudo crontab -e

# Run at 3am daily
0 3 * * * /home/your-user/scripts/backup-openclaw.sh >> /var/log/openclaw-backup.log 2>&1
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

### Local NAS

Good for fast restores and large backups:

```bash
# Mount NAS (if using SMB)
sudo mount -t cifs //192.168.x.x/backups /mnt/nas -o guest

# Copy backups to NAS
rsync -av /path/to/backups/openclaw/ /mnt/nas/openclaw-backups/
```

### Cloud Storage

Good for off-site protection. Use encrypted backups (already GPG-encrypted above):

```bash
# Sync to cloud storage via rclone
rclone sync /path/to/backups/openclaw/ remote:openclaw-backups/
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
# 1. Decrypt the backup
gpg --decrypt --batch --passphrase-file /root/.backup-passphrase \
  openclaw-2026-03-17.tar.gz.gpg | tar xzf - -C /tmp/restore-test/

# 2. Verify contents
ls -la /tmp/restore-test/.openclaw/
ls -la /tmp/restore-test/.openclaw/workspace/
cat /tmp/restore-test/.openclaw/openclaw.json | python3 -m json.tool > /dev/null && echo "Config valid"

# 3. Check critical files exist
for f in openclaw.json; do
  [ -f "/tmp/restore-test/.openclaw/$f" ] && echo "✓ $f" || echo "✗ $f MISSING"
done

for f in SOUL.md AGENTS.md MEMORY.md USER.md TOOLS.md; do
  [ -f "/tmp/restore-test/.openclaw/workspace/$f" ] && echo "✓ $f" || echo "✗ $f MISSING"
done

# 4. Count knowledge cards
CARDS=$(ls /tmp/restore-test/.openclaw/workspace/memory/cards/*.md 2>/dev/null | wc -l)
echo "Knowledge cards: $CARDS"

# 5. Clean up test
rm -rf /tmp/restore-test/
```

### Restore to a New Machine

```bash
# 1. Install OpenClaw on the new machine
sudo npm install -g openclaw

# 2. Decrypt and extract backup to home directory
gpg --decrypt --batch --passphrase-file /path/to/passphrase \
  openclaw-latest.tar.gz.gpg | tar xzf - -C ~/

# 3. Verify config
openclaw --version
cat ~/.openclaw/openclaw.json | python3 -m json.tool

# 4. Install Ollama and pull models (if using local models)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text

# 5. Start the gateway
openclaw gateway start

# 6. Verify channels are connected
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
echo "=== Latest Backup ==="
ls -lht /path/to/backups/openclaw/ | head -5

echo ""
echo "=== Backup Age ==="
LATEST=$(ls -t /path/to/backups/openclaw/openclaw-*.gpg 2>/dev/null | head -1)
if [ ! -z "$LATEST" ]; then
  AGE=$(( ($(date +%s) - $(stat -c %Y "$LATEST")) / 3600 ))
  echo "Latest backup: $LATEST (${AGE}h old)"
  if [ "$AGE" -gt 48 ]; then
    echo "⚠ Backup is over 48 hours old!"
  else
    echo "✓ Backup is current"
  fi
else
  echo "✗ No backups found!"
fi

echo ""
echo "=== Passphrase File ==="
[ -f /root/.backup-passphrase ] && echo "✓ Passphrase file exists" || echo "✗ Passphrase file missing!"

echo ""
echo "=== Cron Entry ==="
sudo crontab -l 2>/dev/null | grep backup || echo "✗ No backup cron found"
```

## Gotchas

1. **Test your restores.** Seriously. Encrypt a backup, delete it from the original location (in a safe environment), and restore it. If you can't restore, you don't have a backup.

2. **Store the passphrase separately.** If your backup passphrase is on the same disk as your backups, a disk failure loses both. Put it in a password manager or print it.

3. **API keys in backups.** Your encrypted backup contains API keys, tokens, and SSH keys. Treat the backup file itself as sensitive. Don't upload unencrypted backups to public cloud storage.

4. **Ollama models aren't in the backup.** They're large (GBs) and re-downloadable. Don't bloat your backups with them. Just re-pull after restore.

5. **Cron jobs live in OpenClaw's state, not in files.** If you recreate your OpenClaw install from config alone, you'll need to re-create your cron jobs. Consider exporting them periodically (`openclaw cron list > cron-export.json`).
