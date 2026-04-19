# Sub-Agent Patterns: Orchestration, Spawning, and Gotchas

How to use OpenClaw sub-agents effectively. Spawn patterns, model assignment, error handling, and the lessons we learned from breaking things.

**Tested on:** OpenClaw with GPT 5.4 (main + coder), Gemini 3.1 Pro (researcher), Claude Opus 4.6 via ACP (escalation)
**Last updated:** 2026-04-19

---

## Why Sub-Agents

Your main agent carries heavy context (memory, personality, conversation history) and is on the path of every incoming message. Sub-agents are isolated and disposable. They start clean, do one job, and report back.

**Use sub-agents when:**
- The task is mechanical (scan files, generate boilerplate, run searches)
- The task doesn't need your main session's context
- You want parallel execution
- You want to escalate to a higher-quality model (e.g., ACP Opus) for a specific task

**Keep on the main agent when:**
- The task requires conversation context or memory
- It involves security decisions or untrusted input
- It's a quick one-liner that doesn't justify the spawn overhead

**Post-April-2026 note:** The main agent no longer has to be your "strongest" model. GPT 5.4 on Codex Pro is a fine orchestrator, and Opus-quality work happens via [ACP escalation](../configuration/claude-cli-to-acp-migration.md) when needed.

## Spawn Patterns

### Pattern 1: Fire-and-Forget

Spawn a sub-agent for a task you don't need immediate results from. The sub-agent runs asynchronously and announces completion to the user.

```
sessions_spawn(
  agentId: "coder",
  task: "Scan all Python files in /project for hardcoded credentials. Report findings.",
  mode: "run"
)
```

**Use when:** Background tasks, long-running scans, builds you'll check later.

**Gotcha:** You can't chain dependent tasks this way. The main agent doesn't see the sub-agent's output.

### Pattern 2: Send-and-Wait

Send a message to a persistent sub-agent session and block until it responds. Results come back inline.

```
sessions_send(
  agentId: "coder",
  message: "Search the code index for authentication middleware. Return file paths and line numbers.",
  timeoutSeconds: 120
)
```

**Use when:** You need the result to continue your workflow. The main agent blocks, gets the result, and processes it in the same turn.

**Timeout guidelines:**
- Code search queries: 120s
- File scanning/grep: 60s
- Simple commands: 30s
- Complex refactors: 300s

### Pattern 3: Background Agent with Wrapper

For long-running coding agents (Claude Code, Codex CLI) that might crash silently, use a wrapper script that guarantees notification on completion or failure.

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
  openclaw system-event "✅ ${LABEL} completed in ${DURATION}s"
else
  openclaw system-event "❌ ${LABEL} failed (exit ${EXIT_CODE}) after ${DURATION}s"
