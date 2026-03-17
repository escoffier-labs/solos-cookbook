# Cron Job Patterns

How to schedule automated tasks in OpenClaw, assign the right model to each job, batch checks into heartbeats, and avoid the pitfalls that waste tokens and break silently.

**Tested on:** OpenClaw with 15+ active cron jobs across Opus, Codex, and Haiku
**Last updated:** 2026-03-17

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
    "model": "anthropic/claude-haiku-4-5"
  },
  "delivery": {
    "mode": "announce"
  },
  "sessionTarget": "isolated",
  "enabled": true
}
```

## Model Assignment for Cron Jobs

Not every cron job needs your most expensive model. Match the model to the task:

| Task | Recommended Model | Why |
|------|------------------|-----|
| Email triage | Budget (Haiku) | Mechanical scanning |
| Morning briefing | Budget (Haiku) | Summarization, no judgment needed |
| Content drafts | Frontier (Opus) | Creative, needs voice and quality |
| Code reviews | Code-specialized (Codex) | Structured analysis |
| Backup reports | Budget (Haiku) | Status checking |
| Job search scanning | Budget (Haiku) | Filtering and matching |
| Memory sweep | Code-specialized (Codex) | Needs to read and distill |
| Weekly content | Frontier (Opus) | Creative, strategic |

### Model Assignment Gotchas

1. **Small local models can fail silently.** We tested qwen3:8b for cron tasks and its thinking/reasoning mode burned all 512 output tokens on internal reasoning, producing empty responses. If using local models, test with your actual cron prompts first.

2. **Budget models hedge on triage.** phi4-mini is fast (71 t/s) but gives ambiguous KEEP/SKIP/URGENT decisions. Not suitable for automated pipelines that need clean classifications.

3. **14B models are overkill for most cron tasks.** Save them for code review and complex analysis. A 7-9B model handles email triage and status checks fine.

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
    "mode": "announce",        // Send to chat channel
    "channel": "telegram",     // Specific channel
    "bestEffort": true         // Don't fail if delivery fails
  }
}
```

Options:
- `"none"`: Run silently, no output delivery
- `"announce"`: Send results to configured chat channel
- `"webhook"`: POST results to a URL

## Quiet Hours

Respect your own schedule. Don't fire cron announcements at 3am unless they're urgent:

- Set backup/maintenance crons to `delivery: "none"` or log-only
- Reserve `delivery: "announce"` for tasks during waking hours
- Use system events for urgent-only notifications outside hours

## Verification

```bash
# List all active cron jobs
echo "=== Active Cron Jobs ==="
# Use the cron tool to list jobs
# openclaw cron list

# Check for jobs with no recent successful runs
echo ""
echo "=== Job Health ==="
# openclaw cron runs <jobId> --limit 5

# Verify heartbeat is running
echo ""
echo "=== Heartbeat Config ==="
cat ~/.openclaw/workspace/HEARTBEAT.md
```

## Gotchas

1. **Heartbeat model matters.** If your heartbeat runs on the main model (Opus), each 30-minute ack costs frontier-model input tokens just to say "nothing to do." Consider whether your heartbeat needs the main model or could run cheaper.

2. **Cron timezone confusion.** Always specify `tz` in cron schedules. Without it, times are UTC. "9am" without a timezone is 9am UTC, not 9am your local time.

3. **One-shot crons don't repeat.** `kind: "at"` fires once and is done. If you want recurring, use `kind: "cron"` or `kind: "every"`.

4. **Isolated sessions start cold.** Cron jobs with `sessionTarget: "isolated"` don't have your conversation history or memory loaded (unless the prompt explicitly asks to search memory). They get workspace files but no session continuity.

5. **Don't create cron jobs for what heartbeats handle.** If you need "check X every so often and report if something's wrong," that's a heartbeat task. Cron is for "do Y at exactly Z time."
