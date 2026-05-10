# Upgrade Hygiene: Surviving `openclaw update`

Every OpenClaw minor release has, at least once, silently regenerated my systemd unit and dropped custom directives. If you don't plan for this, the gateway crash-loops at 4am and you find out over breakfast.

**Tested on:** OpenClaw 2026.1.29 → 2026.5.5, Ubuntu 24.04, source-linked install
**Last updated:** 2026-05-06

---

## What Actually Happens on Upgrade

`openclaw update` (or the source-linked `git pull && pnpm build` path) regenerates a handful of user-owned files. In particular:

1. **`~/.config/systemd/user/openclaw-gateway.service`** is rewritten. Any custom `EnvironmentFile=`, `After=`, `Restart=` tweaks you added get dropped.
2. **`~/openclaw/dist/*.js`** is rebuilt. Any local patches you applied to the compiled bundles vanish.
3. **`openclaw.json`** schema can shift. Removed keys become `unknown property` validation errors on next start.
4. **Plugin manifests** in `~/.openclaw/vendor/` can be reset when a bundled version ships upstream.

Upgrades that appear clean in the CLI output still break the next service restart.

## Failure Modes You Care About

### 1. EnvironmentFile dropped from the regenerated unit

Without `EnvironmentFile=`, systemd doesn't load `~/.openclaw/workspace/.env`. The gateway starts, hits the first secret reference in `openclaw.json`, and dies:

```
SecretRefResolutionError: KIMI_API_KEY missing from environment
```

It then crash-loops. If your upgrade runs via cron overnight, every downstream channel (Telegram, Discord, Signal) silently goes offline until morning.

### 2. Stale lazy-imported bundles in the running process

OpenClaw's compiled output ships dozens of `dist/*-<hash>.js` chunks that get loaded lazily the first time a feature is exercised. Each upgrade rewrites those chunks with fresh content hashes. A running gateway holds the OLD hash in memory for every lazy import that hasn't fired yet. The moment a user finally triggers that feature post-upgrade, the dynamic import fails:

```
[tools] diffs failed: Cannot find module
'/home/you/openclaw/dist/markdown-Du8_98GG.js'
imported from /home/you/openclaw/dist/extensions/diffs/index.js
```

The actual file on disk is `markdown-SzrEM4HD.js`. Same module, new hash, written by the update. The running process never reloaded its index, so the old import path is still cached.

This silently breaks tools (diffs, document extraction, anything plugin-loaded) without crashing the gateway, so it can lurk for days. The journal will not show a fatal error, only intermittent `Cannot find module` lines whenever someone tries the affected feature.

**Mitigation:** every upgrade ends with a gateway restart. Make the wrapper restart unconditional, not conditional on whether the unit file changed. The "no, the upgrade was clean" path is exactly what bites you.

### 3. Channel-reload deferral pins the gateway for days

When upgrades write a config delta to `openclaw.json` (`skills.entries`, `wizard.lastRunAt`, `channels.discord.threadBindings.spawn*`), the gateway treats it as a config-driven channel reload and defers the reload until active task runs drain:

```
[reload] config change requires channel reload (discord) - deferring until 1 task run(s) complete
```

If the task that's blocking the reload is stuck (orphaned ACP session, hung exec-approval-followup, anything that doesn't naturally complete), the deferral never resolves. The journal fills with one of these every 30 seconds:

```
[reload] channel reload still deferred after Nms with 1 task run(s) active
```

While that's happening, channels keep accepting messages, the agent keeps generating responses, but reply delivery wedges behind the deferred reload. The bot looks like it stopped typing mid-thread.

The default for `gateway.reload.deferralTimeoutMs` is unset, which the gateway interprets as "wait forever." Set it explicitly so a future deferral can't pin the channel layer indefinitely:

```json
"gateway": {
  "reload": {
    "deferralTimeoutMs": 600000
  }
}
```

10 minutes gives roughly 2x headroom over typical cron task runs and forces the reload through even if the blocking task never completes.

The manual escape from a stuck deferral remains `systemctl --user restart openclaw-gateway`. Once upstream lands the operator-side flag (`openclaw gateway restart --safe --skip-deferral`), that's the cleaner recovery because it goes through the OpenClaw-aware coordinated path while still bypassing the deferral gate.

## The Wrapper Script Pattern

