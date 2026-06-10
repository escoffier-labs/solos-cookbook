# OpenClaw Host Topology

> A production agent host is not just one daemon. It is config, channels, cron, memory, browser automation, plugins, health checks, and the boring glue that keeps all of it observable.

## What this is

This guide audits the live shape of a single-user OpenClaw host without publishing private machine details. It gives you the map: where the config lives, which services matter, how agents and plugins hang together, what cron owns, and what health checks catch drift.

Use it when you need to recreate the stack, onboard another agent, or decide which missing cookbook guide should be written next.

## Why this way

The tempting documentation style is a static architecture diagram. That goes stale immediately. The durable version is a topology guide backed by commands that show the current state on the host.

| Layer | Source of truth | Why it matters |
|-------|-----------------|----------------|
| Host services | `systemctl --user` | Shows what actually starts, fails, and restarts |
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

- `openclaw-gateway.service` active
- browser automation display services active when browser tools are enabled
- backup and verification timers loaded
- preflight and plugin smoke timers loaded
- failed units investigated, not ignored

If a preflight or smoke service fails, treat that as an operational-health incident. It may be warning you about a missing binary, stale plugin manifest, broken auth profile, or post-upgrade drift.

### 3. Read the OpenClaw config by surface

Do not paste raw config into public docs. Use `jq` to summarize and redact:

```bash
jq '{
  topLevel: keys,
  agents: .agents.list[]? | {id, name, model, workspace},
  enabledPlugins: (.plugins.entries | to_entries[] | select((.value.enabled // false)==true) | .key),
  channels: (.channels | keys)
}' ~/.openclaw/openclaw.json
```

The key surfaces to document:

- main agent and worker agents
- model aliases and fallback order
- ACP escalation agents
- plugin allowlist and enabled entries
- channel policies
- memory search and compaction settings
- sandbox posture

### 4. Keep agents and workspaces separate

A production setup should make clear which agent owns which workspace:

```bash
jq -r '.agents.list[]? | [.id, .model, (.workspace // "default")] | @tsv' \
  ~/.openclaw/openclaw.json
```

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

If browser tools are enabled, document the display services, profile policy, and concurrency controls:

```bash
systemctl --user list-units 'xvfb*' --all --no-pager
find ~/.openclaw/browser -maxdepth 2 -type f -printf '%P\n' | sort | head
```

Browser automation needs a dedicated guide because it touches auth state, profile locking, screenshots, VNC/noVNC, and outbound publishing.

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
jq '.agents.list | length' ~/.openclaw/openclaw.json
jq '.plugins.entries | keys' ~/.openclaw/openclaw.json
openclaw cron list --json | jq .total
find ~/.openclaw/workspace -maxdepth 1 -type f -name '*.md' -printf '%f\n' | sort
```

Check for public-doc leakage before copying results:

```bash
rg -n '([0-9]{1,3}\.){3}[0-9]{1,3}|localhost:[0-9]+|token|secret|password|channel:[0-9]+' .
```

## Gotchas

**A failed preflight can hide under a healthy gateway.** The gateway may still answer messages while a smoke test is telling you a plugin or external binary is broken.

**Upgrade drift shows up in side files first.** Systemd units, plugin manifests, generated config health files, and env files can drift before the main config looks suspicious.

**Channel IDs and account identifiers are documentation hazards.** They are useful locally and unnecessary publicly. Replace them with placeholders before committing.

**Browser automation is stateful.** Profiles, display numbers, locks, and cookies are operational state. Treat them like infrastructure, not disposable test data.

**Cron job count is not health.** A host can have many enabled jobs and still be poorly observable. Health comes from delivery routing, failure classification, and review habits.

## Templates

- [`../templates/ai-stack/`](../templates/ai-stack/) - model aliases and ACP wrapper fragments
- [`../templates/bootstrap/`](../templates/bootstrap/) - workspace bootstrap file skeletons
- [`../templates/sandbox/`](../templates/sandbox/) - wrappers for restricted worker lanes

## Related

- [`upgrade-hygiene.md`](upgrade-hygiene.md) - surviving OpenClaw upgrades and regenerated files
- [`backup-recovery.md`](backup-recovery.md) - backing up workspace and config state
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - deciding which scheduler owns a task
- [`../automation/hooks.md`](../automation/hooks.md) - hook layers for policy enforcement
