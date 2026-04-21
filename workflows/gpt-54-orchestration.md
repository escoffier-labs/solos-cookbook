# Orchestrating with GPT 5.4: Narration Guards and Strict-Agentic Gaps

Running GPT 5.4 (via OpenAI Codex Pro) as your main orchestrator is cheap and fast compared to frontier API billing, but it has specific failure modes that will quietly eat hours of your time until you know to guard against them. This guide documents the real ones: tool-call narration, planning-only stalls, strict-agentic detection gaps, and the silent-tool-loop false alarm.

**Tested on:** GPT 5.4 (Codex OAuth), OpenClaw 2026.4.x, `executionContract: strict-agentic`
**Last updated:** 2026-04-20

---

## Why This Guide Exists

Anthropic blocked third-party harness OAuth in April 2026. The cheapest path to a subscription-grade frontier orchestrator became GPT 5.4 via the OpenAI Codex Pro plan. It is a strong orchestrator. It also has three distinct failure patterns that `default` and even `strict-agentic` execution contracts do not fully catch.

If you're running GPT 5.4 as main and wondering why the bot sometimes "goes silent" for 30 minutes or posts confident "running it now" messages without actually running anything, the patterns below are why.

## Failure Mode 1: Tool Call Narration

GPT 5.4 will say it's doing the work — "On it", "Running it now", "Dual-lane running", "I'll handle this" — and then end the turn with **zero tool calls**. From the user's perspective the bot promised action; nothing happens. Hours pass. You check the session and see no tool activity after the confident message.

The root cause is that OpenAI's assistant-style RLHF rewards conversational fluency. Narrating the plan *is* the reward signal. Without a mechanical guard, GPT 5.4 will occasionally substitute the narration for the work.

### The Tool Narration Guard Plugin

A small OpenClaw plugin catches this pattern at the hook boundary. The version that works in production does four things:

```
after_tool_call       Record tool calls in a per-runId Set
llm_output            If action-promise keywords present AND
                      zero tools called in the whole run → flag violation
before_prompt_build   On sessions with recent violations, prepend
                      escalating enforcement context (WARN → CRITICAL)
message_sending       Append a visible "⚠ action without tool call"
                      warning to the outgoing Discord/Telegram message
```

Plugin lives at `~/.openclaw/workspace/.openclaw/extensions/tool-narration-guard/`. The two pieces that matter for getting it right:

**Track per `runId`, not per assistant message.** Multi-turn tool use looks like [tool_use → tool_result → assistant text → more tool_use]. If you check only the last assistant turn for tool calls, you false-positive on every complex flow. Accumulate tool calls into a Set keyed by `runId` and only flag when the whole run ends with zero tools called.

**Escalate, don't just warn.** A single violation gets a soft `prependContext` warning. Three violations in a 10-minute TTL get a CRITICAL block at the top of the system prompt. Clear automatically on the next successful tool call.

### Action-Promise Keywords to Watch

The regex behind the violation check. Tune it to your bot's voice:

```javascript
const ACTION_PROMISES = /\b(?:on it|running (?:it )?now|starting (?:on )?that|
    handling (?:it|that)|kicking (?:it|this) off|dual[- ]lane running|
    i['']ll (?:go|handle|run|start)|working on it|got it, running)\b/i;
```

What makes these dangerous is that they're *confident and short*. Long planning paragraphs usually end with a tool call. Five-word "I'm running it now" usually doesn't.

## Failure Mode 2: Planning-Only Stalls

Related but distinct. GPT 5.4 writes a bulleted plan ("I'll do this in two steps: 1)… 2)…") and ends the turn without executing step 1. This is what `executionContract: "strict-agentic"` is supposed to fix — it injects a `PLANNING_ONLY_RETRY_INSTRUCTION` and forces another turn.

It works most of the time. It has two known gaps as of OpenClaw 2026.4.14.

### Gap A: Non-Allowlisted User Verbs

`strict-agentic` only fires the retry if it judges the *user's* prompt actionable. The gate is a regex allowlist of ~30 verbs: `check|look|read|write|edit|update|fix|investigate|debug|run|search|find|implement|add|remove|refactor|explain|summari|analy|review|tell|show|make|restart|deploy|prepare`.

Common imperatives that are **not** on the list and slip through:

```
do       put      post     draft    polish   rewrite
pass     send     build    finish   create   generate   compose
```

A prompt like **"do another pass then put this draft through the opus polish"** is classed as non-actionable, the retry guard short-circuits, and GPT 5.4 gets away with a plan-only turn.

### Gap B: Short Confident Narration

Even when the user's prompt passes the actionable gate (e.g. they reply `GO`), the assistant's response can still skip the retry if it's too confident and too short. The planning-only guard requires one of:

```
i'll  |  i will  |  i'm going to  |  let me  |  i can do that
```

It does **not** match `i'm running`, `i'm doing`, `on it`, `handling that now`. A five-word reply like `"Great. I'm running it now."` passes all three planning detectors.

### Workarounds Until Upstream Fixes

You have three options, in increasing order of effort:

1. **Local patch on `dist/pi-embedded-runner-*.js`.** Extend both regexes to cover the missing verbs and the present-continuous narration pattern. Persist the patch through upgrades via [Upgrade Hygiene](../infrastructure/upgrade-hygiene.md). This is what runs in production on the OpenClaw host.
2. **Deny-list instead of allow-list** on the actionable-prompt gate. Skip retry only for obvious chit-chat (`thanks`, `ok cool`, `lol`, `nice`, `got it`). More durable — allowlists keep growing forever.
3. **Rely on the narration guard plugin.** It catches what `strict-agentic` misses, but it warns rather than retrying. The user sees a visible warning on the message; the turn doesn't re-fire automatically.