fi
```

Usage:
```bash
agent-wrapper.sh "dashboard build" claude --dangerously-skip-permissions -p "Build the dashboard according to spec.md"
```

**Why this exists:** Background coding agents crash silently. The "I'll run an openclaw system event when done" trick fails because the agent dies before executing it. The wrapper captures the exit code and ALWAYS fires the notification, whether the agent succeeds or crashes.

**Rule:** Never spawn a background coding agent without the wrapper. No exceptions.

## Model Assignment for Sub-Agents

### Configure Agents in openclaw.json

```json
{
  "agents": {
    "list": [
      { "id": "main",       "model": "openai-codex/gpt-5.4" },
      { "id": "coder",      "model": "gpt54" },
      { "id": "researcher", "model": "google-gemini-cli/gemini-3.1-pro-preview" },
      {
        "id": "acp-claude",
        "model": "acpx/claude-opus-4-6",
        "description": "Escalation target — resume, intel, design, review, humanize, academic work"
      }
    ]
  }
}
```

`gpt54` is an alias defined in `agents.defaults.models` that resolves to `openai-codex/gpt-5.4`. See [multi-model orchestration](../configuration/multi-model-orchestration.md) for the full alias setup.

### Assignment Rules

| Task Type | Agent | Why |
|-----------|-------|-----|
| File scanning, grep, counts | coder | Mechanical, doesn't need judgment |
| Code generation from specs | coder | Same model as main, but with isolated context |
| Code reviews | coder | Structured analysis |
| Research, web analysis | researcher | 1M+ context on Gemini CLI |
| Resume/CV work | acp-claude | Opus quality, escalation lane |
| Design critique, humanize passes | acp-claude | Opus voice |
| PR review requiring taste | acp-claude | Beyond mechanical correctness |
| Long-form academic work | acp-claude | Reasoning depth |
| Security evaluation | main | Orchestrator handles untrusted input |
| Quick one-liners | main | Not worth spawn overhead |

### Pre-Flight Check

Always verify your agent configuration matches what you expect before spawning:

```bash
jq '.agents.list | map({id, model})' ~/.openclaw/openclaw.json
```

We've been burned multiple times by agent misconfigurations:
- Spawned Opus on ACP for a job Codex could have handled, wasting quota
- Coder agent was on a stale alias after an OpenClaw upgrade reset plugin config
- A one-time OpenAI 503 on `gpt-5.4` pinned a cron channel to `gpt-5.3-codex` for four days via the `auto` override system. `/reset` didn't clear it — we had to `/model` pin it back as a `user` source override.

Always check before assuming. After any OpenClaw upgrade, re-verify `agents.list` and `plugins.entries` — both have been observed to reset.

## Sub-Agent Isolation

### What Sub-Agents Can't Do

Isolated sub-agents in OpenClaw have limitations:

- **No git/gh CLI** in sandboxed sessions. Use sub-agents for file writing, then push from the main session.
- **No access to main session context.** They don't see your conversation history, memory, or personality files.
- **No host tools** unless explicitly configured. Elevated permissions must be enabled per-agent.

### What Sub-Agents Are Good At

- Starting clean (no context baggage)
- Running cheaper models on mechanical tasks
- Parallel execution (multiple sub-agents at once)
- Failure isolation (a crashed sub-agent doesn't kill your main session)

## Error Handling

### Sub-Agent Failures Are Silent by Default

If a sub-agent crashes, the main agent might never know. This is why the wrapper script pattern exists. For non-CLI sub-agents (spawned via `sessions_spawn`), OpenClaw will announce completion or failure, but timeouts and edge cases can cause silent drops.

### Timeout Strategy

Set appropriate timeouts and handle them:

```
# Short task - fail fast
sessions_send(agentId: "coder", message: "...", timeoutSeconds: 30)

# Long task - generous timeout
sessions_send(agentId: "coder", message: "...", timeoutSeconds: 300)
```

If a task times out, it might still be running. Check with:
```
subagents(action: "list")
```

Kill stuck agents:
```
subagents(action: "kill", target: "<session-key>")
```

## Orchestration Patterns

### Sequential Pipeline

Main agent writes spec, spawns coder, reviews output:

```
1. Main: Write detailed spec for API routes
2. Main: sessions_send(agentId: "coder", message: spec, timeout: 120)
3. Main: Review coder's output
4. Main: Fix issues or approve and merge
```

### Parallel Fan-Out

Multiple sub-agents working simultaneously:

```
1. Main: Spawn coder to build frontend
2. Main: Spawn coder to build backend
3. Main: Spawn researcher to gather API documentation
4. Wait for all three to complete
5. Main: Integrate and review
```

### Triage Escalation (Three Tiers)

Local model screens, main handles most work, ACP Opus gets the quality-critical tasks:

```
1. Ollama (7B): Screen incoming email — SKIP or ESCALATE
2. If ESCALATE: Main (GPT 5.4) reads and processes
3. If action needed:
   - Mechanical/code work → main spawns coder
   - Resume/design/review/humanize → main spawns acp-claude
   - Research with large context → main spawns researcher
