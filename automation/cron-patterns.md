# Cron Patterns

> The three-layer cron stack I actually run: systemd timers for OS plumbing, OpenClaw cron for single-shot agent tasks, n8n schedule triggers for multi-step workflows. Pick the wrong layer and you'll spend 30 minutes a week chasing ghosts.

## What this is

Most stacks accumulate scheduled tasks across three or four layers (crontab, systemd timers, in-app schedulers, n8n, etc.) without anyone deciding which goes where. The result: heartbeat checks running in the wrong layer, LLM jobs timing out because they inherited a 60-second cron timeout, and silent failures because nothing routes errors back.

This is how I split mine. Three layers, each picked for one thing it's good at, with explicit gotchas drawn from real incidents. OpenClaw is my canonical layer-2 orchestrator; if you're on Hermes Agent or another orchestrator, the same three-layer model applies — see "Adapting to other stacks" below.

## Why this way

Three layers, each picked for what it is good at:

| Layer | Good at | Bad at |
|-------|---------|--------|
| **systemd timers** | OS-level tasks (backups, mounts, sync), precise timing, unit dependencies, persistent across reboots | Anything that needs an LLM call, anything that needs to talk to a UI workflow tool |
| **Agent cron** (OpenClaw, Hermes, etc.) | Single-shot agent tasks (research, summarize, post), model-aware scheduling, delivery routing to chat channels | Multi-step workflows with branches, anything that benefits from a visual graph |
| **n8n schedule trigger** | Multi-step workflows (fetch → transform → fan-out), retries with branching, error handlers, idempotent fan-out to many sinks | Pure OS plumbing (overkill), single LLM calls (overkill) |

The wrong layer doesn't just feel awkward — it actively makes the task fragile. A 600-second LLM job in `crontab` will get killed silently. A `restic backup` running through n8n adds five points of failure for one `restic` invocation.

The cost of getting this right once is low; the cost of getting it wrong recurs every week.

### Adapting to other stacks

This guide uses OpenClaw as the canonical agent-cron orchestrator because that's what I run. The three-layer model is orchestrator-agnostic. If you're on a different stack, swap layer 2 and keep the rest:

| You run | Layer-2 swap |
|---------|--------------|
| OpenClaw | `~/.openclaw/cron/jobs.json` (this guide's default) |
| Hermes Agent | Hermes' scheduled-task config — same principles: low-thinking model, explicit delivery, scripts not heredocs |
| Another orchestrator | Whatever cron-config surface it ships with. The three rules in Layer 2 below are general. |
| No agent orchestrator | You don't have a layer 2. Push agent jobs into n8n with HTTP-to-LLM nodes, or skip them. |

Layers 1 and 3 (systemd timers, n8n) are identical regardless.

## Prerequisites

- A Linux host with systemd (any modern distro)
- An agent orchestrator that supports its own cron (this guide assumes [OpenClaw](https://github.com/openclaw/openclaw), but the pattern generalizes)
- An n8n instance for multi-step workflows (any deployment — Docker, native, hosted)
- Comfort with editing systemd unit files and JSON config

## Before / After

**Before:** One `crontab -e` with mixed entries — restic backups, intel feed scrapers, Discord posters, NAS sync. When something fails, you find out three days later because the only signal was a missing post.

**After:** Three layers, each visible in the right place:

- `systemctl --user list-timers` shows OS plumbing
- `~/.openclaw/cron/jobs.json` shows agent jobs
- n8n UI shows multi-step workflows

Failures route to a single error channel via n8n's failure classifier (see [Related](#related)).

## Implementation

### Routing decision tree

```
Is this task at all OS plumbing (backup, sync, mount, log rotation)?
├─ YES → systemd timer. Done.
└─ NO  → does it need exactly one LLM call?
         ├─ YES → OpenClaw cron with a low-thinking model alias.
         └─ NO  → does it have multiple steps, branches, or fan-out?
                  ├─ YES → n8n schedule trigger.
                  └─ NO  → reconsider — this might not need scheduling at all.
```

### Layer 1 — systemd timers (OS plumbing)

Use for: backups, file sync, mount checks, log rotation, anything that should run even if your agent stack is down.

Skeleton lives in [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer) + [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service). Drop both in `~/.config/systemd/user/`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now my-task.timer
```

**Pick `OnCalendar=` over `OnBootSec=` for anything date-relative.** It survives reboots without drift.

**Use `Persistent=true` if you need the missed-run-on-boot behavior.** Otherwise a reboot at 3:01am skips the 3:00am run silently.

### Layer 2 — Agent cron (OpenClaw, Hermes, similar)

Use for: scheduled research, daily summaries, posting to chat channels, any task that's "agent does X, returns text, send it somewhere."

OpenClaw skeleton lives in [`../templates/cron/openclaw-cron-job.json`](../templates/cron/openclaw-cron-job.json). Append entries to `~/.openclaw/cron/jobs.json`. Hermes and other orchestrators have their own cron-config surface — the three rules below are general; the file format isn't.

Three things to get right (orchestrator-agnostic):

1. **Use a low-thinking model alias for cron.** A high-thinking model burns 10–30s per turn just deliberating. Cron jobs are procedural — search, format, post. Define a model alias with `thinking: "low"` and route all cron jobs to it. Reserve high-thinking for interactive sessions.

2. **Always set explicit delivery routing.** A bare `"mode": "announce"` with multiple channels enabled will guess wrong. Set `"to": "<channel-type>:<id>"` explicitly. This applies to any orchestrator that supports multi-channel delivery — the field name varies, the principle doesn't.

3. **For anything multi-step, write a script and call it.** Most orchestrators ship a security gate that flags inline shell composition (heredocs, `&&`-chains, eval). The gate will request human approval, wait, and time out. Put steps in a `.sh` file under your scripts dir and reference it as `bash /path/to/script.sh`.

#### OpenClaw specifics

- Job entries live in `~/.openclaw/cron/jobs.json` as a JSON array. Validate with `jq` before restarting the gateway.
- Define the cron model alias once in `openclaw.json` under `agents.defaults.models`, then reference it as `<provider>/<base-model>:cron` in each job.
- Set `tools.elevated.enabled: true` globally and rely on per-job sandbox shims for restriction. Agent-level overrides for elevated tools have had regressions across minor releases.

#### Hermes notes

If you're running Hermes Agent instead, layer 2 maps to Hermes' scheduled-task config (whatever your version exposes — the API is younger and changes between releases). The three rules above still hold. The OpenClaw-specific gotchas in the Gotchas section that mention `~/.openclaw/cron/jobs.json` won't apply verbatim, but the underlying failure modes (heredoc detection, thinking-budget inheritance, silent delivery routing) are universal — most agent orchestrators land on the same traps.

### Layer 3 — n8n schedule trigger (multi-step workflows)

Use for: fetch + transform + fan-out, anything with conditional branches, anything that needs a real error workflow.

Skeleton at [`../templates/cron/n8n-schedule-trigger.json`](../templates/cron/n8n-schedule-trigger.json). Import via the n8n UI.

**Pin the cron expression in the trigger node**, not the workflow's `triggers` field — the latter doesn't always survive workflow edits.

**Use the `errorWorkflow` setting to route failures.** A failure-classifier workflow can bucket errors (`code-error`, `auth-failed`, `rate-limited`, `transient`) and decide whether to escalate. The classifier itself is a single shared workflow that all production workflows reference.

**Idempotent fan-out is your friend.** If your workflow posts to four sinks, run them in parallel branches with their own retry logic, not in a chain — one slow sink won't block the others.

## Verification

After routing your scheduled tasks, you should be able to enumerate them all in three commands:

```bash
# Layer 1 — systemd timers
systemctl --user list-timers --all

# Layer 2 — OpenClaw cron
jq '.[] | {name, schedule, model}' ~/.openclaw/cron/jobs.json

# Layer 3 — n8n schedule triggers (via the n8n CLI or REST API)
n8n list:workflow --active=true | grep -i schedule
```

If a scheduled task doesn't show up in exactly one of these, it's in the wrong place.

## Gotchas

**Heredoc obfuscation tripped on cron-composed shell commands.** The orchestrator's security gate ran a separate check from the exec-approval gate and tagged `bash <<'EOF'` patterns, sent an approval request to a chat channel, and waited 30 minutes for a human to confirm — then timed out. **Fix:** never compose shell in the cron prompt. Always reference a script file.

**Global high-thinking setting silently killed every cron job.** When the main interactive model was set to a high thinking budget globally, cron jobs inherited it. Multi-turn jobs that searched, formatted, and posted burned 10–30s per turn on deliberation and never finished within the 600s timeout. **Fix:** define a separate model alias with `thinking: "low"` and route all cron jobs to it. Reserve high-thinking for interactive sessions.

**Cron delivery routing without an explicit target picks the wrong channel.** With multiple chat channels enabled, a bare `"mode": "announce"` is a coin flip — it will eventually pick a channel the bot isn't in and silently drop the post. **Fix:** always set `"to": "<channel-type>:<id>"` explicitly.

**`elevated tools` agent-level overrides may not work in cron context.** A regression in one minor release of the orchestrator caused agent-level `tools.elevated.enabled: true` to be ignored when the agent ran from cron. The job would fail silently because `sudo` calls inside its script bounced. **Fix:** set `tools.elevated.enabled: true` globally and rely on per-job sandbox shims to restrict what each cron job can actually do.

**n8n CLI execute does not trigger `errorWorkflow`.** When you run `n8n execute --id <wf-id>` from a script (e.g., for testing), failures do not route to your error workflow. Only auto-runs do. **Fix:** trust the auto-run path for production. For ad-hoc CLI runs, expect to inspect failures manually.

**Orchestrator upgrades regenerate systemd unit files and drop custom directives.** Every upgrade silently rewrites `~/.config/systemd/user/<orchestrator>.service`, dropping `EnvironmentFile=` and other custom directives. The gateway then crash-loops on missing env vars. **Fix:** wrap your update command in a script that re-applies your custom directives after the upgrade and verifies them with `grep` before restarting.

## Templates

- [`templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) — service unit skeleton
- [`templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer) — timer unit skeleton
- [`templates/cron/openclaw-cron-job.json`](../templates/cron/openclaw-cron-job.json) — OpenClaw cron job entry skeleton
- [`templates/cron/n8n-schedule-trigger.json`](../templates/cron/n8n-schedule-trigger.json) — n8n workflow stub with schedule trigger + error workflow reference

## Related

- [openclaw-best-practices: workflows/cron-patterns.md](https://github.com/solomonneas/openclaw-best-practices/blob/main/workflows/cron-patterns.md) — OpenClaw-specific deep dive on heartbeat batching, model aliases, delivery routing
- [`../automation/n8n-patterns.md`](../automation/) (planned) — n8n Code node pitfalls, workflow_history gotcha, failure classifier in detail
- [`../automation/hooks.md`](../automation/) (planned) — pre/post hooks and sandbox shims that limit what cron jobs can do
