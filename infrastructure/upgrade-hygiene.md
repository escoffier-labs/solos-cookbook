# Upgrade Hygiene: Promoting OpenClaw Releases Without Breaking the Gateway

Every OpenClaw minor release has, at least once, silently regenerated my systemd unit or broken on old config. I stopped upgrading in place. A promote script now builds a tagged release in its own worktree, rehearses it, snapshots state, migrates config, and switches the gateway over, with an automatic rollback if the new build is not healthy.

**Tested on:** OpenClaw 2026.10.4 (promoted 2026-10-17), earlier history from 2026.1.29 through 2026.9.x, Ubuntu 24.04, Node 24.x
**Last updated:** 2026-10-17

---

## What Changed, and Why

The original setup was `openclaw update` (or `git pull && pnpm build`) wrapped in a script that patched the systemd unit afterwards. That worked until it did not. On 2026-07-05 I retired the nightly auto-update: a blind in-place update caused silent breakage, and the wrapper could only repair the damage it knew about. The relevant config now says so explicitly (`update.auto.enabled: false`, channel `stable`), and the nightly cron slot that used to run the updater is commented out with a note.

Releases now move like this:

1. A daily, report-only preflight builds the candidate in a throwaway worktree and checks that it would boot against a copy of live state. It never promotes anything.
2. When I decide to move, I run the promote script by hand with an exact release tag.
3. The script checks out that tag into `~/worktrees/openclaw-<tag>`, builds it, snapshots all state, migrates config with the candidate's own `doctor`, repoints the gateway at the new `dist`, and waits for health.
4. If health fails, or the script is interrupted, it restores the snapshot and the previous drop-ins automatically.

The old build stays on disk in its own worktree, untouched. That alone removes most of the failure modes below.

## The Promotion Flow

Command shape:

```bash
~/bin/openclaw-promote.sh v2026.10.4        # stable tag
~/bin/openclaw-promote.sh v2026.10.5-beta.1 # beta tag (only stable or beta tags are accepted)
```

What the script does, in order (read from the script, not paraphrased from memory):

1. **Validate the tag.** Only `vN.N...` (stable) or `vN.N...-beta.N` (beta) tags are accepted. The tag must also be the newest remote release tag on its channel. For stable, "newest" follows the npm `dist-tags.latest` value, because upstream can push a stable-looking tag before it is published. A stale or hand-made local tag is refused.
2. **Take a lock.** A `flock` on a lock file means a second promotion exits instead of racing the first.
3. **Resolve one absolute Node runtime.** OpenClaw needs Node 24.16 or newer on the 24 line, or 26.1 and up. The system `node` may be older and the PATH one may be a version-manager shim, so the script resolves an absolute path once (override with `OPENCLAW_PROMOTE_NODE`) and uses it for preflight, build, doctor, and the final `ExecStart`.
4. **Rehearse.** It reruns the full-state preflight for the channel right now. If the candidate cannot boot against a disposable copy of state, it stops before any downtime.
5. **Check out and build.** `git fetch` the tag into a private ref, then `git worktree add --detach ~/worktrees/openclaw-<tag>` (or move an existing worktree to it). It refuses to continue if the worktree has tracked modifications. It then runs `pnpm install --frozen-lockfile` and `pnpm build`, and records the built commit in a marker file so a rerun reuses the build.
6. **Snapshot, with the gateway stopped.** It copies the drop-in directory and the base unit file, stops the gateway, then takes a consistent snapshot of `~/.openclaw` to `~/.local/state/openclaw-promote-snapshots/<timestamp>/state`. The destination must live outside `~/.openclaw`. The snapshot tool refuses a destination inside its source. Stopping first means sidecar files, config, and SQLite backup points describe one state.
7. **Migrate config.** The candidate refuses to boot on unmigrated config (true from 2026.8 on), so the script runs the candidate's own doctor against live state: `doctor --fix --non-interactive --no-workspace-suggestions`. Doctor sometimes rewrites the base unit file. The script compares checksums and puts the pre-promotion unit back if it changed. Doctor can also restart a stopped gateway on the old `ExecStart` against freshly migrated config, so the script stops it again and clears failed state before switching.
8. **Repoint the gateway.** It writes a systemd drop-in, `beta-exec.conf` (the name is historical), that clears and sets `ExecStart` to the resolved Node plus `<worktree>/dist/index.js gateway --port <port>`, updates the version label in `version.conf`, then runs `daemon-reload` and starts the unit.
9. **Wait for health.** Up to 36 checks, 5 seconds apart: `GET /healthz` must return `"ok":true` **and** the unit's `NRestarts` must still be 0. A gateway that comes up and crash-loops does not pass.
10. **On success:** repoint `~/bin/openclaw` at the new worktree's `openclaw.mjs` (an older CLI trips the downgrade guard once the gateway has written config), write the Node path to `~/.local/state/openclaw-node`, and prune old rollback snapshots (default: keep only the newest).
11. **On failure or interrupt:** an `EXIT` trap stops the gateway, restores the state snapshot, restores the previous drop-ins and base unit, reloads systemd, and starts the old build. If any restore step fails the script logs `FATAL` and says so rather than pretending.

