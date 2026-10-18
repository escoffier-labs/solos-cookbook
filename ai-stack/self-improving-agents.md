# Self-Improving Agents

How to build an AI agent that learns from corrections, captures mistakes as institutional knowledge, runs automated memory sweeps, and gets better over time instead of repeating the same errors.

**Tested on:** OpenClaw 2026.10.4 with GPT 6.1 Sol (main) and GPT 6 Luna (memory sweep), tool-narration-guard plugin, Brigade 0.28.0
**Last updated:** 2026-10-17

---

## The Problem

AI agents wake up fresh every session. They have no memory of what they did wrong yesterday. Without a system for capturing and surfacing corrections, you'll give the same feedback over and over:

- "Stop pushing directly to main"
- "Don't use em dashes"
- "Check what's already loaded before searching"
- "Stop narrating what you're about to do - just call the tool"
- "Check the PR state before pushing follow-ups"

Each correction costs you time and tokens. A self-improving agent captures corrections once and applies them forever.

Three complementary mechanisms: **content memory** (what you correct), **plugin hooks** (what the agent catches itself doing wrong in real time), and a **review queue** for turning repeated corrections into skills. This guide covers all three.

## Architecture: Three Feedback Loops

### Loop 1: Immediate Capture (Every Correction)

When you correct your agent mid-conversation, the agent should:

1. **Fix the immediate issue**
2. **Write a knowledge card** documenting what went wrong and the correct approach
3. **Apply the correction** for the rest of the session

#### Detection Triggers

Train your agent to recognize corrections:
- "No, do it this way..."
- "I told you not to..."
- "That's wrong because..."
- "Stop doing X"
- "Why did you..."
- Any pushback that changes the agent's approach

#### Knowledge Card Format

```markdown
---
topic: "Correction: Always Use Feature Branches"
category: lessons
tags: [correction, git, workflow]
created: 2026-03-17
---

## What Happened
Pushed a config change directly to main instead of creating a PR.

## Correct Approach
NEVER push to main. Always: branch → commit → PR → automated review → merge.
PRs get CodeRabbit and Greptile reviews automatically.

## Why It Matters
Direct pushes bypass code review. Even "simple" changes can break things.
The review pipeline catches issues before they hit production.
```

Cards should be specific, actionable, and searchable. "Don't do X, do Y instead, because Z."

### Loop 2: Periodic Promotion (Weekly)

During maintenance (heartbeats or scheduled cron), review recent correction cards and promote recurring patterns:

| If the correction... | Promote to... |
|----------------------|--------------|
| Applies broadly across all tasks | AGENTS.md (core operating rules) |
| Is domain-specific (git, writing, security) | `rules/<domain>.md` |
| Has happened 3+ times | Definitely promote, with emphasis |
| Was a one-time thing | Leave as knowledge card only |

#### Promotion Example

Three separate corrections about token waste:

```
Card 1: Burned tokens debugging infra when they were about to expire
Card 2: Spawned Opus for a task Haiku could handle
Card 3: Loaded full memory file instead of searching
```

Promoted rule in AGENTS.md:
```markdown
## Token Discipline
- Expiring tokens are use-it-or-lose-it. Ship content, don't debug infra.
- Use the cheapest model that handles the task. Pre-flight check agent mappings.
- Search memory, don't load it. Semantic search returns what you need.
```

### Loop 3: Pre-Task Self-Audit (Every Task)

Before starting work, the agent should check:

1. **Have I been corrected on something like this before?** (search memory for similar tasks)
2. **Does this match a known anti-pattern?** (check lessons cards)
3. **Am I about to do something explicitly prohibited?** (check rules files)

Add this to your AGENTS.md:

```markdown
## Self-Audit Before Every Task
Before completing any task, ask yourself:
- Have I been corrected on something like this before? (search memory)
- Does this match a known anti-pattern?
- Am I about to do something the user has explicitly said not to do?
```

## Plugin Hooks: Catch Behaviors In-Flight

One plugin we run in production turns a specific correction pattern into an automatic guardrail. A second one, `tokenjuice`, is retired (see below).

### tool-narration-guard

**What it fixes:** GPT-class models sometimes narrate what they're *about* to do instead of actually calling the tool. "I'm running the build now" with no subsequent tool call. You notice 30 minutes later that nothing happened.

**How it works:** The plugin tracks runs at the session level. When it detects narration without a follow-up tool call in the same turn, it injects a `prependContext` rule on the next turn that forces the model to either call the tool or say "I can't." No more silent stalls.

