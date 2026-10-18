# Repo Redeploy

> One cron job, every ten minutes, watches your own MCP servers and CLI tools for new commits on `main` and quietly redeploys them in place. Push from anywhere, the change is live within ten minutes.

**Tested on:** Ubuntu 24.04, bash 5, Python 3.12, Node 22 or newer, Brigade 0.28.0
**Last updated:** 2026-10-17

## What this is

A single bash script (`~/bin/repo-redeploy.sh`) driven by a TOML manifest. For each enabled entry it decides whether the installed build is behind its repo, rebuilds or reinstalls if so, and optionally mirrors the result to a second host. The first version had a hard-coded function per repo. It now reads a manifest with 28 entries (20 Node MCP servers and CLIs, 4 Python tools installed with pipx, 2 Rust crates, 1 global npm package, 1 shell installer), so adding a tool is a manifest edit, not a code change.

A tool is redeployed when any of these is true:

1. Its tracked branch is behind its upstream (the script pulls first).
2. Its built artifact is older than the repo's last commit (a stale build).
3. The installed version differs from the repo version (pipx, cargo, and npm drift).
4. `REPO_REDEPLOY_FORCE=1` is set.

When none of them is true, the run logs `current` for that tool and moves on. That is what makes it safe from cron on a tight interval.

This is the deployment surface for the parts of the stack I publish to GitHub and npm. The agent stack itself does not get touched here. See [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md) for how OpenClaw itself is promoted.

## Why this way

Your own published tools sit on the boundary between "source code in a GitHub repo" and "binary the agent shells out to." That boundary is a constant source of drift:

| Drift case | What happens without redeploy | What happens with redeploy |
|------------|-------------------------------|----------------------------|
| You push a fix to your own MCP server's repo | Local `~/repos/<mcp>` is now behind GitHub. The agent uses the old binary. You forget for two days. | Within 10 minutes, `~/repos/<mcp>` is pulled and rebuilt. Next session sees the fix. |
| You merge a PR from another machine or a worker | The checkout moved but `dist/` did not | The stale-build check sees an artifact older than the last commit and rebuilds |
| A Python or Rust tool was installed from a checkout | The installed version silently lags the repo | Version drift between the installed binary and the repo version triggers a reinstall |
| A second machine consumes the same binary | You forget to sync after every release | The script tarballs the build and pushes it to the second host as part of the same run |
| The tool is an npm-distributed package | You manually `npm install -g` after every release | The script polls npm, compares versions, bumps when behind |
| You force a redeploy (testing a local edit) | You manually run all the build steps | `REPO_REDEPLOY_FORCE=1 ~/bin/repo-redeploy.sh` does it for you |

The alternative deployment topologies all cost more:

- **Per-repo GitHub Actions deploying via SSH.** You manage secrets in CI, the cold-start latency is minutes, and every repo has a copy of the deploy logic.
- **A real CI/CD pipeline.** Overkill for one-author tools and an audience of one control host. CI still gates what lands on `main`, and the redeploy script only consumes what already passed it.
- **Manual `git pull && npm run build` after every push.** Works until you forget.

A single bash script that any half-decent engineer can read in an afternoon wins. Mine is a little over 300 lines, most of it the per-kind redeploy functions and the mirror helpers.

## Prerequisites

- A directory like `~/repos/` where each tool is a sibling git checkout
- `git`, `python3` (3.11 or newer, for `tomllib`), `flock`, `npm`, and `jq` on the agent host, plus `pipx` and `cargo` if the manifest has those kinds
- SSH access from the agent host to any secondary host that consumes binaries (key-only auth and no passphrase prompts in cron context)
- A cron facility. I use the user crontab for this job. [`../automation/cron-patterns.md`](../automation/cron-patterns.md) covers how the scheduling layers split

## Before / After

**Before:** every push to your own MCP or CLI repo is followed by a hand-rolled "ssh, pull, install, restart" dance. Half the time you forget the secondary host. The agent uses last week's binary for a day before someone notices.

**After:** push to GitHub. Walk away. Ten minutes later, the agent host has the new binary, and any secondary host that consumes it does too. The redeploy log says exactly what happened.

## Implementation

### The manifest

The manifest is a TOML file with one `[[tool]]` table per entry, kept under the workspace config directory. A made-up example with three entries, one per common kind:

```toml
# Fields you can omit take the default shown in the comment.
#   enabled      = true
#   branch       = <the repo's current branch>
#   build_dir    = "."           (subdirectory to build in)
#   artifact     = package.json "main", else "dist"   (node only)
#   build        = "npm install --no-audit --no-fund --silent && npm run build"
#   bin          = <id>          (binary name for version checks)
#   repo_version = read from pyproject.toml or Cargo.toml
#   restart      = "none"        (or "gateway", or "systemctl --user restart <unit>")
#   mirror_fn    = ""            (name of a mirror function in the script)
# `repo` must be an absolute path. TOML does not expand `~` or `$HOME`.

[[tool]]
id = "jellyfin-mcp"
kind = "node"
repo = "/path/to/repos/jellyfin-mcp"
artifact = "dist/index.js"

[[tool]]
id = "brigade-cli"
kind = "pipx"
repo = "/path/to/repos/brigade"
bin = "brigade"

[[tool]]
id = "playwright-cli"
kind = "npm-global"
pkg = "@playwright/cli"
bin = "playwright-cli"
```

