# Sub-Agent Patterns: Orchestration, Spawning, and Gotchas

How to use OpenClaw sub-agents effectively. Spawn patterns, model assignment, error handling, and the lessons we learned from breaking things.

**Tested on:** OpenClaw with GPT 5.5 (main + coder), Claude Code via tmux relay for review escalation, ACP compatibility, browser-LLM stack for research/imagegen
**Last updated:** 2026-06-05

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

**Post-April-2026 note:** The main agent no longer has to be your "strongest" model. GPT 5.5 on Codex Pro is a fine orchestrator, and Opus-quality work happens through Claude Code's first-party harness when needed. Prefer the [tmux relay](claude-code-tmux-relay.md) for review escalation; keep [ACP escalation](claude-cli-to-acp-migration.md) for setups that explicitly need ACP.

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
  openclaw system-event "✅ ${LABEL} completed in ${DURATION}s"
else
  openclaw system-event "❌ ${LABEL} failed (exit ${EXIT_CODE}) after ${DURATION}s"
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

```json
{
  "agents": {
    "list": [
      { "id": "main",  "model": "openai-codex/gpt-5.5" },
      { "id": "coder", "model": "gpt55" }
    ]
  }
}
```

`gpt55` is an alias defined in `agents.defaults.models` that resolves to `openai-codex/gpt-5.5`. See [multi-model orchestration](multi-model-orchestration.md) for the full alias setup.

Claude Code review is not modeled as a fake OpenClaw agent in the current setup. Launch it through the tmux relay script so Claude stays inside the first-party harness.

Research and imagegen are not separate agents in this setup - they're skills the main/coder invoke against the [browser-LLM stack](multi-model-orchestration.md#tier-3-browser-llm-stack--playwright--novnc).

### Assignment Rules

| Task Type | Target | Why |
|-----------|--------|-----|
| File scanning, grep, counts | coder | Mechanical, doesn't need judgment |
| Code generation from specs | coder | Same model as main, but with isolated context |
| Code reviews | coder | Structured analysis |
| Research, web analysis | browser skill (not an agent) | Perplexity Pro / Gemini web UI via Playwright |
| Imagegen | browser skill | Web UI against existing subscriptions |
| Design critique | Claude Code tmux relay | Stronger judgment on UX and system tradeoffs |
| PR review requiring taste | Claude Code tmux relay | Independent second opinion |
| Security review | Claude Code tmux relay | Better failure-mode analysis |
| Long-form academic work | Claude Code tmux relay or browser research lane | Reasoning depth and source review |
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
- A one-time OpenAI 503 on `gpt-5.5` pinned a cron channel to `gpt-5.3-codex` for four days via the `auto` override system. `/reset` didn't clear it - we had to `/model` pin it back as a `user` source override.

Always check before assuming. After any OpenClaw upgrade, re-verify `agents.list` and `plugins.entries` - both have been observed to reset.

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

Local model screens, main handles most work, Claude Code gets the quality-critical review tasks:

```
1. Ollama (7B): Screen incoming email - SKIP or ESCALATE
2. If ESCALATE: Main (GPT 5.5) reads and processes
3. If action needed:
   - Mechanical/code work → main spawns coder
   - Design/review/security analysis → main sends a bounded prompt to Claude Code via tmux
   - Research or imagegen → main calls the browser skill (not a sub-agent)
```

### Claude Code tmux Escalation Pattern

Claude Opus now lives behind Claude Code's first-party harness. To reach it for review, start or reuse a tmux session and send a bounded prompt:

```bash
CLAUDE_TMUX_SESSION=claude-code-review \
CLAUDE_WORKSPACE=/path/to/repo \
CLAUDE_PERMISSION_MODE=plan \
templates/ai-stack/claude-tmux-relay.sh start

templates/ai-stack/claude-tmux-relay.sh send \
  "Review this architecture for hidden failure modes, unclear ownership boundaries, and risky assumptions. Return structured notes with priorities. Do not edit files."

templates/ai-stack/claude-tmux-relay.sh capture -200
```

For one-shot reviews, put the prompt in a file and use `send-file`. Do not call `claude -p`.

ACP remains a compatibility path when OpenClaw needs a formal ACP endpoint. The tmux relay has no access to your main agent's conversation history - pass all necessary context in the prompt itself.

**When to escalate:** Intel, design, PR review that needs taste, security analysis, academic work.
**When NOT to escalate:** Code generation, file scanning, bulk ops, anything mechanical. The coder agent (GPT 5.5) handles those faster and without burning Max-subscription quota.

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

# Check Claude Code tmux relay
echo ""
echo "=== Claude Code tmux ==="
tmux has-session -t claude-code-review && echo "tmux review session present" || echo "tmux review session not running"
test -x templates/ai-stack/claude-tmux-relay.sh && echo "relay template present"

# Check ACP plugin only if you still use ACP compatibility
echo ""
echo "=== ACPX compatibility ==="
jq '.plugins.allow | contains(["acpx"])' ~/.openclaw/openclaw.json 2>/dev/null || true
test -x ~/.openclaw/vendor/acpx/node_modules/.bin/acpx && echo "acpx binary present" || true

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

7. **Tool narration instead of tool calls.** GPT 5.5 occasionally narrates what it's about to do ("I'm running the build now") instead of actually calling the tool. We mitigate this with the `tool-narration-guard` plugin (run-level tracking with `prependContext` injection). Without it, you'll lose 30+ minutes waiting for work that never started. See [self-improving agents](self-improving-agents.md).

8. **`strict-agentic` has detection gaps.** The planning-only retry no-ops on (A) imperative prompts like "do X" / "put Y through Z" and (B) short confident narration like "I'm running it now." We carry a local patch in `dist/pi-embedded-runner-*.js` that tightens the actionable regex and rewrites the retry instruction to close the circular-blocker loophole. Ready-to-file issue body is queued upstream.