**Enable:**

```json
{
  "plugins": {
    "allow": ["tool-narration-guard", "..."],
    "entries": {
      "tool-narration-guard": { "enabled": true }
    }
  }
}
```

The plugin lives at `~/.openclaw/workspace/.openclaw/extensions/tool-narration-guard/`. Load it via `plugins.load.paths`.

### `tokenjuice` (retired)

`tokenjuice` was a PostToolUse hook plugin that re-shaped tool output to reduce later-turn token burn. I measured it before deciding to keep it:

| Surface | Mode | n | Effect | Notes |
|---------|------|---|--------|-------|
| Claude Code | PostToolUse | 11 | +1.1% | Below noise floor, ignored |
| Codex | PostToolUse | 11 | -4.4% | Bimodal (27% retry on compound `cd && cmd`) |
| Pi | PostToolUse | 10 | -17.7% | Clean runs -25.3%, 30% compound-gap retry |

The gain only showed up on one surface, and Claude Code 2.1.113+ does not substitute `tool_result` from PostToolUse hooks (only `additionalContext` lands), so the Claude side could never match it. On 2026-10-01 I removed the Claude Code hook, and the plugin is now `enabled: false` in `plugins.entries`. I keep the table as history: if you re-enable a tool-output rewriter, measure it per surface first, because a flat average hides a bimodal retry cost.

## Error Detection & Learning Capture

Beyond corrections from the user, automate detection of errors in tool output.

### Error Patterns to Log

```
- Exit codes != 0
- "error:", "Error:", "ERROR"
- "command not found", "No such file or directory"
- "permission denied", "EACCES", "EPERM"
- "ECONNREFUSED", "ETIMEDOUT"
- "SyntaxError", "TypeError", "ImportError"
- HTTP 4xx/5xx responses
- "rate limit", "quota exceeded", "429"
- Timeout errors, OOM kills
- Git merge conflicts
```

### Structured Error Logging

Create a learning log that captures errors, corrections, and feature gaps:

```markdown
## [ERR-20260317-001] SSH socket override missing

**Logged**: 2026-03-17 08:15
**Priority**: high
**Status**: resolved
**Area**: infra

### Summary
ListenAddress in sshd_config ignored on Ubuntu 24.04 due to socket activation.

### Details
Set ListenAddress in sshd_config but SSH kept listening on 0.0.0.0.
Ubuntu 24.04 uses systemd socket activation. The socket unit overrides sshd_config.
Fix: create /etc/systemd/system/ssh.socket.d/override.conf

### Action
Always check for systemd socket activation before editing service configs.
On Ubuntu 24.04+, SSH is socket-activated by default.
```

### Entry Types

| Type | Prefix | When to Log |
|------|--------|-------------|
| Error | ERR | Tool output contains error patterns |
| Learning | LRN | User corrects approach, workaround found, assumption was wrong |
| Feature | FEAT | Missing capability identified, workflow gap found |

### Promotion Rules

- **3+ occurrences** of the same pattern: promote to AGENTS.md or rules file
- **Behavioral correction**: promote to rules file immediately
- **Workflow improvement**: promote to AGENTS.md
- Update original entry status to "promoted" when promoting

### The `.learnings/` directory

The structured log above lives in a `.learnings/` directory in the workspace, one markdown file per entry type:

```
.learnings/
├── ERRORS.md            # ERR entries
├── LEARNINGS.md         # LRN entries
└── FEATURE_REQUESTS.md  # FEAT entries
```

Keeping the three types in separate, predictably named files is what lets tooling read them: `brigade learn import-learnings` parses these files directly (see below).

### Productized Tooling: Brigade