```

### ACP Escalation Pattern

Claude Opus now lives behind the ACP boundary. To reach it:

```
sessions_spawn(
  agentId: "acp-claude",
  task: "Review this resume for voice, density, and line-by-line density. \
         Flag any section that reads machine-generated. Return structured notes.",
  mode: "run"
)
```

Or open a dedicated Discord thread routed to `acp-claude` (see [multi-channel setup](multi-channel-setup.md)) and work with Opus directly. The ACP session has no access to your main agent's conversation history — pass all necessary context in the task itself.

**When to escalate:** Resume, intel, design, PR review that needs taste, humanize passes, academic work.
**When NOT to escalate:** Code generation, file scanning, bulk ops, anything mechanical. The coder agent (GPT 5.4) handles those faster and without burning Max-subscription quota.

## Verification

```bash
# Check configured agents
echo "=== Agent Configuration ==="
jq '.agents.list[] | {id, model, exec: (.tools.exec.security // "default"), elevated: (.tools.elevated.enabled // false)}' \
  ~/.openclaw/openclaw.json

# Check fallback chain
echo ""
echo "=== Fallback Chain ==="
jq '.agents.defaults.model' ~/.openclaw/openclaw.json

# Check ACP plugin is loaded
echo ""
echo "=== ACPX ==="
jq '.plugins.allow | contains(["acpx"])' ~/.openclaw/openclaw.json
test -x ~/.openclaw/vendor/acpx/node_modules/.bin/acpx && echo "✓ acpx binary present"

# Check for wrapper script
echo ""
echo "=== Agent Wrapper ==="
if [ -f ~/.openclaw/workspace/scripts/agent-wrapper.sh ]; then
  echo "✓ agent-wrapper.sh exists"
else
  echo "⚠ agent-wrapper.sh not found - background agents will fail silently"
fi
```

## Gotchas

1. **Don't spawn dependent sub-agents without coordination.** Sub-agent A's output isn't automatically available to sub-agent B. Use the send-and-wait pattern for sequential dependencies.

2. **Batch git operations.** If multiple sub-agents produce files, collect them in the main session and do one commit/push. Don't have sub-agents fighting over git.

3. **Sandbox limitations are per-agent.** The main agent might have `exec: full` while sub-agents have `exec: allowlist`. A task that works in the main session might fail in a sub-agent because of missing permissions.

4. **Context isolation is a feature, not a bug.** Sub-agents starting clean means they don't carry your 50K token conversation history. This is good for token efficiency and bad for tasks that need context. Choose the right pattern for the job.

5. **Auto-announce goes directly to the user.** Fire-and-forget sub-agent output is announced to the user (via Telegram, Discord, etc.), not returned to the main agent. If you need the result in the main agent's workflow, use send-and-wait instead.

6. **Auto-announce doesn't trigger a parent turn.** When a coder finishes and auto-announces, the result appears in the main agent's transcript but does NOT trigger a new inference turn. The main agent has to be woken by a user message. If the main says "I'll do X when coder gets back," it structurally can't follow through without another user message. Build your orchestration around this: either chain via send-and-wait, or have the user nudge.

7. **Tool narration instead of tool calls.** GPT 5.4 occasionally narrates what it's about to do ("I'm running the build now") instead of actually calling the tool. We mitigate this with the `tool-narration-guard` plugin (run-level tracking with `prependContext` injection). Without it, you'll lose 30+ minutes waiting for work that never started. See [self-improving agents](self-improving-agents.md).

8. **`strict-agentic` has detection gaps.** The planning-only retry no-ops on (A) imperative prompts like "do X" / "put Y through Z" and (B) short confident narration like "I'm running it now." We carry a local patch in `dist/pi-embedded-runner-*.js` that tightens the actionable regex and rewrites the retry instruction to close the circular-blocker loophole. Ready-to-file issue body is queued upstream.
