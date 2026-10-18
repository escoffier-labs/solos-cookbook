# Sub-Agent Patterns: Orchestration, Spawning, and Gotchas

How to use OpenClaw sub-agents effectively. Spawn patterns, model assignment, error handling, and the lessons we learned from breaking things.

**Tested on:** OpenClaw 2026.10.4 (main on GPT 6.1 Sol, `browser-operator` on GPT 6 Luna), brigade 0.28.0 worker seats, Claude Code 2.1.302 via tmux relay, ACPX 0.19.x, T3 Code delegated tasks
**Last updated:** 2026-10-17

---

## Why Sub-Agents

Your main agent carries heavy context (memory, personality, conversation history) and is on the path of every incoming message. Sub-agents are isolated and disposable. They start clean, do one job, and report back.

**Use sub-agents when:**
- The task is mechanical (scan files, generate boilerplate, run searches)
- The task doesn't need your main session's context
- You want parallel execution
- You want to escalate to a higher-quality model for a specific review task

**Keep on the main agent when:**
- The task requires conversation context or memory
- It involves security decisions or untrusted input
- It's a quick one-liner that doesn't justify the spawn overhead

**Where sub-agents live now.** There are two layers, and most of the work moved to the second:

1. **In-gateway sub-agents** (`sessions_spawn`, `sessions_send`). OpenClaw runs them in the same gateway as the main agent. I keep one real specialist here, a `browser-operator` agent with a minimal tool profile. The default sub-agent model is GPT 6 Luna and the gateway allows 8 concurrent.
2. **Worker seats outside the gateway.** `brigade run` dispatches to roster seats (Codex, Claude, Antigravity, and others), and T3 Code sessions can launch delegated child tasks on any connected host. Building, refactoring, review, and research go here, because each seat has its own session, worktree, and artifact trail.

The earlier "coder" and "researcher" gateway agents are gone. A gateway sub-agent is the right tool for a narrow job that needs OpenClaw's own tools and channel context. A seat is the right tool for repo work. Prefer the [tmux relay](claude-code-tmux-relay.md) or a Claude seat for review escalation. Keep [ACP escalation](claude-cli-to-acp-migration.md) for setups that explicitly need ACP.

## Spawn Patterns

### Pattern 1: Fire-and-Forget

Spawn a sub-agent for a task you don't need immediate results from. The sub-agent runs asynchronously and announces completion to the user.

```
sessions_spawn(
  agentId: "browser-operator",
  task: "Open the status page and export the incident table as CSV.",
  runTimeoutSeconds: 600
)
```

Repo-scale equivalent on the worker fleet, detached so the orchestrator is not blocked:

```bash
brigade run --worker luna6 --read-only --detach \
  "Scan all Python files in /project for hardcoded credentials. Report findings."
```

**Use when:** Background tasks, long-running scans, builds you'll check later.

**Gotcha:** You can't chain dependent tasks this way. The main agent doesn't see the sub-agent's output.

### Pattern 2: Send-and-Wait

Send a message to a persistent sub-agent session and block until it responds. Results come back inline.

```
sessions_send(
  agentId: "browser-operator",
  message: "Open the dashboard and tell me the current build status.",
  timeoutSeconds: 120
)
```

**Use when:** You need the result to continue your workflow. The main agent blocks, gets the result, and processes it in the same turn.

**Timeout guidelines:**
- Browser page loads and simple extraction: 60s
- Multi-page browser flows: 120s
- Simple commands: 30s
- Anything longer belongs on a Brigade seat, not a blocking send

### Pattern 3: Background Agent with Wrapper

For long-running coding agents or relay commands that might crash silently, use a wrapper script that guarantees notification on completion or failure.

```bash
#!/bin/bash
# agent-wrapper.sh - Always notifies, even on crash
LABEL="$1"
shift
START=$(date +%s)

"$@"
EXIT_CODE=$?

DURATION=$(( $(date +%s) - START ))
if [ $EXIT_CODE -eq 0 ]; then
  openclaw system event --text "${LABEL} completed in ${DURATION}s" --mode now
else
  openclaw system event --text "${LABEL} failed (exit ${EXIT_CODE}) after ${DURATION}s" --mode now
fi
```

