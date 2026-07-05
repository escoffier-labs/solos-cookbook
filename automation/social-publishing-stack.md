# Self-Hosted Social Publishing Stack

> The publishing plumbing I actually run: Postiz for scheduling and fan-out to the networks, n8n for the multi-step orchestration around it, and an agent driving both over MCP with writes gated off by default. You own the scheduler, the queue, and the data. No per-seat SaaS, no third party holding your calendar. 🦞

**Tested on:** Postiz (self-hosted) + n8n 2.16.x in one Docker compose stack inside a single unprivileged LXC on a home Proxmox host, driven by `postiz-mcp` and `n8nctrl` (published as `n8n-ops-mcp`) from an OpenClaw agent (also works from Claude Code, Codex CLI, Hermes), writes env-gated, deletes double-gated
**Last updated:** 2026-06-10

---

## What this is

This guide covers the **publishing layer** for an agent-driven social setup: how to self-host the scheduling and fan-out infrastructure and let an agent operate it. Two pieces:

- **Postiz** is the publishing layer. It holds the network integrations (X, Bluesky, LinkedIn, Mastodon, Reddit, etc.), the scheduling calendar, the per-provider rules, and the analytics read-back. It is the thing that actually talks to each social API.
- **n8n** is the orchestration layer. It runs the layer-3 multi-step workflow: a schedule trigger builds a payload, calls Postiz to schedule or publish, fans out to multiple channels in parallel branches, and routes any failure into the shared error workflow.

The agent's job here is **operational only**: schedule a post group, fan it out, check integration health, classify and route a failure, report analytics back to you. That is the whole scope.

## The content boundary

This guide is about the **pipes, not the payload**. What you publish, how you decide what to publish, and where the words come from is your business and entirely out of scope here. Nothing below drafts, rewrites, ranks, or selects content. The agent receives content that already exists, schedules it, and reports on what happened. Treat the publishing stack like a printer: it does not care what you feed it, and this guide does not tell you what to feed it.

If you want the agent to do more than move bytes to a scheduler, that is a different system with a different risk profile, and it is not this one.

## Why self-host the publishing layer

The obvious alternative is a hosted scheduler (Buffer, Hootsuite, Typefully, etc.). Self-hosting Postiz buys you four things that matter once an agent is in the loop:

- **You own scheduling.** The calendar, the queue, and the "next free slot" logic live on your box. No vendor decides your posting windows or rate-limits your API access on top of the networks' own limits.
- **No per-seat SaaS.** One container, no monthly tier that scales with channels or "team members." Add networks until the platforms themselves push back.
- **It composes with the agent stack.** Postiz and n8n both expose clean surfaces (`postiz-mcp`, `n8nctrl`) that slot into the same MCP-driven agent you already run for everything else. No bespoke integration, no hand-rolled HTTP in every workflow.
- **Data stays local.** Your connected-account tokens, scheduled queue, and analytics history sit in a container you control, not a third party's database. When you tear it down, it is actually gone.

The tradeoff is honest: you now own the uptime, the upgrades, and the blast radius. The Gotchas section is where that bill comes due.

## Prerequisites

- A Linux host that can run Docker compose. This guide assumes both services run together in **one unprivileged LXC container** (call it "the social-automation container") on a home Proxmox host, but any Docker host works. See [`infrastructure/service-isolation.md`](../infrastructure/service-isolation.md) for the one-service-per-container reasoning.
- Postiz self-hosted via its official compose file, reachable on its internal port (e.g. `http://192.0.2.10:5000`).
- n8n in the same compose stack, reachable on its internal port (e.g. `http://192.0.2.10:5678`).
- An MCP-capable client (Claude Code, Claude Desktop, OpenClaw, Hermes Agent, Codex CLI) to drive both.
- `postiz-mcp` and `n8nctrl` installed and wired to that client. The n8n npm package remains `n8n-ops-mcp` for compatibility. Tool surfaces and env flags are documented in [`tools/mcp-catalog.md`](../tools/mcp-catalog.md).
- A Postiz Public API key (Postiz → Settings → Public API → Generate) and an n8n Public API key (n8n → Settings → API).

