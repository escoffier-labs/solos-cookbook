# Cron Job Patterns

How to schedule automated tasks in OpenClaw, assign the right model to each job, batch checks into heartbeats, and avoid the pitfalls that waste tokens and break silently.

**Tested on:** OpenClaw 2026.4.x with 36+ active cron jobs, GPT 5.4 (with `:cron` thinking-low alias), browser-LLM stack for research-heavy pipelines, ACP Opus for final polish
**Last updated:** 2026-04-19

---

## Two Scheduling Systems

OpenClaw has two mechanisms for periodic work. Use the right one for the job.

### Heartbeats

A recurring poll (default: every 30 minutes) that triggers your main agent session. The agent reads `HEARTBEAT.md`, checks what needs attention, and either acts or acks.

**Use heartbeats when:**
- Multiple checks can batch together (email + calendar + notifications in one turn)
- You need conversational context from recent messages
- Timing can drift slightly (every ~30 min is fine)
- You want to reduce API calls by combining periodic checks

### Cron Jobs

Precise scheduled tasks that run in isolated sessions with their own model assignment.

**Use cron when:**
- Exact timing matters ("9:00 AM sharp every Monday")
- The task needs isolation from main session history
- You want a different model (cheaper or specialized) for the task
- One-shot reminders ("remind me in 20 minutes")
- Output should deliver to a channel without main session involvement

### Decision Matrix

| Need | Use |
|------|-----|
| Check email + calendar + weather | Heartbeat (batch) |
| Post to LinkedIn at 10am MWF | Cron |
| Morning briefing at 8am | Cron |
| "Remind me in 30 minutes" | Cron (one-shot) |
| Monitor for urgent messages | Heartbeat |
| Weekly content generation | Cron |
| Background maintenance | Cron |

**Rule of thumb:** Batch similar periodic checks into `HEARTBEAT.md` instead of creating multiple cron jobs. Use cron for precise schedules and standalone tasks.

## Cron Job Configuration

### Schedule Types

```json
// One-shot at a specific time
{ "kind": "at", "at": "2026-03-17T14:00:00-04:00" }

// Recurring interval
{ "kind": "every", "everyMs": 3600000 }  // every hour

// Cron expression
{ "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York" }  // 8am ET daily
```

### Payload Types

```json
// System event (injects into main session)
{
  "kind": "systemEvent",
  "text": "Time to check email and calendar"
}

// Agent turn (runs in isolated session)
{
  "kind": "agentTurn",
  "message": "Check for unread email, summarize anything urgent",
  "model": "anthropic/claude-haiku-4-5"
}
```

**Critical constraint:** `sessionTarget: "main"` requires `payload.kind: "systemEvent"`. `sessionTarget: "isolated"` requires `payload.kind: "agentTurn"`.

### Full Example: Morning Briefing

```json
{
  "name": "morning-briefing",
  "schedule": {
    "kind": "cron",
    "expr": "0 8 * * 1-5",
    "tz": "America/New_York"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Generate a morning briefing: check email for urgent items, review calendar for today, check weather. Keep it concise.",
    "model": "openai-codex/gpt-5.4:cron"
  },
  "delivery": {
    "mode": "announce",
    "to": "telegram:YOUR_USER_ID"
  },
  "sessionTarget": "isolated",
  "enabled": true
}
```

**Two critical fields here:**

- `model: "openai-codex/gpt-5.4:cron"` routes through the `thinking: low` alias. Same model as main, less thinking budget — perfect for mechanical briefing work.
- `delivery.to: "telegram:<user_id>"` is explicit. **Always set this.** Bare `"mode": "announce"` with multiple channels enabled guesses wrong and posts to whichever channel the bot *isn't* in. (Incident: 2026-03-02. We patched all 20 cron configs with explicit targets the same day.)

## Model Assignment for Cron Jobs

Not every cron job needs the same thinking budget. Match the model and alias to the task:

| Task | Recommended Model | Why |
|------|------------------|-----|
| Email triage | `gpt-5.4:cron` (thinking low) | Mechanical scanning, latency-sensitive |
| Morning briefing | `gpt-5.4:cron` | Summarization, no deep reasoning |
| Backup reports | `gpt-5.4:cron` | Status checking, minimal reasoning |
| Job search scanning | `gpt-5.4:cron` | Filtering, classification |
| Code reviews | `gpt-5.4` (thinking medium) | Structured analysis |
| Memory sweep | `gpt-5.4` | Read + distill, needs some judgment |
| Research-heavy pipelines | `gpt-5.4:cron` + browser research skill | Skill pulls findings from Perplexity Pro / Gemini web via Playwright |
| Weekly content polish | `acpx/claude-opus-4-6` via sub-agent spawn | Voice and taste |
| Creative drafts (public-facing) | Spawn `acp-claude`, don't cron directly | Opus via ACP is a spawn target, not a primary |

