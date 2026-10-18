# Cron Job Patterns

How to schedule automated tasks in OpenClaw, pin the right model and thinking level on each job, decide between agent turns and command payloads, and avoid the pitfalls that waste tokens and break silently.

**Tested on:** OpenClaw 2026.10.4 with 36 gateway cron jobs, GPT 6 Luna pinned on 15 of them, Brigade 0.28.0 runbooks as command payloads
**Last updated:** 2026-10-17

---

## Two Scheduling Systems (and Which One I Use)

OpenClaw has two mechanisms for periodic work: heartbeats and cron jobs. On my host only cron is in use. Heartbeats are an optional feature that I have switched off.

### Heartbeats (optional, disabled here)

A heartbeat is a recurring poll that wakes your main agent session so it can check what needs attention and either act or ack. It is configured under `agents.defaults.heartbeat`. Mine reads:

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "0m",
        "model": "openai/gpt-6-luna",
        "target": "telegram",
        "to": "<telegram-chat-id>",
        "directPolicy": "allow"
      }
    }
  }
}
```

`every: "0m"` is off. There is no `HEARTBEAT.md` in my workspace and no `heartbeat-state.json`. The periodic checks that used to live there became cron jobs with their own timeouts, models, and delivery targets. If you do enable heartbeats, keep the checklist file tiny, because it is loaded every cycle, and give heartbeats a cheap model (the config above pins Luna) so an ack does not cost frontier-model input tokens.

Heartbeats make sense when several checks can batch into one turn with conversational context and loose timing. I found that batching hides failures: one wedged check delays the rest and nothing records which one. Per-job cron gives each check its own run history.

### Cron Jobs

Precise scheduled tasks with their own model, session target, timeout, and delivery. This is where everything runs for me.

**Use cron when:**
- Exact timing matters ("9:00 AM sharp every Monday")
- The task needs isolation from main session history
- You want a different model or thinking level for the task
- The work is already a script or a Brigade runbook (use a `command` payload, no model at all)
- Output should deliver to a channel without main session involvement

### Decision Matrix

| Need | Use |
|------|-----|
| Run a restic backup or a runbook on a schedule | Cron `command` payload (or a systemd timer, see [cron-patterns](cron-patterns.md)) |
| Daily summary posted to a chat channel | Cron `agentTurn`, isolated |
| A morning brief that should know what the day already looked like | Cron `agentTurn`, `sessionTarget: current` |
| Weekly review at 4am | Cron `agentTurn` with `thinking: high` and a long timeout |
| "Remind me in 30 minutes" | Cron one-shot (`--at 30m`) |
| Monitor for urgent messages | Event hooks or a watchdog, not polling an agent |

## Cron Job Configuration

### Managing Jobs

The gateway owns the job store (SQLite on 2026.10.x). Use the CLI. Do not hand-edit the legacy `~/.openclaw/cron/jobs.json`, which only survives as backup copies from the old layout, and run `openclaw doctor --fix` to normalize old storage.

```bash
openclaw cron list --json     # all jobs, with state and delivery previews
openclaw cron show <id>       # one job, human readable
openclaw cron get <id>        # one job as JSON
openclaw cron add ...         # create (see flags below)
openclaw cron edit <id> ...   # patch fields
openclaw cron enable|disable <id>
openclaw cron runs <id> --limit 10
openclaw cron status          # scheduler state, store path, next wake
openclaw cron rm <id>
```

`openclaw cron run <id>` triggers a job immediately (debug). Do not use it casually on a job that posts to a channel or runs a backup.

### Schedule Types

```json
// One-shot at a specific time or after a duration (CLI: --at 2026-03-17T14:00:00 or --at 20m)
{ "kind": "at", "at": "2026-03-17T14:00:00-04:00" }

// Recurring interval (CLI: --every 1h)
{ "kind": "every", "everyMs": 3600000 }

// Cron expression (CLI: --cron "0 8 * * *" --tz America/New_York)
{ "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York", "staggerMs": 0 }
```

Of my 36 jobs, 35 are `cron` and 1 is `every`. `--exact` sets the stagger window to 0. `--stagger 5m` spreads jobs that would otherwise fire on the same minute.

### Payload Types

The two I use, as they appear in `openclaw cron list --json`:

```json
// Agent turn: an agent runs a prompt
{
  "kind": "agentTurn",
  "message": "<the prompt, or a pointer to a script the agent should run>",
  "model": "openai/gpt-6-luna",
  "thinking": "low",
  "timeoutSeconds": 600,
  "toolsAllow": ["read", "exec"],
  "lightContext": true
}