Usage with the Claude Code tmux relay:
```bash
agent-wrapper.sh "claude review" \
  templates/ai-stack/claude-tmux-relay.sh send-file /tmp/claude-review-prompt.txt
```

**Why this exists:** Background coding agents and relay scripts can fail silently. The "I'll run an openclaw system event when done" trick fails because the agent dies before executing it. The wrapper captures the exit code and ALWAYS fires the notification, whether the command succeeds or crashes.

**Rule:** Never spawn a background coding agent without the wrapper. No exceptions.

## Model Assignment for Sub-Agents

### Configure Agents in openclaw.json

On 2026.10 agents live under `agents.entries` (not `agents.list`), with `agents.ownership` set to `explicit`. Mine are `main` and `browser-operator`:

```json
{
  "agents": {
    "defaults": {
      "subagents": { "maxConcurrent": 8, "archiveAfterMinutes": 60, "model": "openai/gpt-6-luna" }
    },
    "ownership": "explicit",
    "entries": {
      "main": {
        "model": { "primary": "openai/gpt-6.1-sol", "fallbacks": [] },
        "subagents": { "allowAgents": ["browser-operator", "main"] }
      },
      "browser-operator": {
        "model": { "primary": "openai/gpt-6-luna", "fallbacks": [] },
        "thinkingDefault": "low",
        "skills": ["browser-automation"],
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["browser", "browser_credential_fill"],
          "elevated": { "enabled": false }
        }
      }
    }
  }
}
```

`subagents.allowAgents` on the parent is the spawn allowlist: `main` can spawn `browser-operator` and itself, nothing else. Model aliases (`sol61`, `luna6`) are defined in `agents.defaults.models`. See [multi-model orchestration](multi-model-orchestration.md) for the full alias setup.

Claude review is not modeled as a fake gateway agent. Launch it through a Brigade seat or the tmux relay script so Claude stays inside the first-party harness.

### Assignment Rules

| Task Type | Target | Why |
|-----------|--------|-----|
| Browser flows against a logged-in session | `browser-operator` sub-agent | Minimal tool profile, credential fill brokered, Luna is enough |
| Routine implementation, triage | Brigade `luna6` seat | Cheap, isolated worktree |
| Harder implementation slices | Brigade `sol61` seat | Same family as the orchestrator, higher reasoning |
| Fast read-only scouting and research | Gemini Flash seat via Antigravity, or a read-only Luna seat | Keeps orchestrator quota for judgment |
| Building, drafting, QA with Claude | Sonnet 5.5 seat | Default Claude worker |
| Architecture, final review, disputed calls | Opus 5.5 seat or tmux relay | Stronger judgment on tradeoffs |
| Security review | Dedicated security-review seat | Separate route, independent of the builder |
| Second and third opinions | Fable 5.1 or GPT 6 Astra | Different model families catch different mistakes |
| Security evaluation of untrusted input | main | Orchestrator handles untrusted input |
| Quick one-liners | main | Not worth spawn overhead |

The roster file decides which of those seats are enabled on a given day, so check before promising one.

### T3 Code delegated tasks

When the orchestrator is a T3 Code session, `delegate_task` launches a child task in its own session, and the fleet client can launch, monitor, steer, and recover child sessions on any connected host. Use it for Claude or Codex work that benefits from its own worktree. The same rules as every other sub-agent apply: bounded task, explicit model, a stated terminal state. Set the model on every dispatch instead of inheriting the session default, which is how an expensive model ends up doing grunt work.

### Pre-Flight Check

Verify your agent configuration matches what you expect before spawning:

```bash
jq '.agents.entries | map_values(.model.primary)' ~/.openclaw/openclaw.json
# Expected: main on openai/gpt-6.1-sol (it may carry an @auth-profile suffix), browser-operator on openai/gpt-6-luna

brigade fleet models list
# Expected: seat table with enabled yes/no per seat
```