Everything is logged to a file under the workspace logs directory with timestamps. `PROMOTED to <tag>. health ok; rollback snapshot: <path>` is the success line.

### The system-wide wrapper

Cron jobs and scripts run with a bare PATH, where `openclaw` used to resolve to a stale source checkout and the system `node` was too old. The promote script writes the Node path it used to `~/.local/state/openclaw-node`, and a small root-owned `/usr/bin/openclaw` wrapper reads that file and runs `~/bin/openclaw` under it:

```sh
#!/bin/sh
node_bin=${OPENCLAW_NODE:-}
[ -z "$node_bin" ] && [ -r "$HOME/.local/state/openclaw-node" ] && node_bin=$(head -n 1 "$HOME/.local/state/openclaw-node")
[ -x "$node_bin" ] || { echo "openclaw: no promoted Node runtime; run the promote script" >&2; exit 127; }
exec "$node_bin" "$HOME/bin/openclaw" "$@"
```

The point is that bare-PATH callers always get the promoted build and the Node it was built for. The source clone (`~/openclaw`) is now only a git source for tags. Running it directly can recreate state files that a newer doctor refuses to migrate.

### Rollback

Automatic rollback covers a failed promotion. If a promotion succeeded and you want to go back later, the script has no flag for it and I have not needed to. The manual equivalent is what the script's own rollback function does: stop the gateway, restore the state snapshot with the snapshot tool (`restore <snapshot>/state ~/.openclaw`), clear the drop-in directory and copy the snapshot's `dropins/` back, restore the saved base unit, `daemon-reload`, start. Two cautions:

- The snapshot is from just before the migration, so anything the new build wrote since is lost.
- I only keep the newest snapshot (about 11 GB here), so older state comes from the nightly restic backup.

### Preflight (the daily rehearsal)

`openclaw-preflight.sh [--quiet] [--local-worktree <path>] [beta|stable]` builds the channel's candidate in a separate preflight worktree, makes a disposable migration-state snapshot, disables delivery and scheduling in the copy, and requires an isolated candidate gateway to become healthy. It is report-only. My crontab fires it daily at 02:00 through a Brigade runbook (`brigade runbook run --approved openclaw-preflight.json`) and the result lands in a log. A failing preflight is a reason not to promote that tag.

## Failure Modes You Care About

### 1. Unit file regenerated, custom directives dropped

Upgrades that reinstall the service rewrite `~/.config/systemd/user/openclaw-gateway.service`. Anything you added to that file (`EnvironmentFile=`, `After=`, `Restart=`) is gone, the gateway starts without its secrets, hits the first secret reference in `openclaw.json`, and crash-loops:

```
SecretRefResolutionError: KIMI_API_KEY missing from environment
```

**Fix (now structural):** put every custom directive in a drop-in under `openclaw-gateway.service.d/` instead of the unit file. Mine are one file per concern: a secrets drop-in (an `EnvironmentFile=` pointing at a tmpfs render, ordered after the render service), the promote-managed `beta-exec.conf` and `version.conf`, a `PATH` drop-in, a slice assignment, and a `ManagedOOMPreference=avoid` drop-in added after systemd-oomd killed the gateway twice under memory pressure. Regeneration cannot touch them, and the promote script snapshots and restores the whole directory.

### 2. Stale lazy-imported bundles in the running process (history)

OpenClaw's compiled output ships dozens of `dist/*-<hash>.js` chunks that load lazily. An in-place upgrade rewrote those chunks under new hashes while the running gateway still held the old paths, so the first use of a feature after the upgrade failed:

```
[tools] diffs failed: Cannot find module
'/opt/openclaw/dist/markdown-Du8_98GG.js'
imported from /opt/openclaw/dist/extensions/diffs/index.js
```

