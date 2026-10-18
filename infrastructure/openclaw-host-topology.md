# OpenClaw Host Topology

**Tested on:** OpenClaw 2026.10.4 (promoted from a release worktree), Ubuntu 24.04, systemd user services
**Last updated:** 2026-10-17

> A production agent host is not just one daemon. It is config, channels, cron, memory, browser automation, plugins, health checks, and the boring glue that keeps all of it observable.

## What this is

This guide audits the live shape of a single-user OpenClaw host without publishing private machine details. It gives you the map: where the config lives, which services matter, how agents and plugins hang together, what cron owns, and what health checks catch drift.

Use it when you need to recreate the stack, onboard another agent, or decide which missing cookbook guide should be written next.

## Why this way

The tempting documentation style is a static architecture diagram. That goes stale immediately. The durable version is a topology guide backed by commands that show the current state on the host.

| Layer | Source of truth | Why it matters |
|-------|-----------------|----------------|
| Host services | `systemctl --user` | Shows what actually starts, fails, and restarts, including the browser lanes |
| Running build | `~/worktrees/openclaw-<tag>/` plus the gateway drop-in | Which release is actually serving traffic (see [release worktrees](#release-worktrees-and-promotion)) |
| OpenClaw config | `~/.openclaw/openclaw.json` | Agents, models, plugins, memory, channels |
| Workspace files | `~/.openclaw/workspace/` | Bootstrap prompt, memory, tools, rules |
| Agent sessions | `~/.openclaw/agents/*/sessions/` | Ground truth for what happened |
| Cron jobs | `openclaw cron` CLI (gateway-owned store) | Scheduled agent work and delivery routing |
| Templates | cookbook `templates/` | Public-safe artifacts other people can lift |

## Prerequisites

- Linux host running OpenClaw as a user service
- `jq`, `rg`, and `systemctl --user`
- OpenClaw workspace at `~/.openclaw/workspace`
- A content scrubber before copying command output into public docs

## Before / After

**Before:** the stack is understandable only by scrolling through config files and remembering why each plugin exists. Failed smoke checks sit in systemd output with no clear owner.

**After:** each subsystem has a discovery command, a doc home, a template target, and a health signal. The cookbook backlog follows the live system instead of a wish list.

## Implementation

### 1. Identify the host envelope

Use host facts to document the platform without publishing private identifiers:

```bash
hostnamectl
id
uname -a
```

Public docs should reduce this to the reusable facts: Linux distribution, kernel family, desktop or server class, and whether the user owns the OpenClaw service.

### 2. Inventory user services

The OpenClaw host usually has more than the gateway:

```bash
systemctl --user list-units --type=service --type=timer --all --no-pager \
  | rg -i 'openclaw|agent|cron|restic|backup|xvfb|browser|memory'
```

Healthy patterns:

- `openclaw-gateway.service` active, and its `ExecStart` pointing at a release worktree
- one `browser-<lane>.service` per named browser lane, each backed by an `xvfb` display unit, when browser tools are enabled
- backup and verification timers loaded
- preflight and plugin smoke timers loaded
- failed units investigated, not ignored

If a preflight or smoke service fails, treat that as an operational-health incident. It may be warning you about a missing binary, stale plugin manifest, broken auth profile, or post-upgrade drift.

#### Release worktrees and promotion

The gateway does not run from a source checkout or a global npm install. Each release lives in its own git worktree, and a small systemd drop-in points the unit at one of them:

```text
~/openclaw/                       git source, only used to fetch tags (not the running code)
~/worktrees/openclaw-v2026.10.4/  the build the gateway runs (dist/index.js)
~/worktrees/openclaw-v2026.10.1/  older builds, kept for rollback
~/.config/systemd/user/openclaw-gateway.service.d/
    beta-exec.conf                ExecStart= (cleared) then node <worktree>/dist/index.js gateway --port <port>
    version.conf                  unit description and OPENCLAW_SERVICE_VERSION label
~/bin/openclaw                    symlink to the active worktree's openclaw.mjs
~/.local/state/openclaw-node      absolute Node path the promoted build was built with
```

A promote script moves the gateway between worktrees: it rehearses the candidate against a copy of state, snapshots state, migrates config, rewrites the drop-in, and waits for a healthy gateway, rolling back automatically on failure. The full flow, the rollback path, and the system-wide `openclaw` wrapper are in [`upgrade-hygiene.md`](upgrade-hygiene.md). Two commands tell you the current layout without reading any file:

```bash
systemctl --user show openclaw-gateway -p ExecStart --value | grep -oE '[^ ]+/dist/index\.js'
readlink ~/bin/openclaw
```

If those two paths name different worktrees, the CLI and the gateway disagree about the version, and that is the first thing to fix after a promotion.

### 3. Read the OpenClaw config by surface

Do not paste raw config into public docs. Use `jq` to summarize and redact:

```bash
jq '{
  topLevel: keys,
  agentSections: (.agents | keys),
  agentEntries: (.agents.entries | keys),
  enabledPlugins: [.plugins.entries | to_entries[] | select((.value.enabled // false)==true) | .key],
  channels: (.channels | keys)
}' ~/.openclaw/openclaw.json
```

The key surfaces to document:

- the main agent and any agent-specific entries (current releases keep these under `agents.entries`, with `agents.defaults` for shared settings and `agents.ownership` for who owns what, rather than an `agents.list` array)
- model aliases and fallback order
- ACP escalation agents
- plugin allowlist and enabled entries
- channel policies
- memory search and compaction settings
- sandbox posture

### 4. Keep agents and workspaces separate

A production setup should make clear which agent owns which workspace:

```bash
jq -r '.agents.entries | to_entries[] | [.key, ((.value.model.primary? // .value.model // "default") | tostring), (.value.workspace // "default")] | @tsv' \
  ~/.openclaw/openclaw.json
```

The agent config shape has changed between releases. If a query returns nothing, run `jq '.agents | keys'` first and adapt, instead of assuming the older `agents.list` layout.

Use separate workspaces when an agent has a distinct job, such as code building, escalation, or local model operations. Shared workspaces are convenient, but they increase accidental coupling.

### 5. Document plugins by job, not by package list

Group enabled plugins by purpose:

- channels: chat and delivery surfaces
- providers: model and search backends
- memory: cards, wiki, active recall, dreaming
- safety: scrubbers, narration guards, diagnostics
- automation: n8n, webhooks, browser
- escalation: ACP bridge to external agents

Then link each group to the guide or template that explains it. If no guide exists, that is cookbook backlog.

### 6. Inventory cron as production workload

OpenClaw cron is real production work, not a toy reminders list.

```bash
openclaw cron list --json | \
  jq '{count: .total, jobs: [.jobs[] | {name, enabled, schedule, delivery}]}'
```

Classify jobs:

- personal reminders
- daily summaries and standups
- backups and maintenance
- memory sweeps and handoff ingest
- content and publishing work
- intel feeds
- repo health and security checks

Every recurring job should have a delivery route, a failure signal, and a guide or note explaining why it belongs in OpenClaw cron instead of systemd or n8n.

### 7. Treat browser automation as infrastructure

If browser tools are enabled, document the lanes, the display services, the profile policy, and the concurrency controls. On this host each browser lane is a **named systemd user service**, not a process an agent launches on demand:

- `browser-<lane>.service` runs one Chromium with its own persistent profile, a loopback-only remote-debugging port, and a noVNC port for human login and inspection.
- Each lane `Requires=` an Xvfb display unit (`xvfb.service` or a templated `xvfb@<display>.service`), so a lane never races its display.
- A supervisor script owns the Chromium process, and the unit uses `Restart=always` with `ExecStartPost` polling `/json/version` until the debugging port answers, so a lane that does not come up fails the unit instead of looking healthy.
- A `.path` unit watches the user unit directory and regenerates a small lane-index page when a lane is added or changed.
- A nightly timer recycles the one lane whose CDP sockets go stale.

Lanes are split by purpose (social publishing, research, coding agents, and a recovery lane for sessions that need re-login). One profile per purpose keeps a login for one workflow from leaking into another and lets you restart a lane without disturbing the rest. How to build and attach to a lane is covered in [`../ai-stack/browser-llm-stack.md`](../ai-stack/browser-llm-stack.md#8-run-each-lane-as-a-named-service).

```bash
systemctl --user list-units 'browser-*' 'xvfb*' --all --no-pager
for port in 9223 9224; do curl -fsS "http://127.0.0.1:$port/json/version" | jq -r .Browser; done
find ~/.openclaw/browser -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort
```

Browser automation needs this much care because it touches auth state, profile locking, screenshots, VNC/noVNC, and outbound publishing.

### 8. Keep health checks close to systemd

Use user services and timers for cheap drift detection:

- dependency preflight
- plugin smoke tests
- backup freshness
- restic integrity verify
- daily memory-file creation
- gateway version and config health

Those checks should fail loudly. A green gateway with broken plugins is still a broken host.

## Verification

Run this audit set:

```bash
systemctl --user is-active openclaw-gateway.service
systemctl --user --failed --no-pager
jq '.agents.entries | keys' ~/.openclaw/openclaw.json
systemctl --user show openclaw-gateway -p ExecStart --value | grep -oE '[^ ]+/dist/index\.js'
systemctl --user list-units 'browser-*' --no-pager --no-legend
jq '.plugins.entries | keys' ~/.openclaw/openclaw.json
openclaw cron list --json | jq .total
find ~/.openclaw/workspace -maxdepth 1 -type f -name '*.md' -printf '%f\n' | sort
```

Expected: the gateway is `active`, `--failed` lists nothing you do not already know about, the `ExecStart` path ends in a `worktrees/openclaw-<tag>/dist/index.js` for the tag you promoted, and each browser lane unit is `loaded active`. A failed daily plugin smoke unit is a real finding, not noise.

Check for public-doc leakage before copying results:

```bash
rg -n '([0-9]{1,3}\.){3}[0-9]{1,3}|localhost:[0-9]+|token|secret|password|channel:[0-9]+' .
```

## Gotchas

**A failed preflight can hide under a healthy gateway.** The gateway may still answer messages while a smoke test is telling you a plugin or external binary is broken.

**Upgrade drift shows up in side files first.** Systemd units, plugin manifests, generated config health files, and env files can drift before the main config looks suspicious. Promoting from a worktree removes most of it, because the old build is untouched and the drop-in is the only thing that changes.

**The source clone is not the running code.** Running the git source directly (a dev run) can recreate state files that a newer doctor refuses to migrate. Treat `~/worktrees/openclaw-<tag>` as the build and the clone as a tag source only.

**A lane that is `active` is not a lane that is logged in.** The unit proves Chromium is up. It does not prove the profile still has a valid session. Probe the debugging port, and expect to re-login through noVNC when a provider expires the session.

**Channel IDs and account identifiers are documentation hazards.** They are useful locally and unnecessary publicly. Replace them with placeholders before committing.

**Browser automation is stateful.** Profiles, display numbers, locks, and cookies are operational state. Treat them like infrastructure, not disposable test data.

**Cron job count is not health.** A host can have many enabled jobs and still be poorly observable. Health comes from delivery routing, failure classification, and review habits.

## Templates

- [`../templates/ai-stack/`](../templates/ai-stack/) - model aliases and ACP wrapper fragments
- [`../templates/bootstrap/`](../templates/bootstrap/) - workspace bootstrap file skeletons
- [`../templates/sandbox/`](../templates/sandbox/) - wrappers for restricted worker lanes

## Related

- [`upgrade-hygiene.md`](upgrade-hygiene.md) - release worktrees, the promote script, and rollback
- [`../ai-stack/browser-llm-stack.md`](../ai-stack/browser-llm-stack.md) - building and attaching to the named browser lanes
- [`backup-recovery.md`](backup-recovery.md) - backing up workspace and config state
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - deciding which scheduler owns a task
- [`../automation/hooks.md`](../automation/hooks.md) - hook layers for policy enforcement