Use all three together. They fail in different ways — the patch fixes the guard regex, the denylist catches new verbs, the plugin warns visibly when both miss.

## Failure Mode 3: Silent Tool Loops (False Alarm)

The opposite problem. GPT 5.4 goes 10–30+ minutes without surfacing anything to the channel, and you assume it froze. Usually it hasn't. Deep SSH→pct→docker chains, long-running `infer` calls, n8n workflow patching — all of these produce long gaps between assistant messages while tool calls are actively running.

The Discord typing indicator expires after ~2 minutes regardless of actual activity, which makes an active agent look dead.

### Triage Before Assuming Freeze

Three checks, in order:

```bash
# 1. Is the session transcript still being written to?
stat ~/.openclaw/agents/main/sessions/*.jsonl \
    | sort -k6 | tail -1
# If mtime is within the last ~60 seconds, agent is alive.

# 2. Gateway health + recent activity (filter signal noise)
journalctl --user -u openclaw-gateway --since "-5min" \
    | grep -v signal-cli

# 3. What is it actually doing right now?
SESSION=$(ls -t ~/.openclaw/agents/main/sessions/*.jsonl | head -1)
tail -c 8000 "$SESSION" | jq -c 'select(.type=="tool_use" or .type=="tool_result")'
```

### Real Freeze Signals

It actually is stuck (not just quiet) when:

- Session jsonl mtime is > 2 minutes stale
- No bootstrap hook injections in the gateway log for 5+ minutes
- Same `sessionId` appears in `ps` with no new exec/tool calls

Before restarting the gateway for a suspected freeze, check mtime. Restarting a healthy agent mid-tool-loop corrupts its state; you lose whatever it was doing and it can't resume.

## Prompt-Side Adjustments That Help

The mechanical guards are the load-bearing fix. These soft adjustments reduce how often the guards need to fire:

1. **Put the instruction in present tense.** "Run the intel pipeline" beats "I need you to run the intel pipeline when you can" — the second one invites a commitment narration. Imperative framings get imperative execution.

2. **Avoid "please" on execution prompts.** It's a small thing, but polite phrasing triggers the assistant-mode RLHF. For chat tasks it's fine; for agent work, strip it.

3. **End task prompts with the expected tool, not the expected result.** "Call `sessions_spawn(agentId: researcher, task: ...)` now" is harder to narrate past than "Get the research done". Naming the tool biases toward calling it.

4. **For multi-step work, pre-declare the step count.** "This has 3 steps. Step 1 is X. Do step 1 now, then report the result." makes plan-only responses feel incomplete even to the model.

## Config: Agents Section

Minimum viable config for GPT 5.4 as main with the guards active:

```json
{
  "agents": {
    "defaults": {
      "embeddedPi": {
        "executionContract": "strict-agentic"
      },
      "model": {
        "primary": "openai-codex/gpt-5.4",
        "fallbacks": [
          "openai-codex/gpt-5.3-codex",
          "acp:claude-opus-4-7"
        ]
      }
    },
    "entries": {
      "main": {
        "model": "openai-codex/gpt-5.4:medium",
        "thinking": "medium"
      }
    }
  },
  "plugins": {
    "allow": ["tool-narration-guard", "acpx"],
    "entries": {
      "tool-narration-guard": {
        "enabled": true,
        "violationTtlSeconds": 600
      }
    }
  }
}
```

Two notes on that config:

- **Thinking level is `medium`, not `xhigh`.** On Codex Pro, high thinking burns rate limit faster than it returns value for orchestration. Save high for escalation lanes via ACP.
- **Codex first in the fallbacks.** Gemini fallback silently lands requests on a different model without notifying the user. If you must include Gemini, put it last and only if you actually want that behavior — which these days, you probably don't (see [Multi-Model Orchestration](../configuration/multi-model-orchestration.md)).

## Verification

Quick checks after deploying the guards:

```bash
# Plugin loaded and seeing events
journalctl --user -u openclaw-gateway -n 200 | grep tool-narration-guard

# Strict-agentic active on this agent
jq '.agents.defaults.embeddedPi' ~/.openclaw/openclaw.json

# Current violation state (if plugin persists it)
ls ~/.openclaw/workspace/state/tool-narration-guard/ 2>/dev/null

# Replay a session to see how often the guard fires
jq 'select(.type=="plugin_event" and .name=="tool-narration-guard")' \
    ~/.openclaw/agents/main/sessions/*.jsonl | head -20
```

If the plugin never fires in a week of real usage, either GPT 5.4 isn't narrating much for you (nice) or the keyword regex is too narrow for your bot's voice. Widen it.

## Gotchas

1. **Model-pinning stickiness.** A single OpenAI 503 on gpt-5.4 can pin a channel to gpt-5.3-codex for days. `/reset` doesn't clear `auto` overrides reliably; use `/model <name>` explicitly to repin.

2. **Codex rate limits can read 0% while failing.** GPT 5.3 Codex has a known bug where weekly usage shows 0% but requests return rate-limit errors. Resets around 3:45am local. When Codex breaks, coder subagent tasks surface as `FailoverError` — not as a rate limit message.

3. **Concurrent subagents on the same OAuth.** Main and coder both on the same Codex token will sometimes 500 under load. If you run concurrent subagents, give coder its own profile or a different provider.

4. **Don't dual-route the orchestrator through ACP.** Putting `acp:claude-opus-4-7` as the main agent's primary adds 20+ seconds of startup per cold turn. Keep ACP for escalation lanes only. See [ACP for Claude Code](../configuration/acp-claude-code.md).

5. **The guards are belt-and-braces, not one or the other.** `strict-agentic` retry > local regex patch > narration plugin. Each catches failures the others miss. Running only one will leak violations.