The field that names a mirror function is called `mirror_fn` above. In my copy it carries the secondary host's name, so call yours whatever your parser reads.

The `kind` field selects the redeploy function: `node`, `cargo`, `pipx`, `npm-global`, or `shell-install`. A small embedded Python snippet parses the file with `tomllib` and hands the fields to bash one row at a time. A `node` entry builds with the default command unless you set `build`. A `shell-install` entry runs whatever `install` command you give it from inside the repo.

### State file and detection

A JSON state file next to the manifest records the last deployed SHA per tool. It exists because "current" has three different meanings:

- **Stale build.** For a `node` tool the script compares the newest file mtime under the artifact against the last commit time. A checkout that moved without a rebuild is caught here, even when git says nothing is behind.
- **Version drift.** For `pipx` and `cargo` tools it compares the installed version (from `pipx list` or `<bin> --version`) against the version in `pyproject.toml` or `Cargo.toml`.
- **SHA changed.** If the SHA differs from the recorded one, something moved since the last successful deploy, so rebuild.

The state is only written after a successful build, so a failed build is retried on the next tick instead of being marked deployed.

### Branch-aware pulls

The script uses each repo's current branch, not a hard-coded `main`. If the branch has an upstream and is behind, it fetches and runs `git pull --ff-only`. If the branch has no upstream (a local-only fix branch), it logs that and builds from local `HEAD`. This lets me run a fix branch on the agent host before it merges, and the redeploy keeps rebuilding from it instead of fighting it. The `--ff-only` flag still refuses to overwrite a divergent branch.

### Locking

A single-instance lock keeps a cron tick from overlapping a long or manual run:

```bash
LOCK="$(dirname "$STATE")/.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] another redeploy run in progress, exiting"
  exit 0
fi
```

A second invocation exits cleanly with that log line instead of racing the first for `node_modules`.

### Run controls

Three environment variables change one run without touching the manifest:

| Variable | Effect |
|----------|--------|
| `REPO_REDEPLOY_FORCE=1` | Redeploy every enabled tool regardless of state |
| `REPO_REDEPLOY_DRYRUN=1` | Log what would happen and change nothing. State is not written |
| `REPO_REDEPLOY_ONLY=<id>` | Act on one manifest entry only. It runs even if that entry is disabled |

`REPO_REDEPLOY_DRYRUN=1 REPO_REDEPLOY_ONLY=jellyfin-mcp ~/bin/repo-redeploy.sh` is the safe way to see why a tool keeps redeploying.

### Queued restarts

A tool can name a `restart` command, for example the gateway restart for an MCP the gateway has loaded. The script does not restart in the middle of the loop. It queues the command, deduplicates it, and runs each unique restart once after every tool has been processed, so five tool updates in one tick cost one restart, not five.

### Mirroring to a second host

When a tool also has to run on another machine, the manifest names a mirror function. Each function tarballs the build, copies it over SSH, and runs the install step there. The gate is the same for all of them:

```bash
secondary_up() { ssh -o ConnectTimeout=5 -o BatchMode=yes secondary-host 'echo ok' >/dev/null 2>&1; }

mirror_example() {
    local repo="$1" tb="/tmp/example-deploy.$$.tar.gz"
    secondary_up || { log "  secondary unreachable, skip mirror"; return; }
    tar --exclude=node_modules --exclude=.git -czf "$tb" -C "$repo" .
    scp -q "$tb" secondary-host:/path/on/secondary/example/_deploy.tar.gz && rm -f "$tb"
    ssh secondary-host 'cd /path/on/secondary/example && tar -xzf _deploy.tar.gz \
        && rm _deploy.tar.gz && npm install --omit=dev --no-audit --no-fund --silent' >/dev/null \
        && log "  mirrored to secondary" || log "  mirror failed (non-fatal)"
}
```

Key choices:

- **`BatchMode=yes`** ensures cron-context SSH never hangs waiting for a password.
- **A reachability probe first.** An offline secondary host is a skipped step with a log line, not a failed run.
- **Tarball over a directory `rsync`** is faster for small repos and avoids `rsync`'s `--exclude` quoting traps.
- **`--omit=dev` on the remote install** keeps the production tree slim. The dev dependencies were only needed to build.
- **A failed mirror is non-fatal, and it is not retried automatically.** The local build is already marked deployed, so the next tick sees `current`. Resync with `REPO_REDEPLOY_FORCE=1 REPO_REDEPLOY_ONLY=<id>`.

### Scheduling

The job runs from the user crontab every ten minutes:

```cron
*/10 * * * * $HOME/bin/repo-redeploy.sh
```

I considered a systemd timer and kept the crontab line. The script sets its own `PATH` at the top, owns its log file, and holds its own lock, so it does not need anything from the unit environment.