## Architecture and topology

Both services live in one Docker compose stack inside the social-automation container. Postiz handles the social side; n8n orchestrates around it; the agent drives both over MCP from outside the container.

```
                          social-automation container (unprivileged LXC)
                          ┌──────────────────────────────────────────────┐
  agent (MCP host)        │   docker compose                              │
  ┌───────────────┐       │   ┌──────────────┐      ┌──────────────────┐  │
  │ postiz-mcp    │──────────▶│ Postiz       │─────▶│ X / Bluesky /    │──┼──▶ networks
  │ n8nctrl       │──┐    │   │ :5000        │      │ LinkedIn / etc.  │  │
  └───────────────┘  │    │   └──────────────┘      └──────────────────┘  │
                     │    │          ▲                                    │
                     └───────────────┼──── n8n ──────────────────────────│
                          │   ┌──────┴───────┐   schedule → payload →     │
                          │   │ n8n :5678    │   call Postiz → fan out →  │
                          │   └──────────────┘   error workflow           │
                          └──────────────────────────────────────────────┘
```

**How a post flows:**

1. An n8n **schedule trigger** fires (layer 3 in the [cron-patterns](cron-patterns.md) split: multi-step, branching, fan-out).
2. The workflow assembles a Postiz post payload from content it was handed (the workflow does not author it).
3. It calls Postiz to schedule or publish, optionally to several integrations in parallel branches.
4. Postiz queues each post and, at the scheduled time, publishes it to the real network via that network's API.
5. Any failure in the chain routes to the shared `errorWorkflow` classifier (see [`failure-classifier.md`](failure-classifier.md)).

The agent sits beside all of this, not inside the hot path. It wires the workflows, schedules post groups directly when needed, checks health, and reads analytics. It does not become a runtime dependency of the publish itself.

## Postiz as the publishing layer

Postiz is the only thing in this stack that talks to a social API. Everything else routes through it.

### Connecting network integrations

Each network ("integration" in Postiz terms) is connected once via OAuth. The agent can kick off the connect flow but a human completes the OAuth handshake in a browser:

- `postiz_connect_integration` generates the OAuth URL for a new channel (write-gated).
- `postiz_list_integrations` lists the connected channels and their ids.
- `postiz_check_integration` verifies a channel's API key is still valid.

You will reference integration ids constantly downstream, so list them once and keep the mapping handy. Ids are UUIDs, not handles.

### Scheduling

Scheduling is `postiz_create_post` with `type: "schedule"` and a `date`. Three things make this reliable:

- **Ask for a free slot first.** `postiz_find_next_slot` returns the next open posting slot for a channel so you do not stack two posts on the same minute.
- **Check length and provider rules before you build the payload.** `postiz_get_integration_settings` returns the live runtime config for one integration: its rules, verified-aware `maxLength`, and the platform-specific tools it supports. `postiz_get_provider_settings_schema` returns the per-provider `settings` reference (X's `who_can_reply_post`, LinkedIn's `audience`, etc.) so you construct a valid payload instead of getting a 400.
- **Media goes through Postiz, not raw paths.** `postiz_upload_file` (local file or base64) and `postiz_upload_from_url` return paths that the post payload references. Raw filesystem paths and external URLs are rejected in the post body, so upload first, reference the returned path second.

`type` can be `schedule`, `now`, or `draft`. A `now` (or near-term) publish lands on real accounts immediately. Once published, Postiz can delete its record of the post but **the platform-side post stays live** - Postiz cannot recall it. Treat `now` like a loaded gun.

### The integration-health reality