The hand-rolled correction-capture loop described above now ships as first-class tooling in [Brigade](https://github.com/escoffier-labs/brigade). `brigade learn import-learnings` pulls structured ERR/LRN/FEAT entries into a reviewable store, and `brigade learn skill-candidates` clusters recurring corrections into proposed skills or rules. The key design choice: proposals are never auto-applied. Brigade surfaces candidates and you decide what gets promoted, which keeps a bad pattern from silently rewriting your AGENTS.md. If you would rather not maintain the scripts in this guide by hand, lean on Brigade for the import-and-cluster half and keep the promotion decision human.

`brigade learn propose-skill` turns a skill candidate into a reviewed proposal, and `brigade learn closeout` records whether a candidate was accepted, dismissed, archived, or deferred. Run `brigade learn --help` for the full list.

### Skill Workshop: agent-proposed skills

OpenClaw has its own queue for the same idea. With `skills.workshop.autonomous.mode` set to `"propose"`, the agent may draft a new skill or an update to a Workshop-generated skill, but the draft lands as a pending proposal instead of changing the skills directory. My live config:

```json
{
  "skills": {
    "workshop": {
      "approvalPolicy": "auto",
      "autonomous": { "mode": "propose" }
    }
  }
}
```

Review the queue with the `openclaw skills workshop` subcommands:

```bash
openclaw skills workshop list              # pending and completed proposals
openclaw skills workshop inspect <id>      # read one proposal
openclaw skills workshop evaluate <id>     # evaluate the exact current proposal
openclaw skills workshop apply <id>        # accept it
openclaw skills workshop reject <id>       # or reject / revise / quarantine
```

Propose mode is the same design call as Brigade's candidates: the agent notices the pattern, a human decides whether it becomes a skill. Apply is a separate step from proposing, so a bad proposal costs you a rejected entry, not a rewritten skill.

## Daily Memory Sweep

Set up an automated cron job that reviews recent sessions across all channels and distills important information into the memory system.

### Cron Configuration

This is the job shape I run (message abbreviated):

```json
{
  "name": "Memory Sweep - Session Review",
  "schedule": {
    "kind": "cron",
    "expr": "0 22 * * *",
    "tz": "America/New_York"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Review recent sessions across all channels. For each session:\n1. Identify significant decisions, corrections, or lessons\n2. Create or update knowledge cards for anything worth persisting\n3. Update daily log with session summaries\n4. Check for correction patterns that should be promoted to rules\n5. Skip trivial conversations (greetings, simple lookups)",
    "model": "openai/gpt-6-luna",
    "thinking": "low",
    "timeoutSeconds": 600
  },
  "delivery": { "mode": "announce", "channel": "discord", "to": "channel:<channel-id>" },
  "sessionTarget": "isolated"
}
```

It runs once a day at 22:00. The summary is announced to a chat channel so I can skim what got written without opening the vault.

### What the Sweep Does

1. **Pulls recent sessions** across Discord, Telegram, and any other configured channels
2. **Reads conversation history** for each session
3. **Extracts** decisions, corrections, errors, and new information
4. **Writes** knowledge cards for significant findings
5. **Updates** daily logs with session summaries
6. **Checks** for patterns that should be promoted to rules

### Model Selection

The sweep started on the main model at medium thinking (GPT 5.5 at the time), because early runs on a smaller model missed nuance. It now runs on GPT 6 Luna at low thinking and the last run completed cleanly in about 77 seconds. The prompt is a fixed extraction checklist and the run is isolated and bounded (600 second timeout), which is why the cheaper lane holds up. If cards start coming back shallow, raise `thinking` before you raise the model tier. Don't route the sweep through Claude Code: the escalation lane is for high-judgment review work, not back-office housekeeping.

## Real Corrections We've Captured

These are actual correction cards from production use, showing what the system catches:

### "Stop Building, Start Delegating"

**Trigger:** User noticed agent was hand-coding React components instead of writing specs and spawning Codex sub-agents.

**Card created:** Documents the correct workflow (main writes specs, Codex builds, Claude reviews when needed) and explicit rules against hand-coding when a code-specialized model is available.

**Promoted to:** AGENTS.md and SOUL.md core rules.

### "Check Context Before Searching"

**Trigger:** Agent ran `memory_search` to find information that was literally in its system prompt (SOUL.md was already loaded).

**Card created:** Documents the correct lookup order: system prompt → conversation history → memory search → ask user.

**Promoted to:** Self-audit checklist.

### "Expiring Tokens Are Use-It-Or-Lose-It"

**Trigger:** Agent spent 7 minutes debugging sub-agent infrastructure while API tokens were about to expire and reset. Should have written content directly instead.

**Card created:** Decision tree for expiring tokens (try sub-agents → if fail, write inline → debug later on fresh quota).

**Promoted to:** Token discipline rules.

### "Never Push to Main"

**Trigger:** Agent pushed directly to main branch, bypassing the PR pipeline with CodeRabbit and Greptile automated reviews.

**Card created:** Explicit rule: branch → commit → PR → review → merge. No exceptions. No "I'll PR it later."

**Promoted to:** AGENTS.md mandatory workflow rule.

## The Self-Audit Checklist

Add this to your AGENTS.md for your agent to reference before every task:

```markdown
## Pre-Task Self-Audit
1. Search memory for corrections related to this type of task
2. Check rules/*.md for domain-specific rules
3. Verify model assignment matches the task (don't use Opus for scanning)
4. Confirm output format matches platform (no markdown tables on Discord)
5. If it's a big task, ask clarifying questions before executing
6. Check if a similar task was done recently (avoid duplicate work)
```

## Verification

```bash
# Check that correction capture is working
echo "=== Knowledge Cards (Lessons) ==="
ls ~/.openclaw/workspace/memory/cards/ | grep -E "lesson|correction" | wc -l
echo "correction/lesson cards"

echo ""
echo "=== Rules Files ==="
ls ~/.openclaw/workspace/rules/ 2>/dev/null || echo "No rules directory"

echo ""
echo "=== Self-Improving Rules ==="
[ -f ~/.openclaw/workspace/rules/self-improving.md ] && echo "✓ self-improving.md exists" || echo "✗ self-improving.md missing"

echo ""
echo "=== AGENTS.md Self-Audit Section ==="
grep -c "self-audit\|Self-Audit\|self-improvement\|Self-Improvement" ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo "0 references"

echo ""
echo "=== Memory Sweep Cron ==="
openclaw cron list --json | jq -r '.jobs[] | select(.name|test("Memory Sweep")) | "\(.name)  model=\(.payload.model)  schedule=\(.schedule.expr)  last=\(.state.lastRunStatus)"'

echo ""
echo "=== .learnings Log ==="
ls ~/.openclaw/workspace/.learnings/ 2>/dev/null || echo "No .learnings directory"

echo ""
echo "=== Skill Workshop Mode ==="
jq -r '.skills.workshop.autonomous.mode' ~/.openclaw/openclaw.json
openclaw skills workshop list --agent main

echo ""
echo "=== tokenjuice (expect disabled) ==="
jq -r '.plugins.entries.tokenjuice.enabled' ~/.openclaw/openclaw.json
```

Expected: one `Memory Sweep` job line with a `last=ok` status, the three `.learnings` files, `propose` for the workshop mode (followed by whatever proposals are pending), and `false` for `tokenjuice`.

## Gotchas

1. **Corrections are perishable.** If you don't capture a correction immediately, it's gone next session. The agent literally won't remember. Write the card in the same conversation where the correction happens.

2. **Memory search quality depends on card quality.** Vague cards like "don't do bad things" won't surface when searching for specific issues. Be specific: "Don't use greedy regex to remove JS object blocks. Use line-by-line Python removal."

3. **Over-promotion clutters rules.** Not every one-off correction needs to be in AGENTS.md. Use the 3-occurrence threshold. One-time corrections stay as knowledge cards.

4. **The sweep model matters.** A budget model doing the memory sweep might miss nuance in conversations. A current hosted model (Luna at low thinking works for me) is better at structured extraction than a small local model.

5. **Corrections compound.** The first month of running a self-improving agent is noisy because there are lots of corrections. By month three, correction frequency drops significantly because the agent has internalized the patterns. The system works, but it takes time.

6. **Don't skip the pre-task search.** The whole system falls apart if the agent doesn't check for relevant corrections before starting work. Make the self-audit a non-negotiable part of AGENTS.md.

7. **Prompt-level guards don't scale. Hook-level guards do.** If a correction keeps surfacing, don't keep adding sentences to AGENTS.md - build (or enable) a plugin that makes the wrong behavior structurally impossible. `tool-narration-guard` is the canonical example.

8. **Validate memory before acting on it.** A memory card naming a specific file, function, or flag is a claim about a snapshot in time. Files get renamed, endpoints get removed. Before recommending something pulled from a memory card, grep for it or read the file. "The card says X exists" is not the same as "X exists now."

9. **A propose-mode queue needs a reviewer.** Skill Workshop proposals stay `pending` until someone applies or rejects them. Mine had ten waiting when I checked. If you never look at `openclaw skills workshop list`, propose mode is just a slower way of not having the skill.

10. **Retired plugins leave config behind.** `tokenjuice` is still listed under `plugins.allow` with `enabled: false`. That is harmless, but when you audit "what guards are running", read `plugins.entries.<name>.enabled`, not the allow list.