That could lurk for days because it did not crash anything. **Fix now:** each release builds into its own worktree and is never rewritten, so a running gateway cannot lose its chunks mid-flight, and promotion stops and starts the gateway anyway. I also restart the gateway on a nightly timer (04:30).

### 3. Channel-reload deferral pins the gateway for days (history)

A config delta written to `openclaw.json` (`skills.entries`, `wizard.lastRunAt`, `channels.discord.threadBindings.spawn*`) was treated as a channel reload, deferred until active task runs drained. A stuck task (an orphaned ACP session, a hung exec-approval follow-up) made the deferral wait forever:

```
[reload] config change requires channel reload (discord) - deferring until 1 task run(s) complete
[reload] channel reload still deferred after Nms with 1 task run(s) active
```

Channels kept accepting messages but reply delivery wedged behind the reload. The setting that bounds it is `gateway.reload.deferralTimeoutMs`, which I set to 600000 at the time. I do not set it on 2026.10.4 and have seen no deferral lines in the last few days of logs, so treat it as a fix to reach for if the symptom returns. The manual escape is `systemctl --user restart openclaw-gateway`.

### 4. `doctor` rewrote model prefixes (history)

On 2026.5.5 and nearby, doctor's normalize pass rewrote `openai-codex/<id>` model references to `openai/<id>` in the default model, heartbeat model, and per-agent models. On an OAuth-only setup with no API key, every agent run then died with `No API key found for provider "openai"`. I restored the prefix in my wrapper after each upgrade. Current releases use the `openai/<id>` form natively and my config already has it, so there is nothing to restore, but the diagnostic still applies after any doctor run: check the gateway's boot line for the agent model and confirm the provider prefix is the one you have credentials for.

### 5. Doctor touches the base unit

Some versions of `doctor --fix` rewrite the base service file. The promote script handles this by checksumming the unit before and after and restoring the saved copy. If you promote by hand, do the same.

## Auth Profile Sync

On 2026.10 OAuth profiles live in OpenClaw's SQLite-backed auth store, not in hand-editable `auth-profiles.json` files. Stray `auth-profiles.json` copies from older releases can still sit on disk, so do not treat them as the source of truth and do not copy tokens into them. After an upgrade, check `openclaw models auth list` and each agent's auth order. The recovery recipe (device-code login, then `models auth order set` per agent, restart, live turn) is in [OAuth token lifecycle](../ai-stack/oauth-token-lifecycle.md).

**OAuth refresh tokens rotate single-use.** If the Codex desktop app refreshes at the same moment OpenClaw does, one of them invalidates the other's token. Symptom: `401 refresh_token_reused`. Fix: re-authenticate OpenClaw with its own device-code login instead of copying another client's refresh token, then restart the gateway (see the OAuth guide). I also run a daily timer (08:15) that probes the OpenAI auth path, so a dead token is a notification, not a surprise.

## Schema Drift

Every minor release has deprecated or renamed at least one config key. The promote script runs the candidate's `doctor --fix --non-interactive` for you, but you can see what it would complain about first:

```bash
openclaw doctor --lint
```

`--lint` runs read-only health checks and reports findings. `--fix` applies repairs. `--non-interactive` restricts it to safe migrations. Known offenders from history:

| Old key | New key / Status |
|---------|------------------|
| `ackReaction`, `typingIndicator` (Telegram) | removed 2026.4.14, migrate via `jq del(...)` |
| Scalar streaming config | removed 2026.4.14. Streaming is an object (`mode`, `progress`) |
| `anthropic:claude-cli` | deprecated, use `setup-token` (or remove entirely, see [ACP for Claude Code](../ai-stack/acp-claude-code.md)) |
| `fileFormat`/`fileQuality` in diffs plugin | never valid, plugin docs were wrong |
| `agents.defaults.reset` | moved to `session.reset` (see [Multi-channel setup](../automation/multi-channel-setup.md)) |
| Job-level cron `elevated`, `:cron` model alias | gone. See [openclaw-cron-deep-dive](../automation/openclaw-cron-deep-dive.md) |

When doctor cannot migrate a key, do it with `jq`, back up first, and commit the change yourself.

## What a Snapshot Has to Cover

The promote script's snapshot is a full, consistent copy of `~/.openclaw` (including SQLite state, taken with the gateway stopped), plus the drop-in directory and the base unit file. That is the minimum:

- The gateway's systemd drop-ins and base unit (the rollback must restore the old `ExecStart`)
- `openclaw.json` and every sidecar next to it
- Agent and cron state (the cron store is SQLite, not a JSON file)
- Auth profiles

Keep at least one rollback point plus an independent backup. Upgrades that go wrong often fail hours later, at the first scheduled job, not at upgrade time. A full snapshot is large (about 11 GB here), which is why I keep one and rely on restic for history.

## Verification

After any promotion, before trusting the system:

```bash
# Gateway up and responding
systemctl --user is-active openclaw-gateway
# Expected: active
curl -sf http://127.0.0.1:18789/healthz
# Expected: {"ok":true,"status":"live"}

# Version matches expectation
openclaw --version
# Expected: OpenClaw 2026.10.4 (383c124)

# The unit runs the promoted worktree, not the source clone
systemctl --user show openclaw-gateway -p ExecStart --value | grep -o 'worktrees/openclaw-[^/]*'
# Expected: worktrees/openclaw-v2026.10.4

# The drop-ins survived (names, not contents)
ls ~/.config/systemd/user/openclaw-gateway.service.d/
# Expected: includes beta-exec.conf and version.conf, plus your own drop-ins

# The system-wide wrapper has a recorded Node, and it is executable
test -x "$(head -n 1 ~/.local/state/openclaw-node)" && echo "node ok"
# Expected: node ok

# No crash loop
systemctl --user show openclaw-gateway -p NRestarts --value
# Expected: 0

# Last promotion result
grep -E 'PROMOTED|FATAL|rollback (start|complete)' ~/.openclaw/workspace/logs/openclaw-promote.log | tail -3
# Expected: a "PROMOTED to v... health ok" line as the last match, with no FATAL or rollback after it

# All secrets and auth profiles resolve (run in a shell with your secrets environment loaded)
openclaw secrets audit

# Config health, read-only
openclaw doctor --lint

# No deferred channel reloads pinning the gateway
journalctl --user -u openclaw-gateway --since "-5min" \
  | grep -E '\[reload\] channel reload still deferred' \
  || echo "clean"
```

If the gateway is up but an agent silently landed on the wrong fallback model (OAuth rotation can do this), you won't see it here. Watch for it on the next real request.

## Gotchas

1. **`systemctl --user` under cron needs `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`.** Cron's environment is minimal. The promote script exports both itself and refuses to run if the user bus socket is missing. Do the same in any wrapper you call from cron.

2. **Unit `Description` is cosmetic.** The label does not follow the binary. The promote script rewrites `version.conf` (the `Description=` and `OPENCLAW_SERVICE_VERSION=` lines), but verify the version with `openclaw --version`, not `systemctl status`.

3. **`plugins.allow` is an exclusive whitelist.** If you added entries to silence a startup warning, even bundled plugins get blocked when not listed. Re-audit after upgrades that add new bundled plugins (the most likely being `anthropic` and `openai`).

4. **Context pruning can split tool_use/tool_result pairs across a restart.** If a restart happens mid-session with a long conversation, the pruner may drop a `tool_result` while keeping its `tool_use`. The next turn hits a hard Anthropic 400: `tool_use ids were found without tool_result blocks`. Only fix is a fresh session, so pick your promotion window.

5. **Don't promote and reconfigure in the same window.** If the gateway crash-loops, you won't know whether the release or your edits broke it. Promote, verify, commit. Reconfigure on a separate day.

6. **Doctor must run from the candidate, not the old CLI.** From 2026.8 the candidate refuses to boot on unmigrated config, and an older CLI trips a downgrade guard once the gateway has written config. That is why the script runs `doctor` from the new worktree and repoints the CLI symlink on success.

7. **Do not `npm install -g openclaw` and do not run the source clone directly.** Either one bypasses the promoted build and Node runtime, and a stray run of an older checkout can recreate state files that the current doctor will not migrate.

8. **Snapshots eat disk.** Each one is a full state copy (about 11 GB for the current one here). The script keeps only the newest by default (`OPENCLAW_PROMOTE_KEEP_SNAPSHOTS`). An earlier version without pruning accumulated 151 GB of stale snapshots before I noticed.

9. **Read the logs before blaming the tag.** The health gate needs `/healthz` ok and `NRestarts` at 0 within about three minutes. When it fails, the automatic rollback has already put the old build back, so read the promote log and the snapshot's `doctor.log` for the real cause before deciding the release is bad.