// Command: the gateway runs argv, no model involved
{
  "kind": "command",
  "argv": ["brigade", "runbook", "run", "--target", "<workspace>", "--approved", "<runbook>.json"],
  "cwd": "<optional>",
  "env": {},
  "timeoutSeconds": 1000,
  "noOutputTimeoutSeconds": null,
  "outputMaxBytes": null
}
```

Counts on my host: 21 `agentTurn` (15 pin `openai/gpt-6-luna`, the other 6 inherit the agent default) and 15 `command`. Four of the commands run Brigade runbooks. Others call `brigade handoff doctor`, `brigade mcp doctor`, `brigade outcome rank`, `brigade outcome reconcile`, a weekly repo-health script, and short reminder-style commands.

`openclaw cron add --help` also lists a `--system-event` payload (injected into the main session), a headless `--script` payload, `--stream-*` options for stream-triggered jobs, and `--trigger-script` for conditional runs. I have not deployed those, so I will not describe their behavior here.

### Session Target

| `sessionTarget` | Meaning | My count |
|-----------------|---------|----------|
| `isolated` | A fresh session per run. No conversation history, workspace files only. | 31 |
| `current` | Bound to the session the job was created from, so it keeps that context. | 5 |

The CLI also accepts `main` and `session:<id>`. A `current` job stores the full session key (agent, account, session id). Create it from the conversation it belongs to. All five of my `current` jobs are morning or health briefs that should continue one thread, and all five are `agentTurn` payloads.

### Full Example: a Daily Summary

A generic agent job, shaped like one of mine:

```json
{
  "name": "daily-summary",
  "agentId": "main",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize unread email from the last 24h. Keep it under 200 words.",
    "model": "openai/gpt-6-luna",
    "thinking": "low",
    "timeoutSeconds": 300
  },
  "delivery": {
    "mode": "announce",
    "channel": "discord",
    "to": "channel:<discord-channel-id>",
    "bestEffort": true
  }
}
```

Equivalent creation with the CLI:

```bash
openclaw cron add daily-summary \
  --cron "0 8 * * *" --tz America/New_York \
  --session isolated \
  --model openai/gpt-6-luna --thinking low \
  --timeout-seconds 300 \
  --announce --channel discord --to "channel:<discord-channel-id>" \
  --best-effort-deliver \
  --message "Summarize unread email from the last 24h. Keep it under 200 words."