Don't call `openclaw update` directly. Wrap it so post-upgrade fixes always fire. A minimal wrapper:

```bash
#!/usr/bin/env bash
# ~/bin/openclaw-update.sh
set -Eeuo pipefail

UNIT_FILE="$HOME/.config/systemd/user/openclaw-gateway.service"
ENV_FILE="$HOME/.openclaw/workspace/.env"
SNAPSHOT_DIR="$HOME/.openclaw/logs/upgrade-snapshots/$(date +%Y-%m-%d_%H%M%S)"

mkdir -p "$SNAPSHOT_DIR"

# 1. Snapshot before touching anything.
cp "$UNIT_FILE"   "$SNAPSHOT_DIR/openclaw-gateway.service.pre"  2>/dev/null || true
cp "$HOME/.openclaw/openclaw.json" "$SNAPSHOT_DIR/openclaw.json.pre" 2>/dev/null || true

# 2. Run the actual update.
openclaw update

# 3. Restore EnvironmentFile= if the upgrade dropped it.
if ! grep -q "^EnvironmentFile=$ENV_FILE" "$UNIT_FILE"; then
    echo "[restore] EnvironmentFile directive missing - reinserting"
    sed -i "/^\[Service\]/a EnvironmentFile=$ENV_FILE" "$UNIT_FILE"
    systemctl --user daemon-reload
fi

# 4. Reapply any local dist/ patches.
for patch in "$HOME/.openclaw/patches/"*.patch; do
    [ -f "$patch" ] || continue
    echo "[restore] applying $(basename "$patch")"
    patch -d "$HOME/openclaw" -p1 --forward --silent < "$patch" || true
done

# 5. Restart and verify.
systemctl --user restart openclaw-gateway
sleep 3
systemctl --user is-active openclaw-gateway || {
    echo "[fail] gateway did not come back - check journalctl"
    journalctl --user -u openclaw-gateway -n 40 --no-pager
    exit 1
}
```

Schedule it via cron and pipe the output to a log you actually read:

```cron
0 4 * * * /home/you/bin/openclaw-update.sh >> /home/you/.openclaw/workspace/logs/openclaw-update.log 2>&1
```

## Auth Profile Sync

OpenClaw stores OAuth tokens in multiple `auth-profiles.json` files, one per agent. If you rotate a token manually (common with OpenAI Codex OAuth - see [Multi-Model Orchestration](../ai-stack/multi-model-orchestration.md)), all copies must update together or the fallback chain picks a stale one.

The full set on a standard install:

```
~/.openclaw/agents/main/agent/auth-profiles.json
~/.openclaw/agents/coder/agent/auth-profiles.json
~/.openclaw/agents/builder/agent/auth-profiles.json
~/.openclaw/agents/researcher/agent/auth-profiles.json
~/.openclaw/workspace/.openclaw/agents/main/agent/auth-profiles.json
```

Copy fresh Codex tokens across all of them in one pass:

```bash
NEW_TOKEN=$(jq -r '.tokens.access_token' ~/.codex/auth.json)
NEW_REFRESH=$(jq -r '.tokens.refresh_token' ~/.codex/auth.json)

for f in ~/.openclaw/agents/*/agent/auth-profiles.json \
         ~/.openclaw/workspace/.openclaw/agents/*/agent/auth-profiles.json; do
    jq --arg a "$NEW_TOKEN" --arg r "$NEW_REFRESH" \
       '(.profiles[] | select(.provider=="openai-codex")) |=
          (.accessToken=$a | .refreshToken=$r)' \
       "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

systemctl --user restart openclaw-gateway
```

**OAuth refresh tokens rotate single-use.** If the Codex desktop app refreshes at the same moment OpenClaw does, one of them invalidates the other's token. Symptom: `401 refresh_token_reused`. Fix: copy from `~/.codex/auth.json` (the most recent client to refresh) to all OpenClaw profiles and restart.

## Local Patches That Survive Upgrades

Some fixes are easier to patch locally than to get merged upstream fast. Store them as real `.patch` files, not inline sed edits, so your wrapper can reapply them deterministically.

Generate a patch from a working dist edit:

```bash
cd ~/openclaw
git diff dist/pi-embedded-runner-*.js > ~/.openclaw/patches/strict-agentic-actionable.patch
```