Connected does not mean working. Per-network OAuth tokens expire on their own schedule, get revoked when you change a password, or lose scope after a platform API change. A channel that published fine last week can silently start failing. The two read tools that surface this:

- `postiz_check_integration` - verify one channel's key on demand.
- `postiz_list_notifications` - Postiz's own UI notifications, where it reports connection problems.

Wire a periodic health sweep (a small n8n schedule or an agent cron) that runs `postiz_check_integration` across every channel and alerts on the first failure, rather than discovering a dead token when a scheduled post silently never lands.

## n8n as the orchestration layer

When publishing is more than "schedule one post" - fan out to several networks, branch on conditions, retry per-sink, route failures - it belongs in n8n. This is layer 3 in [`cron-patterns.md`](cron-patterns.md): multi-step workflows with branches and fan-out. The n8n surface area, Code node traps, and interface choices are covered in depth in [`n8n-patterns.md`](n8n-patterns.md); this section is just the publishing shape.

The workflow topology:

```
Schedule Trigger
  → Build payload (from content handed in - NOT authored here)
  → Call Postiz (HTTP Request node, or via the agent)
      ├─ branch: integration A
      ├─ branch: integration B   (parallel fan-out, per-branch retry)
      └─ branch: integration C
  → on any error → errorWorkflow (shared Failure Classifier)
```

Three rules carry over from the cron and n8n guides and matter here specifically:

- **Fan out in parallel branches, not a chain.** If you publish to four networks, run them as parallel branches with their own retry logic. One slow or rate-limited network should not block the other three.
- **Wire the shared `errorWorkflow`.** Point the workflow's `errorWorkflow` setting at the one Failure Classifier workflow so a per-network rate-limit or a dead token gets bucketed and routed instead of flooding a chat channel. The full classifier build is in [`failure-classifier.md`](failure-classifier.md); the buckets you will hit most on a publishing workflow are `rate-limit` (safe retry with backoff), `auth` (token expired - investigate, do not retry), and `http-client` (a malformed payload - investigate).
- **Mind the `errorWorkflow`-stripping trap.** Editing a workflow through the raw `PUT /workflows/:id` strips `settings.errorWorkflow`. Use `n8nctrl` (which wraps the update correctly) or direct sqlite with n8n stopped. This is the single most common way a publishing workflow quietly stops routing its failures. See [`n8n-patterns.md`](n8n-patterns.md) Layer 2.

For the schedule-trigger skeleton, lift [`../templates/cron/n8n-schedule-trigger.json`](../templates/cron/n8n-schedule-trigger.json).

## Agent control via MCP

The agent drives both layers over MCP, with writes gated off by default on both servers. This is the operational surface: schedule, fan out, health, failure routing, analytics. None of it touches content authoring.

### Postiz over `postiz-mcp`

Representative operational calls (real tool names):

- **Schedule a post group:** `postiz_find_next_slot` → `postiz_get_integration_settings` (length/rules) → `postiz_upload_file` (if media) → `postiz_create_post` with `type: "schedule"`.
- **List what is queued or shipped:** `postiz_list_posts` over a date window.
- **Check health:** `postiz_list_integrations` then `postiz_check_integration` per channel; `postiz_list_notifications` for Postiz-reported problems.
- **Report analytics back to you:** `postiz_get_platform_analytics` (followers / impressions / engagement) and `postiz_get_post_analytics` (likes / comments / shares).
- **Toggle a queued item:** `postiz_update_post_status` flips DRAFT ↔ QUEUE.
- **Per-provider operations:** `postiz_invoke_integration_tool` calls a platform-specific method (e.g. a Reddit subreddit lookup) discovered via `postiz_get_integration_settings(id).tools`.

**Env-gated writes.** Reads always work. `postiz_create_post`, `postiz_connect_integration`, uploads, and status toggles require `POSTIZ_ENABLE_WRITE=true`. The destructive trio - `postiz_delete_post`, `postiz_delete_post_group`, `postiz_delete_integration` - additionally requires `POSTIZ_ENABLE_DELETE=true` **and** `confirm: true` in the call. Default config keeps writes and deletes off, so an over-eager or prompt-injected agent gets a read-only surface until you deliberately open it.