```

**Three fields matter most:**

- `payload.model` and `payload.thinking` are per job. There is no `:cron` alias any more (that was `<model>:cron` with `thinking: low`, defined under `agents.defaults.models`). Pin the model on each job and set `thinking` deliberately.
- `delivery.channel` plus `delivery.to` are explicit. **Always set both.** A bare `"mode": "announce"` with multiple channels enabled guesses wrong and posts to whichever channel the bot isn't in. (Incident: 2026-03-02. I patched every cron config with an explicit target the same day.) Discord targets look like `channel:<id>`. Telegram targets are the bare chat id.
- `timeoutSeconds` is yours to size. See the table below.

`current` jobs are the exception on delivery: they announce into their own bound session, so my five have no `to`.

## Model Assignment for Cron Jobs

Not every cron job needs the same thinking budget. Observed settings on my host, generalized:

| Task | Payload | Model / thinking | Timeout |
|------|---------|------------------|---------|
| Email or inbox digest | agentTurn | Luna, `low` | 300s |
| Nightly maintenance report | agentTurn | Luna, `low` | 600s |
| Card or note refresh | agentTurn | Luna, `low` | 900s |
| Pipeline health check | agentTurn | Luna, `medium` | 240-600s |
| Handoff inbox review | agentTurn | Luna (default thinking) | 1800s |
| Architecture audit (twice weekly) | agentTurn | Luna, `high` | 1200s |
| Fleet triage (twice weekly) | agentTurn | Luna, `high` | 3600s |
| Restic backup, runbook, doctor check | command | none | 600-28800s |
| Morning or health brief | agentTurn, `current` | agent default | 180-480s |

Rule of thumb: `low` for anything mechanical, `medium` when the job must read and decide, `high` only for review work that I would also give a long timeout. Deeper judgment than that belongs in an interactive session or an ACP escalation, not a cron.

### Model Assignment Gotchas

1. **Don't put a frontier reviewer model in a cron directly.** If a cron needs deeper judgment, have it run the main pass on the cheap model and let the result trigger a review pass elsewhere. Keeps the expensive quota targeted.

2. **Small local models fail silently on reasoning.** I tested qwen3:8b for cron triage and its thinking mode burned all 512 output tokens on internal reasoning, producing empty responses. Test local models with your actual cron prompts before scheduling.

3. **A retired fallback can pin a job.** History (2026): GPT 5.3 Codex showed 0% weekly usage while returning rate-limit errors, and coder tasks failed with `FailoverError`. Both GPT 5.5 and GPT 5.3 Codex are retired now, but the lesson stands: keep the fallback chain populated and look at the model a job actually used (`openclaw cron runs <id>`) after any provider incident. See [multi-model orchestration](../ai-stack/multi-model-orchestration.md).

## Writing the Prompt

Keep prompts short and point at scripts. A multi-line prompt embedded in a job is hard to edit and tends to get escape-mangled. For anything with real steps, use one of these instead:

- A `command` payload that runs the script or runbook directly. No model, no token cost, no heredoc gate.
- An `agentTurn` whose message is "run `<script>` and report", with `toolsAllow` limited to `exec` and `read`.

There is no `cron-prompts/` directory in my setup. The earlier pattern (a prompt file per job, read at turn time) was replaced by scripts and runbooks, which version cleanly in git and have receipts.

### Tool Access

Cron sessions are restricted by the job, not by a job-level `elevated` flag. There is no `elevated` field in the job schema. What exists:

- `payload.toolsAllow`: an allow-list of tool names for the run. Mine range from none to six named tools. One job allows `*`. Set it with `--tools exec,read`. `--tools ""` disables all tools.
- `scheduledToolPolicy`: a policy block the gateway attaches to some jobs (mine show `trusted` on six and `account` on one).
- `tools.elevated.enabled: true` globally, in `openclaw.json`. Agent-level `elevated` overrides were unreliable from cron on one release, so I leave the global switch on and restrict per job with `toolsAllow`.

`lightContext: true` (CLI `--light-context`) gives an agent job a lightweight bootstrap instead of the full workspace context. Four of my jobs use it.

## Example Schedule (Real Production)

Generic labels, times in the host timezone. This is built from `openclaw cron list --json` and trimmed to the shapes that repeat:

| Time | Task | Payload | Model / thinking | Session | Delivery |
|------|------|---------|------------------|---------|----------|
| 02:00 daily | Archive crawler ingest | command (runbook) | none | isolated | none |
| 03:15, 15:15 | NAS backup (restic) | command (runbook) | none | isolated | announce |
| 04:00 daily | Nightly maintenance | agentTurn | Luna, low | isolated | announce |
| 04:20 Sun, Wed | Architecture audit | agentTurn | Luna, high | isolated | announce |
| 04:40 Sun | Cloud-drive backup (restic) | command (runbook) | none | isolated | announce |
| 05:45 daily | Card refresh | agentTurn | Luna, low | isolated | announce |
| 06:45 daily | Morning agenda brief | agentTurn | default | current | announce |
| 07:00 Sun | Repo health check | command (script) | none | isolated | none |
| 08:00 daily | Email summary | agentTurn | Luna, low | isolated | announce |
| 08:33 daily | Intel pipeline health | agentTurn | Luna, medium | isolated | announce |
| 09:35 daily | Handoff health check | command | none | isolated | none |
| 09:45 daily | Backup health brief | agentTurn | default | current | announce |
| 21:07 daily | Handoff draft review | agentTurn | Luna | isolated | announce |
| 22:00 daily | Memory sweep | agentTurn | Luna, low | isolated | announce |
| Mon 09:09, 09:39 | Outcome rank, then reconcile | command (x2) | none | isolated | none |
| 1st of month | Surfacing check | agentTurn | Luna | isolated | announce |

I use off-the-hour minutes (`:07`, `:09`, `:33`, `:45`) so two agent turns rarely start on the same minute.

## Error Handling

### Silent Failures

Cron jobs can fail without anyone noticing. Common causes:
- Model rate limit hit (job queued but never runs)
- Network timeout during API call
- Job produces empty output (model burned tokens on reasoning, nothing left for response)
- `timeoutSeconds` too short for the work (a 600-second default on a job that sometimes needs 20 minutes)

### Monitoring Pattern

```bash
# Scheduler state and next wake
openclaw cron status

# Recent run history for one job, or all jobs
openclaw cron runs <jobId> --limit 10
openclaw cron runs --all --limit 20