We've been burned multiple times by agent misconfigurations:
- Spawned Opus on ACP for a job a Codex seat could have handled, wasting quota
- A coder agent was on a stale alias after an OpenClaw upgrade reset plugin config
- A one-time provider 503 on the primary model pinned a cron channel to its fallback for four days via the `auto` override system. `/reset` didn't clear it. I had to `/model` pin it back as a `user` source override.

Always check before assuming. After any OpenClaw upgrade, re-verify `agents.entries` and `plugins.entries`. Both have been observed to reset.

## Sub-Agent Isolation

### What Sub-Agents Can't Do

Isolated sub-agents in OpenClaw have limitations:

- **No git/gh CLI** in sandboxed sessions. Use sub-agents for file writing, then push from the main session. Brigade seats run in a real checkout (or a detached worktree with `--worktree`) and can run git.
- **No access to main session context.** They don't see your conversation history, memory, or personality files.
- **No host tools** unless explicitly configured. Host exec through the `elevated` tool policy must be enabled per agent (the browser agent above has `elevated.enabled: false`).

### What Sub-Agents Are Good At

- Starting clean (no context baggage)
- Running cheaper models on mechanical tasks
- Parallel execution (multiple sub-agents at once)
- Failure isolation (a crashed sub-agent doesn't kill your main session)

## Error Handling

### Sub-Agent Failures Are Silent by Default

If a sub-agent crashes, the main agent might never know. This is why the wrapper script pattern exists. For gateway sub-agents spawned via `sessions_spawn`, OpenClaw announces completion or failure, but timeouts and edge cases can cause silent drops. For Brigade runs, the run directory under `.brigade/runs/<id>` holds the artifacts and the exit state, and `--detach` writes run metadata before returning.

### Timeout Strategy

Set appropriate timeouts and handle them:

```
# Short task - fail fast
sessions_send(agentId: "browser-operator", message: "...", timeoutSeconds: 30)

# Long task - generous timeout
sessions_send(agentId: "browser-operator", message: "...", timeoutSeconds: 300)
```

If a task times out, it might still be running. Check with:
```
subagents(action: "list")
```

Cancel a stuck run (and its descendants) by run id:
```
subagents(action: "cancel", runId: "<run-id>")
```

A wait timeout on `subagents` never cancels execution.

## Orchestration Patterns

### Sequential Pipeline

Main agent writes spec, dispatches a seat, reviews output:

```
1. Main: Write detailed spec for API routes
2. Main: brigade run --worker sol61 --worktree "<spec>"
3. Main: Review the changes.patch artifact
4. Main: Fix issues or approve and merge
```

### Parallel Fan-Out

Multiple workers at once. Let Brigade plan and synthesize when the pieces are independent:

```
1. brigade run "Build the frontend and backend for X, and gather the API docs"
   → plans assignments, dispatches seats in parallel (scheduler: dag),
     synthesizes one answer
2. Main: integrate and review
```

A repository claim on the fleet hub prevents two runs from editing the same repo at once. `brigade fleet claims` lists live claims, and a live claim is ownership: wait for it instead of working around it.

### Triage Escalation (Three Tiers)

A cheap lane screens, the orchestrator handles most work, and a Claude seat gets the quality-critical review tasks:

```
1. Luna-pinned cron job: screen incoming email - SKIP or ESCALATE
2. If ESCALATE: Main (Sol 6.1) reads and processes
3. If action needed:
   - Mechanical/code work → main dispatches a Brigade seat
   - Design/review/security analysis → main dispatches the Opus seat or a bounded tmux prompt
   - Research → read-only seat or the browser skill
```

### Claude Code tmux Escalation Pattern

To reach Claude for review through a recoverable session, start or reuse a tmux session and send a bounded prompt:

```bash
CLAUDE_TMUX_SESSION=claude-code-review \
CLAUDE_WORKSPACE=/path/to/repo \
CLAUDE_PERMISSION_MODE=plan \
templates/ai-stack/claude-tmux-relay.sh start

templates/ai-stack/claude-tmux-relay.sh send \
  "Review this architecture for hidden failure modes, unclear ownership boundaries, and risky assumptions. Return structured notes with priorities. Do not edit files."

templates/ai-stack/claude-tmux-relay.sh capture -200
```

For one-shot reviews, put the prompt in a file and use `send-file`. `claude --print` works for simple scripted calls: pin `--model opus`, keep it to one flat pass, and pass `Task` and `Agent` through `--disallowedTools`. The relay gives you recoverable sessions.

ACP remains a compatibility path when OpenClaw needs a formal ACP endpoint. The tmux relay has no access to your main agent's conversation history, so pass all necessary context in the prompt itself.

**When to escalate:** Design, PR review that needs taste, security analysis, architecture decisions.
**When NOT to escalate:** Code generation, file scanning, bulk ops, anything mechanical. A Sol or Luna seat handles those faster without burning Claude quota.

## Verification

```bash
# Check configured agents
echo "=== Agent Configuration ==="
jq '.agents.entries | map_values({model: .model.primary, elevated: (.tools.elevated.enabled // false)})' \
  ~/.openclaw/openclaw.json

# Check fallback chain and sub-agent defaults
echo ""
echo "=== Fallback Chain and Sub-agent Defaults ==="
jq '{model: .agents.defaults.model, subagents: .agents.defaults.subagents}' ~/.openclaw/openclaw.json

# Check the worker fleet
echo ""
echo "=== Brigade seats ==="
brigade fleet models list | head -10

# Check Claude Code tmux relay
echo ""
echo "=== Claude Code tmux ==="
tmux has-session -t claude-code-review && echo "tmux review session present" || echo "tmux review session not running"
test -x templates/ai-stack/claude-tmux-relay.sh && echo "relay template present"

# Check ACP plugin only if you still use ACP compatibility
echo ""
echo "=== ACPX compatibility ==="
jq '.plugins.allow | index("acpx") != null' ~/.openclaw/openclaw.json 2>/dev/null || true
test -x ~/.openclaw/vendor/acpx/node_modules/.bin/acpx && echo "acpx binary present" || true

# Check for wrapper script
echo ""
echo "=== Agent Wrapper ==="
if [ -f ~/.openclaw/workspace/scripts/agent-wrapper.sh ]; then
  echo "agent-wrapper.sh exists"
else
  echo "agent-wrapper.sh not found: background agents will fail silently"
fi
```

## Gotchas

1. **Don't spawn dependent sub-agents without coordination.** Sub-agent A's output isn't automatically available to sub-agent B. Use the send-and-wait pattern, or one Brigade run, for sequential dependencies.

2. **Batch git operations.** If multiple workers produce files, collect them in the main session and do one commit/push. Don't have workers fighting over git. `--worktree` gives each run an isolated tree and a `changes.patch` to review.

3. **Sandbox limitations are per-agent.** The main agent might have broad exec while sub-agents have a minimal tool profile. A task that works in the main session might fail in a sub-agent because of missing permissions.

4. **Context isolation is a feature, not a bug.** Sub-agents starting clean means they don't carry your 50K token conversation history. This is good for token efficiency and bad for tasks that need context. Choose the right pattern for the job.

5. **Auto-announce goes directly to the user.** Fire-and-forget sub-agent output is announced to the user (via Telegram, Discord, etc.), not returned to the main agent. If you need the result in the main agent's workflow, use send-and-wait instead.

6. **Auto-announce doesn't trigger a parent turn.** When a sub-agent finishes and auto-announces, the result appears in the main agent's transcript but does NOT trigger a new inference turn. If the main says "I'll do X when it gets back," it structurally can't follow through without another message. Chain via send-and-wait, or have the user nudge.

7. **Tool narration instead of tool calls.** The orchestrator model occasionally narrates what it's about to do ("I'm running the build now") instead of calling the tool. The `tool-narration-guard` plugin catches this with run-level tracking and `prependContext` injection. See [GPT 6.1 Sol orchestration](gpt-55-orchestration.md).

8. **`executionContract` is not a substitute for the guard.** `strict-agentic` is set in my agent defaults, but the 2026.10.4 build only treats `gpt-5` family ids as supported, so it does nothing for GPT 6 models. Details in the Sol orchestration guide.