**The rate-limit guard.** The Postiz Public API is rate-limited (30 requests/hour by default). `postiz-mcp` tracks the budget locally and **refuses to send when it is exhausted**, rather than letting the agent burn the hour on retries and lock you out. Raise the ceiling with `POSTIZ_RATE_LIMIT_PER_HOUR` only if your Postiz instance is actually configured higher.

### n8n over `n8nctrl`

Representative operational calls (real tool names):

- **See the publishing workflows:** `n8n_list_workflows` (filter by tag/name), `n8n_get_workflow` for the node graph.
- **What is scheduled:** `n8n_list_schedules` decodes every schedule trigger into a human-readable string ("daily at 09:00").
- **Trigger a publish run on demand:** `n8n_list_webhooks` to find the path, then `n8n_trigger` with `mode: "webhook"` and `confirm: true` (write-gated; running a workflow executes its nodes, so it is treated as a write).
- **Triage a failed publish:** `n8n_list_executions` with `status=error`, `n8n_get_execution` for the per-node log, `n8n_search_executions` to grep for a fragment (e.g. a rate-limit string), `n8n_execution_stats` to spot a flaky workflow.
- **Recover a stuck or failed run:** `n8n_cancel_execution`, `n8n_retry_execution`.

**Env-gated writes, mirrored design.** n8n write tools are hidden unless `N8N_ENABLE_EDIT=true`, and the mutating ones are confirm-gated with auto-backup before destructive operations. Credential writes sit behind a **second** gate (`N8N_ENABLE_CREDENTIALS_WRITE=true`) on top of edit. For a publishing stack, the agent typically needs reads plus `n8n_trigger`; it does not need credential-write access at all.

**What stays gated.** The defensible default for this whole stack is: reads on, `POSTIZ_ENABLE_WRITE` on (so the agent can actually schedule), `POSTIZ_ENABLE_DELETE` **off**, `N8N_ENABLE_EDIT` on only if the agent manages workflows (otherwise off), and `N8N_ENABLE_CREDENTIALS_WRITE` **off**. Deleting a post group or disconnecting an integration is a deliberate human-confirmed act, not a default capability.

## Verification

After wiring, you should be able to confirm the whole pipe end to end:

```bash
# 1. Both services answer inside the container
curl -fsS http://192.0.2.10:5000/ >/dev/null && echo "postiz up"
curl -fsS http://192.0.2.10:5678/healthz >/dev/null && echo "n8n up"
```

From the MCP client:

```
# 2. Postiz integrations are connected and healthy
"List my Postiz integrations, then check each one."
  → postiz_list_integrations → postiz_check_integration per id

# 3. The next free slot resolves (scheduling path is live)
"What's the next free posting slot on <channel>?"
  → postiz_find_next_slot

# 4. The publishing workflow exists and its schedule is sane
"List n8n schedules and show the publishing workflow."
  → n8n_list_schedules → n8n_get_workflow

# 5. The error chain is wired (run inside the container)
```

```bash
docker exec n8n sh -c 'sqlite3 /home/node/.n8n/database.sqlite \
  "SELECT id, name, json_extract(settings, \"$.errorWorkflow\") FROM workflow_entity WHERE active = 1;"'
# Every active publishing workflow should have an errorWorkflow id set.
```

If a publishing workflow is active but its `errorWorkflow` is null, a recent raw `PUT` stripped it - re-set via `n8nctrl` or direct sqlite. See [`n8n-patterns.md`](n8n-patterns.md).

## Gotchas