### The `:cron` Alias

`openai-codex/gpt-5.4:cron` is the same model as `gpt-5.4` with `thinking: low`. Defined in `agents.defaults.models`:

```json
{
  "openai-codex/gpt-5.4:cron": {
    "alias": "gpt54cron",
    "params": { "thinking": "low" }
  }
}
```

Use this alias for 80% of your cron jobs. The medium thinking budget is wasteful for most scheduled work.

### Model Assignment Gotchas

1. **Don't put Opus in a cron directly.** Opus runs via ACP as an escalation target, not a primary cron model. If a cron needs Opus quality, have it run a coder pass on GPT 5.4, then the *result* spawns an `acp-claude` polish pass. Keeps the Opus quota targeted.

2. **Small local models fail silently on reasoning.** We tested qwen3:8b for cron triage and its thinking mode burned all 512 output tokens on internal reasoning, producing empty responses. Test local models with your actual cron prompts before scheduling.

3. **GPT 5.3 Codex has a rate limit bug.** It can show 0% weekly usage while returning rate-limit errors. Resets overnight (~3:45 AM). If Codex is broken, coder tasks fail with `FailoverError`. Keep your fallback chain populated (see [multi-model orchestration](../configuration/multi-model-orchestration.md)).

## Heartbeat Configuration

### HEARTBEAT.md

Keep this file small and focused. It gets loaded every heartbeat cycle (30 min default), so token efficiency matters.

```markdown
# HEARTBEAT.md
Reply HEARTBEAT_OK unless something needs immediate attention.
Do NOT run health checks (nightly cron handles that at 4am).
Do NOT read memory files or do background work.
Minimum tokens. Just ack.
```

### Heartbeat Batching

Instead of separate cron jobs for email, calendar, weather, and notifications, batch them into the heartbeat cycle:

**Bad (5 separate cron jobs = 5 context loads):**
```
8:00 - Check email (Haiku)
8:05 - Check calendar (Haiku)  
8:10 - Check weather (Haiku)
8:15 - Check notifications (Haiku)
8:20 - Check social mentions (Haiku)
```

**Good (1 heartbeat = 1 context load):**
```
HEARTBEAT.md:
On morning heartbeat (first after 7am):
- Check email for urgent items
- Review calendar for today
- Note any social mentions
Report all findings in one message.
```

Five separate sessions cost 5x the input tokens for system prompt + context loading. One batched heartbeat costs 1x.

### Tracking Heartbeat State

Avoid duplicate checks by tracking what was already done:

```json
// memory/heartbeat-state.json
{
  "lastChecks": {
    "email": 1710672000,
    "calendar": 1710658400,
    "weather": null
  }
}
```

Read this at heartbeat time, skip checks done recently, update timestamps after each check.

## Example Schedule (Real Production)

Here's what a real OpenClaw cron schedule looks like:

| Time | Task | Model | Session |
|------|------|-------|---------|
| 3:00 AM | Daily backup verification | Haiku | Isolated |
| 4:00 AM | Nightly security audit | Haiku | Isolated |
| 8:00 AM | Morning briefing + email | Haiku | Isolated |
| 9:00 AM | Token usage report (weekly) | Haiku | Isolated |
| 10:00 AM MWF | LinkedIn content drafts | Opus | Isolated |
| 2:00 PM | Afternoon check-in | System event | Main |
| 6:00 PM | Memory sweep | Codex | Isolated |
| 9:00 PM | Daily standup summary | Haiku | Isolated |

Plus heartbeats every 30 minutes for quick checks and opportunistic maintenance.

## Error Handling

### Silent Failures

Cron jobs can fail without anyone noticing. Common causes:
- Model rate limit hit (job queued but never runs)
- Network timeout during API call
- Job produces empty output (model burned tokens on reasoning, nothing left for response)

### Monitoring Pattern

Check cron health periodically:

```bash
# List all jobs with status
openclaw cron list

# Check recent run history for a specific job
openclaw cron runs <jobId>
```

Look for:
- Jobs with no recent runs (stuck or disabled)
- Jobs with consistent failures (wrong model, bad prompt)
- Jobs with empty outputs (model token budget too low)

### Delivery Configuration

Control where cron output goes:

```json
{
  "delivery": {
    "mode": "announce",
    "to": "telegram:123456789",
    "bestEffort": true
  }
}
```

Options:
- `"none"`: Run silently, no output delivery
- `"announce"`: Send results to a specific chat target
- `"webhook"`: POST results to a URL

**Always set `to`.** The fields `channel` and vague `mode: "announce"` routing are not reliable when multiple channels are enabled — the gateway will pick a channel the bot isn't in and the message disappears. Format is `"telegram:<user_id>"`, `"discord:<channel_id>"`, or `"signal:<contact>"`.

## Quiet Hours

Respect your own schedule. Don't fire cron announcements at 3am unless they're urgent:

- Set backup/maintenance crons to `delivery: "none"` or log-only
- Reserve `delivery: "announce"` for tasks during waking hours
- Use system events for urgent-only notifications outside hours

## Multi-Line Scripts: Use Heredocs

For cron jobs whose `message` is a multi-line script or prompt, store it as a heredoc file on disk and reference it. JSON-embedded multi-line strings get escape-mangled and fail to parse cleanly:

```bash
cat > ~/.openclaw/workspace/cron-prompts/morning-briefing.md <<'EOF'
You are running as the morning-briefing cron job.

Steps:
1. Check email for urgent items (last 12h)
2. Summarize calendar for today
3. Check weather for Tampa, FL
4. Format as a tight bulleted briefing

Keep under 200 words. End with NEXT: <one-line priority>.
EOF
```

Then in the cron payload, read from the file at turn time rather than inlining. This also means you can iterate on the prompt without re-editing `openclaw.json`.

## Elevated Cron Jobs

Cron jobs that need to exec commands (run scripts, touch files, call local APIs) require `elevated: true` at the job level:

```json
{
  "name": "backup-restic",
  "schedule": { "kind": "cron", "expr": "0 3,15 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run ~/.openclaw/workspace/scripts/backup-restic.sh and report status.",
    "model": "openai-codex/gpt-5.4:cron"
  },
  "elevated": true,
  "delivery": { "mode": "announce", "to": "telegram:YOUR_USER_ID" },
  "sessionTarget": "isolated"
}
```

Without `elevated: true`, the cron session inherits the default sandbox and `exec` will deny the command.

## Verification

```bash
# List all active cron jobs
openclaw cron list

# Check for jobs with stale/failing runs
openclaw cron runs <jobId> --limit 10

# Audit delivery targets — every job should have an explicit "to"
openclaw cron list --json | jq '.[] | select(.delivery.mode == "announce" and .delivery.to == null) | .name'
# Expected output: nothing. Any name listed is a routing-roulette risk.

# Verify heartbeat config
cat ~/.openclaw/workspace/HEARTBEAT.md
```

## Gotchas

1. **Heartbeat model matters.** If your heartbeat runs on the main model (Opus), each 30-minute ack costs frontier-model input tokens just to say "nothing to do." Consider whether your heartbeat needs the main model or could run cheaper.

2. **Cron timezone confusion.** Always specify `tz` in cron schedules. Without it, times are UTC. "9am" without a timezone is 9am UTC, not 9am your local time.

3. **One-shot crons don't repeat.** `kind: "at"` fires once and is done. If you want recurring, use `kind: "cron"` or `kind: "every"`.

4. **Isolated sessions start cold.** Cron jobs with `sessionTarget: "isolated"` don't have your conversation history or memory loaded (unless the prompt explicitly asks to search memory). They get workspace files but no session continuity.

5. **Don't create cron jobs for what heartbeats handle.** If you need "check X every so often and report if something's wrong," that's a heartbeat task. Cron is for "do Y at exactly Z time."

6. **Bare `announce` without `to` is a routing coin-flip.** With both Telegram and Discord enabled, the gateway guesses — and we've confirmed the guess is wrong often enough to treat it as a bug. Always set `"to": "<channel>:<target_id>"`.

7. **Haiku is no longer in the cron roster.** Older versions of this guide recommended Anthropic Haiku for cheap cron work. That path went away with the [claude-cli removal](../configuration/claude-cli-to-acp-migration.md). `gpt-5.4:cron` (thinking low) is the current equivalent and stays on the same subscription envelope as your main agent.

8. **Sub-agents spawned from cron can find destructive API endpoints.** Incident (2026-03-02): Haiku cron found and called `DELETE /api/index` on a local API three times unprompted, wiping 71K indexed chunks. It read the OpenAPI spec, saw a destructive route, and used it. Lock down your local APIs before giving any cron subagent `exec` or HTTP access. See [agent security hardening](../security/agent-security-hardening.md).
