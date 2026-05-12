# Repo Redeploy

> One cron job, every ten minutes, watches your own MCP servers and CLI tools for new commits on `main` and quietly redeploys them in place. Push from anywhere, the change is live within ten minutes.

## What this is

A single bash script (`~/bin/repo-redeploy.sh`) that:

1. Iterates a list of repos you own (your own MCP servers, your own CLIs).
2. For each one, fetches `origin/main`. If the local checkout is behind, it pulls, runs the per-repo build/install steps, and (when a remote host depends on the same binary) syncs the built tree to that host.
3. No-ops cleanly when everything is current, so it is safe to run from cron on a tight interval.

This is the deployment surface for the parts of the stack you publish to GitHub and npm. The agent stack itself does not get touched; this is for the tools the agent uses.

## Why this way

Your own published tools sit on the boundary between "source code in a GitHub repo" and "binary the agent shells out to." That boundary is a constant source of drift:

| Drift case | What happens without redeploy | What happens with redeploy |
|------------|-------------------------------|----------------------------|
| You push a fix to your own MCP server's repo | Local `~/repos/<mcp>` is now behind GitHub. The agent uses the old binary. You forget for two days. | Within 10 minutes, `~/repos/<mcp>` is pulled and rebuilt. Next session sees the fix. |
| A second machine consumes the same binary | You forget to sync after every release | The script tarballs the build and pushes it to the second host as part of the same run |
| The tool is an npm-distributed package | You manually `npm install -g` after every release | The script polls npm, compares versions, bumps when behind |
| You force a redeploy (testing a local edit) | You manually run all the build steps | `REPO_REDEPLOY_FORCE=1 ~/bin/repo-redeploy.sh` does it for you |

The alternative deployment topologies all cost more:

- **Per-repo GitHub Actions deploying via SSH.** You manage secrets in CI, the cold-start latency is minutes, and every repo has a copy of the deploy logic.
- **A real CI/CD pipeline.** Overkill for one-author tools and an audience of one machine.
- **Manual `git pull && npm run build` after every push.** Works until you forget.

A single bash script that any half-decent engineer can read in five minutes wins. The whole script is under 250 lines including the per-repo functions.

## Prerequisites

- A directory like `~/repos/` where each tool is a sibling git checkout
- SSH access from the agent host to any secondary host that consumes binaries (with key-only auth and no passphrase prompts in cron context)
- `tar`, `scp`, `ssh`, `git`, `npm`, and `jq` on the agent host
- A cron facility (user crontab or a systemd timer; see [`../automation/cron-patterns.md`](../automation/cron-patterns.md))

## Before / After

**Before:** every push to your own MCP or CLI repo is followed by a hand-rolled "ssh, pull, install, restart" dance. Half the time you forget the secondary host. The agent uses last week's binary for a day before someone notices.

**After:** push to GitHub. Walk away. Ten minutes later, the agent host has the new binary, and any secondary host that consumes it does too. The redeploy log says exactly what happened.

## Implementation

### Script layout

The script is a sequence of `deploy_<tool>` functions plus an `is_behind` helper, called from a small `main`:

```bash
#!/usr/bin/env bash
# ~/bin/repo-redeploy.sh
set -Eeuo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/bin:$PATH"

LOG_DIR="$HOME/.openclaw/workspace/logs"
LOG_FILE="$LOG_DIR/repo-redeploy.log"
mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

# Log to file unless invoked interactively, in which case tee to stdout too.
if [ -t 1 ]; then
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec >>"$LOG_FILE" 2>&1
fi

FORCE="${REPO_REDEPLOY_FORCE:-0}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

is_behind() {
    local repo="$1" branch="$2"
    git -C "$repo" fetch --quiet origin "$branch"
    [ "$(git -C "$repo" rev-parse "$branch")" \
      != "$(git -C "$repo" rev-parse "origin/$branch")" ]
}
```

`is_behind` is the only flow-control primitive. Each `deploy_*` function calls it first and returns early if the local checkout is current.

### Per-repo deploy function shape

The common shape:

```bash
deploy_my_mcp() {
    local repo="$HOME/repos/my-mcp"
    [ -d "$repo/.git" ] || { log "my-mcp: repo missing, skipping"; return; }

    if [ "$FORCE" != "1" ] && ! is_behind "$repo" main; then
        return
    fi

    log "my-mcp: redeploying"
    git -C "$repo" pull --ff-only origin main
    (cd "$repo" && npm install --no-audit --no-fund --silent)
    (cd "$repo" && npm run build)
    log "my-mcp: local build current ($(git -C "$repo" rev-parse --short HEAD))"
}
```

Three things this shape gets right:

1. **`pull --ff-only`** refuses to fast-forward over a divergent local branch. If a local edit is sitting on `main` un-pushed, the redeploy stops and complains in the log rather than discarding work.
2. **`npm install --no-audit --no-fund --silent`** keeps cron output sane. Without `--silent` the log fills with peer-dependency warnings every ten minutes.
3. **The short SHA in the log line** is the only thing you actually need when looking back: "what is currently installed and when did it become so?"

### Syncing to a secondary host

When a tool also needs to run on a second machine (a Windows desktop that hosts the actual service the MCP wraps, for example), add a tar-and-scp step:

```bash
if ssh -o ConnectTimeout=5 -o BatchMode=yes secondary-host 'echo ok' >/dev/null 2>&1; then
    local tarball="/tmp/my-mcp-deploy.$$.tar.gz"
    tar --exclude=node_modules --exclude=.git -czf "$tarball" -C "$repo" .
    scp -q "$tarball" secondary-host:/path/on/secondary/my-mcp/_deploy.tar.gz
    rm -f "$tarball"
    ssh secondary-host 'cd /path/on/secondary/my-mcp && \
        tar -xzf _deploy.tar.gz && rm _deploy.tar.gz && \
        npm install --omit=dev --no-audit --no-fund --silent' >/dev/null
    log "my-mcp: synced to secondary-host"
else
    log "my-mcp: secondary-host unreachable, skipped remote sync"
fi
```

Key choices:

- **`BatchMode=yes`** ensures cron-context SSH never hangs waiting for a password.
- **Tarball over a directory `rsync`** is faster for small repos and avoids `rsync`'s `--exclude` quoting traps.
- **`--omit=dev` on the remote install** keeps the production tree slim. The dev deps were only needed to build.
- **Failed remote sync is non-fatal.** The local install is still current; the next cron run will retry the sync.

### npm-distributed tools

For tools you publish to npm but install globally (CLI binaries, not MCP servers spawned by clients), compare installed version vs registry instead of git:

```bash
deploy_playwright_cli() {
    local pkg="@playwright/cli"
    local installed latest
    installed=$(playwright-cli --version 2>/dev/null || echo "none")
    latest=$(npm view "$pkg" version 2>/dev/null || echo "")
    [ -n "$latest" ] || { log "playwright-cli: npm view failed, skipping"; return; }

    if [ "$FORCE" != "1" ] && [ "$installed" = "$latest" ]; then
        return
    fi

    log "playwright-cli: bumping $installed -> $latest"
    npm install -g "$pkg@latest" --no-audit --no-fund --silent
}
```

### Scheduling

Append to user crontab:

```cron
*/10 * * * * /home/agentuser/bin/repo-redeploy.sh
```

Or, preferred, drop a systemd timer. Skeleton in [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer). The timer is preferable because it inherits the user session's environment cleanly and shows up in `systemctl --user list-timers`.

## Verification

```bash
# Last successful run.
tail -n 20 ~/.openclaw/workspace/logs/repo-redeploy.log

# Force a run and watch the output.
REPO_REDEPLOY_FORCE=1 ~/bin/repo-redeploy.sh

# Confirm one repo is current.
cd ~/repos/my-mcp
git fetch origin main --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && echo "current" || echo "behind"

# Confirm cron is firing on schedule.
journalctl --user -u repo-redeploy.timer --since "1 hour ago" 2>/dev/null \
  || grep "redeploy run start" ~/.openclaw/workspace/logs/repo-redeploy.log | tail
```

A healthy redeploy log looks like: `redeploy run start` ... per-tool log lines (mostly no-ops) ... `redeploy run done`. If you see the same tool re-deploying every ten minutes, the build step is touching git-tracked files and you have a feedback loop. Investigate before silencing.

## Gotchas

**`set -e` and `git fetch` returning non-zero kill the whole script.** Network blips mean `fetch` occasionally fails. Either catch fetch failures explicitly (`git fetch || { log "..."; return; }`), or scope `set -e` so it does not propagate out of per-repo functions. The script above sets `Eeuo pipefail` globally and relies on every `git`/`ssh` call having a paired success/skip path.

**Cron PATH does not include `~/.local/bin` or `~/bin` by default.** Set PATH explicitly at the top of the script. Setting it in `.bashrc` does not help; cron does not source `.bashrc`.

**`pull --ff-only` will refuse to update if a hook pre-commit-modifies files.** A `prettier --write` precommit hook on the redeploy host will make the working tree dirty after the first agent edit, and `pull --ff-only` will fail until you `git stash` or revert. Either disable formatting hooks on the redeploy host, or `git stash --include-untracked && git pull && git stash pop` inside the deploy function.

**`tar` on macOS vs Linux behaves differently for `--exclude`.** If you ever run the script from a macOS host that pushes to a Linux secondary, use BSD-tar-safe excludes (`--exclude='./node_modules'` with the leading `./`). Cross-host redeploys are easier to get right if you keep the redeploy host on Linux.

**The script will happily redeploy a repo with a broken build.** If the new commit on `main` does not build, the local install is now in a half-built state. Two defenses: (1) run a build smoke test in the deploy function and roll back to the previous SHA on failure, or (2) require a passing CI run before any commit lands on `main`. The second is cheaper.

**`scp -q` hides legitimate errors.** When the secondary host's disk fills, the upload silently 0-byte-truncates. Run `ssh secondary-host 'sha256sum /path/_deploy.tar.gz'` after `scp` if you want defense in depth. The local log says "synced" either way.

**Force-redeploying a tool with side-effect installers can break the install.** Some tools (CLIs that copy themselves into `~/bin`) have install scripts that are idempotent only if the target binary is older. If you set `REPO_REDEPLOY_FORCE=1` while the binary is already current, an install script that does `mv` instead of `cp` can leave you without a binary. Use force sparingly and always check `which <tool>` after.

**An npm-distributed tool's `--version` format may change between major versions.** The version-compare logic in `deploy_playwright_cli` above does string equality. A release that emits `1.2.3 (node v20.x)` instead of `1.2.3` will redeploy every ten minutes forever. Pin the version-extraction to the first word: `playwright-cli --version | awk '{print $1}'`.

## Templates

The script itself is a template. Lift it, replace the `deploy_*` functions with your own, and drop the result at `~/bin/repo-redeploy.sh`. Pair with:

- [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) and [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer) for scheduling

## Related

- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - why this lives as a systemd timer, not in `crontab`
- [`mcp-catalog.md`](mcp-catalog.md) - the MCP servers this script actually redeploys
- [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md) - the same idea applied to OpenClaw itself, which has its own dedicated wrapper