**Per-network integration tokens expire independently and silently.** Each connected network has its own OAuth lifetime and revocation triggers (password change, scope change, platform API update). One channel goes dark while the others keep working and nothing tells you until a scheduled post never lands. **Fix:** a periodic `postiz_check_integration` sweep across every channel plus a `postiz_list_notifications` poll, alerting on the first failure.

**Per-provider rate limits and character limits are not uniform.** X, LinkedIn, Bluesky, Mastodon, and Reddit each have different length ceilings and posting-rate rules, and "verified" accounts get different limits than unverified. A payload that is fine on one network 400s on another. **Fix:** call `postiz_get_integration_settings` (verified-aware `maxLength`, live rules) and `postiz_get_provider_settings_schema` before building the payload, not after the failure.

**The Postiz Public API rate limit is low (30/hour default).** It is easy to exhaust with a chatty agent that retries on every transient error. `postiz-mcp`'s local guard refuses to send once the budget is gone, which protects you, but it also means a burst of scheduling will stall. **Fix:** batch your scheduling, lean on `postiz_create_post` post groups (one call, multiple integrations) instead of one call per channel, and only raise `POSTIZ_RATE_LIMIT_PER_HOUR` if your instance is genuinely configured higher.

**`now` and near-term publishes are unrecallable.** Deleting a published post in Postiz removes Postiz's record, not the live post on the platform. **Fix:** prefer `type: "schedule"` with a near-future date over `type: "now"` so there is a window to cancel via `postiz_delete_post` before it actually ships, and keep `POSTIZ_ENABLE_DELETE` off until the moment you need it.

**Editing a publishing workflow through raw `PUT` strips its `errorWorkflow`.** The single most common way a publishing pipeline quietly stops routing failures: a scripted edit through `PUT /workflows/:id` drops `settings.errorWorkflow`, and from then on rate-limit and dead-token errors vanish instead of bucketing. **Fix:** edit through `n8nctrl` (it wraps the update correctly) or direct sqlite with n8n stopped, and verify with the active-workflow query in Verification. Full detail in [`n8n-patterns.md`](n8n-patterns.md) Layer 2.

**Postiz upgrades are a publishing outage if they go sideways.** Postiz moves fast and self-hosted upgrades occasionally need a database migration. An upgrade mid-day with a queued post calendar is a bad time to discover a migration issue. **Fix:** snapshot the container (or the Postiz database volume) before any `docker compose pull` + recreate, upgrade in a quiet window, and re-run the integration-health sweep afterward - tokens occasionally need a reconnect after a major version bump.

**The social-automation container is a single blast-radius point.** Postiz and n8n share one container, which means one compromised credential, one runaway workflow, or one bad upgrade affects the entire publishing pipeline and every connected account at once. That is the cost of co-locating them. **Fix:** keep it unprivileged, back up the database volumes on a schedule (see [`infrastructure/backup-recovery.md`](../infrastructure/backup-recovery.md)), keep `POSTIZ_ENABLE_DELETE` and `N8N_ENABLE_CREDENTIALS_WRITE` off by default so a single compromised agent session cannot disconnect accounts or exfiltrate credentials, and treat the container the way [`infrastructure/service-isolation.md`](../infrastructure/service-isolation.md) treats any service that touches real external accounts.

## Related

- [`automation/cron-patterns.md`](cron-patterns.md) - the three-layer scheduling model; the n8n publishing workflow is layer 3
- [`automation/n8n-patterns.md`](n8n-patterns.md) - n8n interface choices, Code node traps, the `errorWorkflow`-stripping trap, failure-classifier shape
- [`automation/failure-classifier.md`](failure-classifier.md) - the shared error workflow that buckets per-network rate-limits and dead tokens
- [`tools/mcp-catalog.md`](../tools/mcp-catalog.md) - `postiz-mcp` and `n8nctrl` tool surfaces and env flags in full
- [`infrastructure/service-isolation.md`](../infrastructure/service-isolation.md) - why the social-automation container is one unprivileged LXC and how to bound its blast radius