On the next upgrade, the wrapper reapplies it. `patch --forward` makes the reapply a no-op if upstream already fixed it, so stale patches don't wedge the build.

**Version-pin the bundle hash in the patch filename.** OpenClaw bundlers include a content hash (e.g. `pi-embedded-runner-C7n0Gv_F.js`) that changes every release. Match on the prefix, not the full name, in your patch hunks. When the hash drifts far enough, the patch will fail - that's your signal to regenerate against the new bundle.

## Schema Drift

Every minor release has deprecated or renamed at least one config key. Before restarting after an upgrade, dry-run the config:

```bash
openclaw doctor
```

Known offenders worth scanning for by hand:

| Old key | New key / Status |
|---------|------------------|
| `ackReaction`, `typingIndicator` (Telegram) | removed 2026.4.14, migrate via `jq del(...)` |
| `anthropic:claude-cli` | deprecated, use `setup-token` (or remove entirely, see [ACP for Claude Code](../ai-stack/acp-claude-code.md)) |
| `fileFormat`/`fileQuality` in diffs plugin | never valid, plugin docs were wrong |
| Scalar streaming config | removed 2026.4.14 |

`openclaw doctor --fix` is a stub on most of these. Migrate with `jq` and commit the change yourself:

```bash
jq 'del(.channels.telegram.ackReaction, .channels.telegram.typingIndicator)' \
   ~/.openclaw/openclaw.json > /tmp/x && mv /tmp/x ~/.openclaw/openclaw.json
```

## Snapshot Before Upgrade

Any upgrade wrapper worth running saves restore points. At minimum:

- `openclaw-gateway.service` (pre-upgrade copy)
- `openclaw.json` (pre-upgrade copy)
- Each `auth-profiles.json`
- `~/.openclaw/workspace/.env`

Keep at least 14 days of these. Upgrades that go wrong often don't fail at upgrade time - they fail on the first heartbeat cron 6 hours later. You want to diff against what worked yesterday, not what you remember.

## Verification

After any upgrade, before trusting the system:

```bash
# Gateway up and responding
systemctl --user is-active openclaw-gateway
curl -sf http://127.0.0.1:18789/health

# Version matches expectation
openclaw --version

# EnvironmentFile is still wired
grep EnvironmentFile ~/.config/systemd/user/openclaw-gateway.service

# All auth profiles resolve
openclaw secrets audit

# No orphan sessions
openclaw doctor | grep -iE 'warn|error' || echo "clean"

# No deferred channel reloads pinning the gateway
journalctl --user -u openclaw-gateway --since "-5min" \
  | grep -E '\[reload\] channel reload still deferred' \
  || echo "clean"

# Lazy-import paths in compiled extensions still resolve on disk
# (catches stale-bundle staleness if the gateway wasn't actually restarted)
for ref in $(grep -hoE 'dist/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js' \
                 ~/openclaw/dist/extensions/*/index.js \
             | sort -u); do
    [ -f ~/openclaw/$ref ] || echo "stale ref: $ref"
done
```

If the gateway is up but an agent silently landed on the wrong fallback model (OAuth rotation can do this), you won't see it here. Watch for it on the next real request.

## Gotchas

1. **`systemctl --user` under cron needs `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`.** Cron's environment is minimal. If your wrapper restarts the gateway from cron, export both or the restart silently fails.

2. **Upgrade unit Description is cosmetic.** The `Description=OpenClaw Gateway v2026.1.29` line in the unit file doesn't update with the binary. Don't use `systemctl status` to confirm the version - use `openclaw --version`.

3. **`plugins.allow` is an exclusive whitelist.** If you added entries to silence a startup warning, even bundled plugins get blocked when not listed. Re-audit after upgrades that add new bundled plugins (the most likely being `anthropic` and `openai`).

4. **Context pruning can split tool_use/tool_result pairs across upgrades.** If a post-upgrade restart happens mid-session with a long conversation, the pruner may drop a `tool_result` while keeping its `tool_use`. The next turn hits a hard Anthropic 400: `tool_use ids were found without tool_result blocks`. Only fix is a fresh session - so pick your upgrade window.

5. **Don't upgrade and reconfigure in the same window.** If the gateway crash-loops, you won't know whether the upgrade or your edits broke it. Upgrade, verify, commit. Reconfigure on a separate day.
