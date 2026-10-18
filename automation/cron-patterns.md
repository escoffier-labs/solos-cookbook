# Cron Patterns

> The scheduling stack I actually run: systemd timers for OS plumbing, crontab lines that fire reviewed Brigade runbooks, OpenClaw cron for agent tasks, and a small n8n for watchdogs. Pick the wrong layer and you'll spend 30 minutes a week chasing ghosts.

**Tested on:** OpenClaw 2026.10.4, Brigade 0.28.0, Ubuntu 24.04, n8n 2.x (small instance)
**Last updated:** 2026-10-17

## What this is

Most stacks accumulate scheduled tasks across three or four layers (crontab, systemd timers, in-app schedulers, n8n, etc.) without anyone deciding which goes where. The result: heartbeat checks running in the wrong layer, LLM jobs timing out because they inherited a 60-second cron timeout, and silent failures because nothing routes errors back.

This is how I split mine. Four layers, each picked for one thing it's good at, with explicit gotchas drawn from real incidents. OpenClaw is my canonical agent-cron orchestrator. If you're on Hermes Agent or another orchestrator, the same model applies, see "Adapting to other stacks" below.

What is running today (counted 2026-10-17):

| Layer | Count | What lives there |
|-------|-------|------------------|
| systemd user timers | 61 | Backups, freshness checks, watchdogs, syncs, nightly gateway restart, dependency and plugin smoke checks |
| crontab | 21 active lines | 11 call `brigade runbook run --approved <runbook>.json`. The rest are small scripts and file syncs |
| OpenClaw gateway cron | 36 jobs | 21 agent turns and 15 `command` payloads (several of the commands also run runbooks) |
| n8n schedule triggers | 11 across 14 workflows | Watchdogs and digests that post to chat |

## Why this way

Four layers, each picked for what it is good at:

| Layer | Good at | Bad at |
|-------|---------|--------|
| **systemd timers** | OS-level tasks (backups, mounts, sync), precise timing, unit dependencies, `Persistent=true` catch-up after a reboot | Anything that needs an LLM call, anything that needs to talk to a UI workflow tool |
| **crontab + Brigade runbooks** | A reviewed multi-step job with a receipt: the runbook JSON is approved (and optionally pinned), so the crontab line stays one short call | Per-job model choice, delivery routing, anything conversational |
| **Agent cron** (OpenClaw, Hermes, etc.) | Agent tasks (research, summarize, post), per-job model and thinking level, delivery routing to chat channels, `command` payloads run by the gateway | Multi-step workflows with branches, anything that benefits from a visual graph |
| **n8n schedule trigger** | Watchdogs and digests that fan out to several sinks, retries with branching, error handlers | Pure OS plumbing (overkill), single LLM calls (overkill) |

The wrong layer doesn't just feel awkward, it actively makes the task fragile. A 600-second LLM job in `crontab` will get killed silently. A `restic backup` running through n8n adds five points of failure for one `restic` invocation.

The cost of getting this right once is low. The cost of getting it wrong recurs every week.

### Adapting to other stacks

This guide uses OpenClaw as the canonical agent-cron orchestrator because that's what I run. The layering is orchestrator-agnostic. If you're on a different stack, swap the agent-cron layer and keep the rest:

| You run | Agent-cron swap |
|---------|-----------------|
| OpenClaw | `openclaw cron` CLI, gateway-owned store (this guide's default) |
| Hermes Agent | Hermes' scheduled-task config: same principles (low thinking, explicit delivery, scripts not heredocs) |
| Another orchestrator | Whatever cron-config surface it ships with. The three rules in the agent-cron layer below are general. |
| No agent orchestrator | You don't have an agent-cron layer. Push agent jobs into n8n with HTTP-to-LLM nodes, or skip them. |

The systemd, crontab, and n8n layers are identical regardless. Brigade runbooks are optional: a plain script in a crontab line works, you just lose the approval gate and the receipt.

## Prerequisites

- A Linux host with systemd (any modern distro)
- An agent orchestrator that supports its own cron (this guide assumes [OpenClaw](https://github.com/openclaw/openclaw), but the pattern generalizes)
- Optional: [Brigade](https://github.com/escoffier-labs/brigade) for `brigade runbook run`
- An n8n instance for multi-step workflows (any deployment: Docker, native, hosted)
- Comfort with editing systemd unit files and JSON config

## Before / After

**Before:** One `crontab -e` with mixed entries: restic backups, intel feed scrapers, Discord posters, NAS sync. When something fails, you find out three days later because the only signal was a missing post.

**After:** Four layers, each visible in the right place:

- `systemctl --user list-timers` shows OS plumbing
- `crontab -l` shows the runbook one-liners
- `openclaw cron list` shows agent jobs
- n8n UI shows multi-step workflows

Failures route to a single error channel via n8n's failure classifier (see [Related](#related)).

## Implementation

### Routing decision tree

```
Is this task at all OS plumbing (backup, sync, mount, log rotation)?
├─ YES → does it need a receipt or several ordered steps?
│        ├─ YES → Brigade runbook, fired by a systemd timer or a crontab line.
│        └─ NO  → systemd timer. Done.
└─ NO  → does it need an agent turn (research, summarize, judgment)?
         ├─ YES → OpenClaw cron with a pinned model and low thinking.
         └─ NO  → does it have multiple steps, branches, or fan-out to chat sinks?
                  ├─ YES → n8n schedule trigger.
                  └─ NO  → OpenClaw cron `command` payload, or reconsider whether it needs scheduling at all.
```

### Layer 1: systemd timers (OS plumbing)

Use for: backups, file sync, mount checks, log rotation, freshness checks, anything that should run even if your agent stack is down.

Skeleton lives in [`../templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer) + [`../templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service). Drop both in `~/.config/systemd/user/`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now my-task.timer
```

**Pick `OnCalendar=` over `OnBootSec=` for anything date-relative.** It survives reboots without drift.

**Use `Persistent=true` if you need the missed-run-on-boot behavior.** Otherwise a reboot at 3:01am skips the 3:00am run silently.

**Add `RandomizedDelaySec=` once you have dozens of timers.** Sixty timers that all say `:00` pile up on the same minute. A 60-second random delay costs a freshness check nothing. My restic freshness timer is `OnCalendar=*-*-* 09:00:00`, `Persistent=true`, `RandomizedDelaySec=60s`.

### Layer 1b: crontab lines that call Brigade runbooks

Most of my crontab is one pattern:

```cron
15 3 * * * ~/.local/bin/brigade runbook run --target ~/workspace --approved ~/workspace/.brigade/runbooks/nightly-backup.json >> ~/workspace/logs/nightly-backup.log 2>&1
```

`brigade runbook run` executes a reviewed runbook JSON and writes a receipt. From `brigade runbook --help` and `brigade runbook run --help` (Brigade 0.28.0):

- `--approved` is the explicit approval for this execution.
- `--dry-run` validates the runbook and shows its steps without running them.
- `--resume <run-id>` retries from the first failed step of a previous run.
- `brigade runbook plan <file>` inspects a runbook without executing it.
- `brigade runbook pin` writes or refreshes optional binary pins, and `--allow-pin-mismatch` overrides a missing or changed sha256.
- `brigade runbook closeout` marks a run reviewed or deferred.

Why not a plain script: when a backup stops working I want the receipt that says which step failed, not a log tail.

Keep a line plain when it is a single idempotent command, like a file sync every 30 minutes. Do not wrap everything.

The same runbooks can also be fired from OpenClaw cron as a `command` payload (below), which adds chat delivery for the result.

### Layer 2: Agent cron (OpenClaw, Hermes, similar)

Use for: scheduled research, daily summaries, posting to chat channels, any task that's "agent does X, returns text, send it somewhere."

OpenClaw skeleton lives in [`../templates/cron/openclaw-cron-job.json`](../templates/cron/openclaw-cron-job.json). Add jobs with `openclaw cron add`. The gateway owns job storage (a SQLite store on 2026.10.x), so do not hand-edit the legacy `~/.openclaw/cron/jobs.json`. Current Doctor only preserves old file-store jobs: to import them, run `openclaw doctor --fix` on 2026.9.7 before upgrading to 2026.10 (see the [cron deep dive](openclaw-cron-deep-dive.md)). Hermes and other orchestrators have their own cron-config surface: the three rules below are general. The file format isn't.

Three things to get right (orchestrator-agnostic):

1. **Pin a model and a low thinking level on every agent job.** A high-thinking model burns 10-30s per turn just deliberating. Cron jobs are procedural: search, format, post. Reserve high thinking for the few jobs that do real review, and set it on that job explicitly. Reserve interactive defaults for interactive sessions.

2. **Always set explicit delivery routing.** A bare `"mode": "announce"` with multiple channels enabled will guess wrong. Set `channel` and `to` explicitly. This applies to any orchestrator that supports multi-channel delivery: the field name varies, the principle doesn't.

3. **For anything multi-step, write a script and call it.** Most orchestrators ship a security gate that flags inline shell composition (heredocs, `&&`-chains, eval). The gate will request human approval, wait, and time out. Put steps in a `.sh` file under your scripts dir and reference it as `bash /path/to/script.sh`, or use a `command` payload.

#### OpenClaw specifics

- Manage jobs with `openclaw cron add | edit | get | list | show | rm | enable | disable | run | runs | status` (patches go through the gateway, no restart needed).
- There is no `:cron` model alias any more. Each job carries its own `payload.model` (for example `openai/gpt-6-luna`) and `payload.thinking` (`low`, `medium`, `high`), set with `--model` and `--thinking` on `openclaw cron add` or `edit`. Of my 36 jobs, 15 pin Luna explicitly. The rest are `command` payloads (no model) or inherit the agent default.
- Two payload kinds matter. `agentTurn` runs an agent with a prompt, optional `model`, `thinking`, `toolsAllow`, `lightContext`, and `timeoutSeconds`. `command` runs `argv` on the gateway with optional `cwd`, `env`, `timeoutSeconds`, `noOutputTimeoutSeconds`, and `outputMaxBytes`, with no model at all. Use `command` for anything that is already a script or a runbook.
- `sessionTarget` is `isolated` (fresh session per run, 31 of my jobs) or `current` (the job is bound to an existing session and keeps its context, 5 of my jobs). The CLI also accepts `main` and `session:<id>`. `current` jobs are the morning and health briefs that should know what the day already looked like. A `current` job stores the session key it was created in, so create it from the conversation it should live in, and re-create it if that session is retired.
- `wakeMode` is `now` or `next-heartbeat` (the `--wake` flag). 33 of my jobs use `now`. Three use `next-heartbeat` and still ran on schedule with last status `ok` on a host where heartbeats are disabled, so I treat `now` as the safe default and do not rely on `next-heartbeat` for timing.
- Set `tools.elevated.enabled: true` globally. There is no job-level `elevated` field. Per-job restriction is `toolsAllow` plus a `scheduledToolPolicy` that the gateway attaches (mine show `trusted` or `account`).
- A job can carry a `failureAlert` block (`after`, `cooldownMs`, optional `channel` and `to`). Mine use `after: 1` with cooldowns of one hour to one day, so a failing job pages once instead of every run.

#### Hermes notes

If you're running Hermes Agent instead, the agent-cron layer maps to Hermes' scheduled-task config (whatever your version exposes, the API is younger and changes between releases). The three rules above still hold. The OpenClaw-specific notes won't apply verbatim, but the underlying failure modes (heredoc detection, thinking-budget inheritance, silent delivery routing) are universal. Most agent orchestrators land on the same traps.

### Layer 3: n8n schedule trigger (multi-step workflows)

Use for: fetch + transform + fan-out, anything with conditional branches, anything that needs a real error workflow. Mine is small: 14 workflows, 11 schedule triggers, almost all watchdogs and digests (backup freshness, config drift, version watch, health dashboards) that post a result to chat.

Skeleton at [`../templates/cron/n8n-schedule-trigger.json`](../templates/cron/n8n-schedule-trigger.json). Import via the n8n UI.

**Pin the cron expression in the trigger node**, not the workflow's `triggers` field. The latter doesn't always survive workflow edits.

**Use the `errorWorkflow` setting to route failures.** A failure-classifier workflow can bucket errors (`code-error`, `auth-failed`, `rate-limited`, `transient`) and decide whether to escalate. The classifier itself is a single shared workflow that all production workflows reference.

**Idempotent fan-out is your friend.** If your workflow posts to four sinks, run them in parallel branches with their own retry logic, not in a chain. One slow sink won't block the others.

## Verification

After routing your scheduled tasks, you should be able to enumerate them all in four commands:

```bash
# Layer 1 - systemd timers
systemctl --user list-timers --all --no-legend | wc -l
# Expected: one line per timer (61 on my host)

# Layer 1b - crontab lines that call a runbook
crontab -l | grep -v '^\s*#' | grep -c 'brigade runbook run'
# Expected: a small number; every one should name an --approved runbook file

# Layer 2 - OpenClaw cron: model and thinking live under .payload
openclaw cron list --json | jq -r '.jobs[] | [.name, .schedule.expr // .schedule.kind, .sessionTarget, (.payload.model // "-"), (.payload.thinking // "-")] | @tsv'
# Expected: one row per job; agentTurn jobs show a pinned model such as openai/gpt-6-luna,
# command jobs show "-" for model and thinking

# Layer 2 - every announce job has an explicit target (current-session jobs deliver into their own session)
openclaw cron list --json | jq -r '.jobs[] | select(.delivery.mode == "announce" and .delivery.to == null and .sessionTarget != "current") | .name'
# Expected: nothing. A name listed is a routing-roulette risk.

# Layer 3 - n8n schedule triggers: list schedules in the n8n UI (Workflows, filter Active),
# or through whatever read-only n8n tooling you use. Expect one trigger node per scheduled workflow.
```

If a scheduled task doesn't show up in exactly one of these, it's in the wrong place.

## Gotchas

**Heredoc obfuscation tripped on cron-composed shell commands.** The orchestrator's security gate ran a separate check from the exec-approval gate and tagged `bash <<'EOF'` patterns, sent an approval request to a chat channel, and waited 30 minutes for a human to confirm, then timed out. **Fix:** never compose shell in the cron prompt. Always reference a script file, or use a `command` payload.

**Global high-thinking setting silently killed every cron job.** When the main interactive model was set to a high thinking budget globally, cron jobs inherited it. Multi-turn jobs that searched, formatted, and posted burned 10-30s per turn on deliberation and never finished within the 600s timeout. **Fix:** set `thinking` on each job. At the time this was a shared `:cron` model alias with `thinking: "low"`. That alias is retired and the setting now lives on each job's `payload`. Reserve high thinking for the two or three jobs that do review work (mine run with 1200-3600s timeouts).

**Cron delivery routing without an explicit target picks the wrong channel.** With multiple chat channels enabled, a bare `"mode": "announce"` is a coin flip: it will eventually pick a channel the bot isn't in and silently drop the post. **Fix:** always set `channel` and `to` explicitly. `channel: "last"` is the `openclaw cron add` default, so name the channel yourself on isolated jobs.

**`sessionTarget: current` is bound to a specific session.** The job stores the session key (agent, account, and session id) of the conversation it was created in, so it only makes sense for briefs that should continue one thread. **Fix:** create a `current` job from the conversation it belongs to, and audit them with `openclaw cron list --json | jq '.jobs[] | select(.sessionTarget=="current") | .name'` after any session cleanup. Use `isolated` for everything that does not need that history.

**`elevated tools` agent-level overrides may not work in cron context.** A regression in one minor release of the orchestrator caused agent-level `tools.elevated.enabled: true` to be ignored when the agent ran from cron. The job would fail silently because `sudo` calls inside its script bounced. **Fix:** set `tools.elevated.enabled: true` globally (still how I run it on 2026.10.4) and restrict each job with `toolsAllow`. Older notes of mine mention a per-job `elevated` field. The current job schema has none.

**n8n CLI execute does not trigger `errorWorkflow`.** When you run `n8n execute --id <wf-id>` from a script (e.g., for testing), failures do not route to your error workflow. Only auto-runs do. **Fix:** trust the auto-run path for production. For ad-hoc CLI runs, expect to inspect failures manually.

**Orchestrator upgrades regenerate systemd unit files and drop custom directives.** An in-place upgrade can silently rewrite `~/.config/systemd/user/<orchestrator>.service`, dropping `EnvironmentFile=` and other custom directives. The gateway then crash-loops on missing env vars. **Fix:** keep custom directives in drop-ins under `<unit>.d/` instead of editing the unit, and promote releases through a script that snapshots first. See [Upgrade hygiene](../infrastructure/upgrade-hygiene.md).

## Templates

- [`templates/cron/systemd-timer.service`](../templates/cron/systemd-timer.service) - service unit skeleton
- [`templates/cron/systemd-timer.timer`](../templates/cron/systemd-timer.timer) - timer unit skeleton
- [`templates/cron/openclaw-cron-job.json`](../templates/cron/openclaw-cron-job.json) - OpenClaw cron job entry skeleton (a field checklist: create real jobs with `openclaw cron add`, which writes the gateway store)
- [`templates/cron/n8n-schedule-trigger.json`](../templates/cron/n8n-schedule-trigger.json) - n8n workflow stub with schedule trigger + error workflow reference

## Related

- [`openclaw-cron-deep-dive.md`](openclaw-cron-deep-dive.md) - OpenClaw job schema, models, delivery, and example schedule in detail
- [`n8n-patterns.md`](n8n-patterns.md) - n8n Code node pitfalls, workflow_history gotcha, failure classifier in detail
- [`hooks.md`](hooks.md) - pre/post hooks and sandbox shims that limit what cron jobs can do
- [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md) - the release-worktree promotion flow