## Verification

```bash
# Last successful run. A healthy log has a start line, one line per tool, and a done line.
grep -E "redeploy run (start|done)" ~/.openclaw/workspace/logs/repo-redeploy.log | tail -4

# Dry run for one tool: shows the decision and the command, changes nothing.
REPO_REDEPLOY_DRYRUN=1 REPO_REDEPLOY_ONLY=jellyfin-mcp ~/bin/repo-redeploy.sh
tail -n 5 ~/.openclaw/workspace/logs/repo-redeploy.log

# Force a real run of one tool and watch the output.
REPO_REDEPLOY_FORCE=1 REPO_REDEPLOY_ONLY=jellyfin-mcp ~/bin/repo-redeploy.sh

# Confirm the cron line is installed.
crontab -l | grep repo-redeploy

# Confirm the manifest parses and count the entries.
python3 -c 'import tomllib,sys; print(len(tomllib.load(open(sys.argv[1],"rb"))["tool"]))' \
  ~/.openclaw/workspace/.config/repo-redeploy/manifest.toml

# Confirm one repo is current.
cd ~/repos/jellyfin-mcp
git fetch --quiet && [ "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" ] && echo "current" || echo "behind"
```

A healthy run logs `current (<sha>)` for almost every tool. If the same tool redeploys on every tick, the build step is touching tracked files, or the artifact path in the manifest points at something the build never writes, so the stale-build check never clears. Investigate with a dry run before silencing it.

## Gotchas

**A second run prints "another redeploy run in progress" and exits 0.** That is the lock working. It is not an error. If you see it on every tick, a previous run is hung, usually on a build or an SSH call. Find it with `pgrep -af repo-redeploy`.

**The script does not use `set -e` on purpose.** It sets `-u` and `pipefail` only. A single network blip on `git fetch` or an offline mirror host must not abort the other 27 tools, so every step has its own success or skip path and failures are logged with the tool id. The first, hard-coded version used `set -Eeuo pipefail`, and a failed fetch there was a whole-run failure.

**Cron PATH does not include `~/.local/bin`, `~/bin`, or `~/.cargo/bin` by default.** The script exports its own `PATH` at the top. Setting it in `.bashrc` does not help, because cron does not source `.bashrc`.

**`pull --ff-only` refuses to update if the working tree is dirty or diverged.** A formatting hook that rewrites files, or an un-pushed local commit on the tracked branch, will make the pull fail and the tool will keep building from the old HEAD. The log shows the pull failure. Fix the checkout, since the script never stashes or resets for you.

**A failed build is not marked deployed.** The log says `BUILD FAILED (not marking deployed)` and the next tick retries. Good for recovering from a transient error, noisy for a broken commit. The cheaper defense is requiring a passing CI run before anything lands on `main`, so the script only ever consumes a green head.

**The script will happily redeploy a repo that builds but does not work.** There is no post-build smoke test. If it matters, add one to that entry's `build` command so a failing smoke test fails the build.

**Restarts run once at the end, and a failed restart is only logged.** A queued gateway restart that fails leaves the old process serving the old build while the log shows the new SHA. After a run that updated anything the gateway loads, check the service, not just the log.

**The stale-build check compares file mtimes.** A `git checkout` of an older branch sets mtimes to now, which can make an old artifact look newer than the last commit and hide a needed rebuild. A forced run for that one entry clears it.

**`REPO_REDEPLOY_FORCE=1` reinstalls everything enabled.** Combine it with `REPO_REDEPLOY_ONLY` unless you mean it. Some install scripts that copy a binary into `~/bin` are only safe to rerun when the target is older. Check `which <tool>` afterward.

**`scp -q` hides legitimate errors.** When the secondary host's disk fills, the upload can 0-byte-truncate and the log still says "mirrored." Run `ssh secondary-host 'sha256sum /path/_deploy.tar.gz'` after the copy if you want defense in depth.

**An npm tool's `--version` output can change format.** The `npm-global` kind compares the installed version string to the registry version by equality. A release that prints `1.2.3 (node v22.x)` instead of `1.2.3` will bump on every tick. Make the tool print only the version, or compare on the first word.

**`tar --exclude` behaves differently on BSD tar.** If the script ever runs from a macOS host pushing to Linux, use `./`-prefixed excludes. Cross-host redeploys are easier to get right if the redeploy host stays on Linux.

## Templates

The script itself is not in this repo. This guide documents the design, and you write your own from the pieces shown above: the TOML manifest with one `[[tool]]` entry per tool, the lock that stops overlapping runs, the per-tool state that records the last deployed commit, and the stale-build check that compares artifact mtime to commit time. Start with one `git` kind and one `node` kind, add the other kinds when you need them, and keep the script at a path like `~/bin/repo-redeploy.sh`. For a systemd-timer variant of the schedule, see:

- [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) and [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer)

## Related

- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - the scheduling layers and what each one is for
- [`mcp-catalog.md`](mcp-catalog.md) - the MCP servers this script actually redeploys
- [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md) - the same idea applied to OpenClaw itself, which is promoted from release worktrees instead