# Only runs whose delivery did not land
openclaw cron runs --all --delivery-status not-delivered
```

Per-job state is also in `openclaw cron list --json` under `.state`: `lastRunStatus`, `lastDurationMs`, `lastDeliveryStatus`, `consecutiveErrors`, `consecutiveSkipped`.

Look for jobs with no recent runs (stuck or disabled), consistent failures (wrong model, bad prompt, timeout), and empty outputs (token budget too low).

### Failure Alerts

A job can carry its own `failureAlert`:

```json
{ "after": 1, "channel": "discord", "to": "channel:<discord-channel-id>", "cooldownMs": 86400000 }
```

`after` is the number of consecutive failures before the alert fires and `cooldownMs` limits repeats. Mine use `after: 1` with cooldowns from one hour to one day. This is cheaper than reading run logs and works for `command` jobs too.

### Delivery Configuration

```json
{
  "delivery": {
    "mode": "announce",
    "channel": "discord",
    "to": "channel:<discord-channel-id>",
    "bestEffort": true
  }
}
```

Options:
- `"none"`: run silently, no output delivery (13 of mine, backups and checks that only alert on failure)
- `"announce"`: send the final text to a chat target (23 of mine)
- webhook delivery: `openclaw cron add --webhook <url>` posts the finished payload to a URL

`bestEffort: true` keeps a delivery failure from failing the job. **Always set `channel` and `to`** on isolated jobs. The `last` channel value (the `openclaw cron add` default) resolves to wherever the session last spoke, which is not what you want from an isolated nightly job. Targets: `channel:<id>` for a Discord channel, a bare chat id for Telegram.

## Quiet Hours

Respect your own schedule. Don't fire cron announcements at 3am unless they're urgent:

- Set backup and maintenance jobs to `delivery.mode: "none"` plus a `failureAlert`
- Reserve `announce` for tasks during waking hours
- Schedule the heavy audits in the small hours and let the result wait in the channel

## Verification

```bash
# Scheduler is up and the store is the SQLite one
openclaw cron status
# Expected: "enabled": true, "storage": "sqlite", and a job count

# Every job, with model and thinking from .payload (there is no :cron alias)
openclaw cron list --json | jq -r '.jobs[] | [.name, .sessionTarget, .payload.kind, (.payload.model // "-"), (.payload.thinking // "-")] | @tsv'
# Expected: agentTurn rows show a model such as openai/gpt-6-luna; command rows show "-"

# Audit delivery targets: every announce job outside a current session needs an explicit "to"
openclaw cron list --json | jq -r '.jobs[] | select(.delivery.mode == "announce" and .delivery.to == null and .sessionTarget != "current") | .name'
# Expected output: nothing. Any name listed is a routing-roulette risk.

# Jobs with recent trouble
openclaw cron list --json | jq -r '.jobs[] | select(.state.consecutiveErrors > 0) | [.name, .state.consecutiveErrors, .state.lastRunStatus] | @tsv'
# Expected output: nothing

# Check the heartbeat setting (off if "every" is "0m")
jq '.agents.defaults.heartbeat' ~/.openclaw/openclaw.json
```

## Gotchas

1. **Heartbeats are off by design here.** If you copy an older guide that tells you to put checks in `HEARTBEAT.md`, nothing will run unless `agents.defaults.heartbeat.every` is a real interval. Check with the `jq` line above before you rely on one.

2. **Cron timezone confusion.** Always specify `tz` in cron schedules. Without it, the expression uses the gateway host's local timezone (per `--tz` in the CLI help), which is easy to forget after a host move. 35 of my 36 jobs carry an explicit `tz`. The one that doesn't is the `every` interval job, where it doesn't apply.

3. **One-shot crons don't repeat.** `kind: "at"` fires once and is done (`--delete-after-run` removes the job after a successful run, `--keep-after-run` keeps it). If you want recurring, use `cron` or `every`.

4. **Isolated sessions start cold.** Jobs with `sessionTarget: "isolated"` don't have your conversation history or memory loaded unless the prompt asks to search memory. They get workspace files but no session continuity. If a job must continue a thread, make it `current`.

5. **Bare `announce` without `to` is a routing coin-flip.** With both Telegram and Discord enabled, the gateway guesses, and the guess has been wrong often enough that I treat it as a bug. Always set `channel` and `to`.

6. **Haiku and the `:cron` alias are gone.** Older versions of this guide recommended Anthropic Haiku, then a `gpt-5.5:cron` low-thinking alias. The first went away with the [claude-cli removal](../ai-stack/claude-cli-to-acp-migration.md). The alias went away when jobs started carrying `payload.model` and `payload.thinking` directly. Both models in that sentence are retired. Pin the current model on the job.

7. **Sub-agents spawned from cron can find destructive API endpoints.** Incident (2026-03-02): a Haiku cron found and called `DELETE /api/index` on a local API three times unprompted, wiping 71K indexed chunks. It read the OpenAPI spec, saw a destructive route, and used it. Lock down your local APIs before giving any cron subagent `exec` or HTTP access, and use `toolsAllow` to keep the tool list as small as the job needs. See [agent security hardening](../security/agent-security-hardening.md).

8. **The gateway restarts nightly on my host.** A systemd timer restarts it at 04:30, and two agent jobs (04:00 and 04:20) run close to that window. I have not tested what happens to a job that is mid-run at restart, so after adding any job near a restart, check its `lastRunStatus` and `lastRunError` in `openclaw cron list --json` rather than assuming it survived.
