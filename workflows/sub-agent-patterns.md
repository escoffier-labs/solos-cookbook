# Sub-Agent Patterns: Orchestration, Spawning, and Gotchas

How to use OpenClaw sub-agents effectively. Spawn patterns, model assignment, error handling, and the lessons we learned from breaking things.

**Tested on:** OpenClaw with Opus 4.6 (main), GPT 5.4 (coder), Gemini 3 Pro (researcher)
**Last updated:** 2026-03-17

---

## Why Sub-Agents

Your main agent is expensive (frontier model) and carries heavy context (memory, personality, conversation history). Sub-agents are cheap, isolated, and disposable. They start clean, do one job, and report back.

**Use sub-agents when:**
- The task is mechanical (scan files, generate boilerplate, run searches)
- The task doesn't need your main session's context
- You want parallel execution
- You want to use a cheaper/specialized model for the task

**Keep on the main agent when:**
- The task requires judgment or creativity
- It needs conversation context or memory
- It involves security decisions or untrusted input
- It's a quick one-liner that doesn't justify the spawn overhead

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
  "agents": [
    {
      "id": "main",
      "name": "Main",
      "model": "anthropic/claude-opus-4-6"
    },
    {
      "id": "coder",
      "name": "Code Worker",
      "model": "openai-codex/gpt-5.4"
    },
    {
      "id": "researcher",
      "name": "Researcher",
      "model": "google-gemini-cli/gemini-3-pro-preview"
    }
  ]
}
```

### Assignment Rules

| Task Type | Agent | Why |
|-----------|-------|-----|
| File scanning, grep, counts | coder | Mechanical, doesn't need judgment |
| Code generation from specs | coder | Code-specialized model |
| Code reviews | coder | Structured analysis |
| Research, web analysis | researcher | Large context, free tier |
| Architecture decisions | main | Requires judgment |
| Security evaluation | main | Requires prompt injection resistance |
| Creative writing | main | Requires taste and voice |

### Pre-Flight Check

Always verify your agent configuration matches what you expect before spawning:

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
config = json.load(sys.stdin)
for agent in config.get('agents', []):
    print(f\"{agent['id']:15s} → {agent.get('model', 'default')}\")
"
```

We got burned multiple times by agent misconfigurations:
- Spawned 4 Opus agents for code gen (should have been Codex)
- Coder agent was on Haiku 4.5 when we thought it was GPT 5.3
- Always check before assuming.

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

### Triage Escalation

Local model screens, expensive model handles what matters:

```
1. Ollama (7B): Screen incoming email - SKIP or ESCALATE
2. If ESCALATE: Main (Opus) reads and processes
3. If action needed: Main spawns coder to implement
```

## Verification

```bash
# Check configured agents
echo "=== Agent Configuration ==="
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
config = json.load(sys.stdin)
for agent in config.get('agents', []):
    model = agent.get('model', 'default')
    tools = agent.get('tools', {})
    exec_mode = tools.get('exec', {}).get('security', 'default')
    print(f\"{agent['id']:15s} model={model:40s} exec={exec_mode}\")
"

# Check for wrapper script
echo ""
echo "=== Agent Wrapper ==="
if [ -f ~/.openclaw/workspace/scripts/agent-wrapper.sh ]; then
  echo "✓ agent-wrapper.sh exists"
else
  echo "⚠ agent-wrapper.sh not found - background agents will fail silently"
fi

# Check running sub-agents (if openclaw is running)
echo ""
echo "=== Active Sessions ==="
# Use openclaw CLI or API to list sessions
```

## Gotchas

1. **Don't spawn dependent sub-agents without coordination.** Sub-agent A's output isn't automatically available to sub-agent B. Use the send-and-wait pattern for sequential dependencies.

2. **Batch git operations.** If multiple sub-agents produce files, collect them in the main session and do one commit/push. Don't have sub-agents fighting over git.

3. **Sandbox limitations are per-agent.** The main agent might have `exec: full` while sub-agents have `exec: allowlist`. A task that works in the main session might fail in a sub-agent because of missing permissions.

4. **Context isolation is a feature, not a bug.** Sub-agents starting clean means they don't carry your 50K token conversation history. This is good for token efficiency and bad for tasks that need context. Choose the right pattern for the job.

5. **Auto-announce goes directly to the user.** Fire-and-forget sub-agent output is announced to the user (via Telegram, Discord, etc.), not returned to the main agent. If you need the result in the main agent's workflow, use send-and-wait instead.
