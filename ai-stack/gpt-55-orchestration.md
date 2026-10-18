# Orchestrating with GPT 6.1 Sol: Execution Contract, Narration Guards, and Silent Loops

Running a Codex-subscription model as your main orchestrator is cheap and fast compared to frontier API billing, but it has specific failure modes that quietly eat hours until you know to guard against them. This guide documents the ones I have actually hit: tool-call narration, planning-only stalls, the `executionContract` setting and what it covers, and the silent-tool-loop false alarm. The filename keeps its old `gpt-55` slug so existing links still resolve. The content now describes GPT 6.1 Sol.

**Tested on:** OpenClaw 2026.10.4, GPT 6.1 Sol (`openai/gpt-6.1-sol`, Codex runtime), `embeddedAgent.executionContract: strict-agentic`, the `tool-narration-guard` plugin
**Last updated:** 2026-10-17

---

## Why This Guide Exists

Anthropic blocked third-party harness OAuth in April 2026. The cheapest path to a subscription-grade frontier orchestrator became a GPT model on a Codex plan: GPT 5.5 first, then GPT 6 Sol, now GPT 6.1 Sol. Each generation is a stronger orchestrator. The narration failure survived all of them in some form, so the mechanical guards stayed.

If you run a Codex-plan model as main and wonder why the bot sometimes "goes silent" for 30 minutes or posts a confident "running it now" without running anything, the patterns below are why.

## Failure Mode 1: Tool Call Narration

The model says it is doing the work ("On it", "Running it now", "I'll handle this") and then ends the turn with **zero tool calls**. From the user's side the bot promised action and nothing happens. You check the session and see no tool activity after the confident message.

The cause is that conversational fluency is rewarded in training. Narrating the plan can substitute for doing it. A mechanical guard is the fix, because prompts only lower the rate.

### The Tool Narration Guard Plugin

A small OpenClaw plugin catches this pattern at the hook boundary. It is still enabled on my 2026.10.4 gateway (`plugins.allow` lists `tool-narration-guard`, and its entry sets `hooks.allowConversationAccess` to `true`). The version that works in production does four things:

```
after_tool_call       Record tool calls in a per-runId Set
llm_output            If action-promise keywords present AND
                      zero tools called in the whole run → flag violation
before_prompt_build   On sessions with recent violations, prepend
                      escalating enforcement context (WARN → CRITICAL)
message_sending       Append a visible "action without tool call"
                      warning to the outgoing Discord/Telegram message
```

Plugin lives in the workspace extensions directory (`~/.openclaw/workspace/.openclaw/extensions/tool-narration-guard/`) and keeps its violation state in a `state.json` next to the source. The two pieces that matter for getting it right:

**Track per `runId`, not per assistant message.** Multi-turn tool use looks like [tool_use → tool_result → assistant text → more tool_use]. If you check only the last assistant turn for tool calls, you false-positive on every complex flow. Accumulate tool calls into a Set keyed by `runId` and only flag when the whole run ends with zero tools called.

**Escalate, don't just warn.** A single violation gets a soft `prependContext` warning. Three violations in a 10-minute TTL get a CRITICAL block at the top of the system prompt. Clear automatically on the next successful tool call.

### Action-Promise Keywords to Watch

The regex list behind the violation check. Tune it to your bot's voice:

```javascript
const ACTION_PROMISE_PATTERNS = [
  /\brunning it now\b/i,
  /\bon it\b/i,
  /\bdoing it now\b/i,
  /\bspawning\b/i,
  /\bi'?ll (?:run|spawn|use|kick off|launch|fire up|start|drop|post|send)\b/i,
  /\blet me (?:run|spawn|use|kick off|launch|fire up|start)\b/i,
];
```

What makes these dangerous is that they are confident and short. Long planning paragraphs usually end with a tool call. A five-word "I'm running it now" usually doesn't.

## Failure Mode 2: Planning-Only Stalls

Related but distinct. The model writes a bulleted plan ("I'll do this in two steps: 1)… 2)…") and ends the turn without executing step 1.

### What `executionContract: strict-agentic` does now

The OpenClaw config schema describes it this way: `"default"` keeps the standard runner behavior, while `"strict-agentic"` enables structured plan tracking and non-visible turn recovery for supported OpenAI and OpenAI Codex runs. It can be set globally under `agents.defaults.embeddedAgent.executionContract` or per agent under `agents.entries.<id>.embeddedAgent.executionContract`.

Two things changed from the 2026.4 behavior that this guide used to document:

- **The key moved.** It was `agents.defaults.embeddedPi.executionContract`. The live key is `embeddedAgent.executionContract`.
- **The verb-allowlist detection is gone.** On 2026.4.x the retry fired only when the user's prompt matched an allowlist of about 30 verbs, and the planning-only detector matched a short list of phrases like "I'll" and "let me". Those two gaps (imperatives such as "do" and "send" slipped through, and "I'm running it now" passed every detector) were real, and I carried a local patch on the runner bundle for them. On 2026.10.4 I could not find that regex in the shipped build. Terminal turns are now classified by what the harness returned: a turn with no assistant text but a plan is `planning-only`, one with only reasoning is `reasoning-only`, and the rest are `empty`. Releases are promoted as fresh worktrees now, so a local patch on the runner would not survive anyway.

### Check what the contract covers on your model

Reading the 2026.10.4 build, the strict-agentic check only treats provider `openai` models whose id matches `gpt-5` (a `/^gpt-5(?:[.o-]|$)/` pattern) as supported. `gpt-6.1-sol` does not match. I read this from source and did not test it behaviorally, but the practical reading is that the setting is inert for Sol 6.1 and Luna 6 on this build. My config still carries it (`"executionContract": "strict-agentic"`), which is harmless. Two consequences:

1. Do not count on it to catch plan-only turns on a GPT 6 model. Verify against the version you run.
2. The narration guard plugin is doing the real work. It does not depend on the model id.

This is the kind of drift the [model retirement guide](model-retirement-and-fallbacks.md) warns about: a setting that looks active in the config and does nothing after a model change.

## Failure Mode 3: Silent Tool Loops (False Alarm)

The opposite problem. The model goes 10 to 30+ minutes without surfacing anything to the channel, and you assume it froze. Usually it hasn't. Deep SSH-to-container-to-docker chains, long-running `infer` calls, and n8n workflow patching all produce long gaps between assistant messages while tool calls run.

The Discord typing indicator expires after about 2 minutes regardless of actual activity, which makes an active agent look dead.

### Triage Before Assuming Freeze

Three checks, in order:

```bash
# 1. Is the session still updating? (ageMs is time since last activity)
openclaw sessions --agent main --active 5 --json \
    | jq '.sessions // . | map({key, status, ageMs, model})'
# A session with a small ageMs is alive.

# 2. Gateway health + recent activity (filter signal noise)
journalctl --user -u openclaw-gateway --since "-5min" \
    | grep -v signal-cli

# 3. Is anything still executing under the gateway?
ps -eo pid,etimes,cmd --sort=-etimes | grep -E 'codex|claude|ssh ' | grep -v grep | head
```

### Real Freeze Signals

It actually is stuck (not just quiet) when:

- The session's `ageMs` is above two minutes and no child process is running
- No bootstrap hook injections in the gateway log for 5+ minutes
- A child process for the session exists in `ps` but its elapsed time keeps growing with no new output

Before restarting the gateway for a suspected freeze, check `ageMs` and the process list. Restarting a healthy agent mid-tool-loop corrupts its state. You lose whatever it was doing and it can't resume.

## Prompt-Side Adjustments That Help

The mechanical guards are the fix. These soft adjustments reduce how often they need to fire:

1. **Put the instruction in present tense.** "Run the intel pipeline" beats "I need you to run the intel pipeline when you can". The second invites a commitment narration.

2. **Avoid "please" on execution prompts.** For chat tasks it's fine. For agent work, strip it.

3. **End task prompts with the expected tool, not the expected result.** "Call `sessions_spawn(agentId: browser-operator, task: ...)` now" is harder to narrate past than "Get the research done".

4. **For multi-step work, pre-declare the step count.** "This has 3 steps. Step 1 is X. Do step 1 now, then report the result."

## Config: Agents Section

Minimum config for Sol 6.1 as main with the guards active (shape from the live file):

`plugins.allow` is an exclusive list: the `codex` runtime and the `openai` provider must both be on it, or the primary model resolves as disabled with `not in allowlist`. The Opus fallback in this snippet also needs `anthropic` on the list. If you already have an allowlist, merge into it instead of replacing it.

```json
{
  "agents": {
    "defaults": {
      "embeddedAgent": {
        "executionContract": "strict-agentic"
      },
      "model": {
        "primary": "openai/gpt-6.1-sol",
        "fallbacks": [
          "openai/gpt-6-luna",
          "anthropic/claude-opus-5-5"
        ]
      },
      "models": {
        "openai/gpt-6.1-sol": { "alias": "sol61", "agentRuntime": { "id": "codex" } },
        "openai/gpt-6-luna": { "alias": "luna6", "agentRuntime": { "id": "codex" } },
        "anthropic/claude-opus-5-5": { "agentRuntime": { "id": "claude-cli" } }
      },
      "modelPolicy": {
        "allow": ["openai/gpt-6.1-sol", "openai/gpt-6-luna", "anthropic/claude-opus-5-5"]
      }
    },
    "entries": {
      "main": {
        "thinkingDefault": "medium"
      }
    }
  },
  "plugins": {
    "allow": ["codex", "openai", "anthropic", "tool-narration-guard", "acpx"],
    "entries": {
      "tool-narration-guard": {
        "enabled": true,
        "config": {},
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Notes on that config:

- **Thinking level is `medium`, not `xhigh`.** High thinking burns rate limit faster than it returns value for orchestration. Save deeper review for bounded Claude seats.
- **My fallback chain is short and probed.** The main agent falls back to Luna 6, then to Opus 5.5 through the `claude-cli` runtime, and each hop answered a live turn before I kept it (see [model retirement and fallbacks](model-retirement-and-fallbacks.md)). Keep a chain on providers you run and put the preferred substitute first. A Gemini fallback silently lands requests on a different model without telling the user, and every fallback must also be on `modelPolicy.allow`.

## Verification

Quick checks after deploying the guards:

```bash
# Plugin loaded
jq '.plugins.allow | index("tool-narration-guard") != null' ~/.openclaw/openclaw.json
# Expected: true

# Plugin enabled
jq '.plugins.entries["tool-narration-guard"].enabled' ~/.openclaw/openclaw.json
# Expected: true

# Execution contract set at the current key
jq '.agents.defaults.embeddedAgent' ~/.openclaw/openclaw.json
# Expected: {"executionContract": "strict-agentic"}

# Plugin activity in the gateway log
journalctl --user -u openclaw-gateway -n 200 | grep tool-narration-guard

# Current violation state
jq 'keys' ~/.openclaw/workspace/.openclaw/extensions/tool-narration-guard/state.json
# Expected: ["lastAutoRetry", "savedAt", "violations"]
```

If the plugin never fires in a week of real usage, either the model isn't narrating much for you or the keyword list is too narrow for your bot's voice. Widen it.

## Gotchas

1. **Model-pinning stickiness.** A single provider 503 can pin a channel to a different model for days via an `auto` override. `/reset` doesn't clear it reliably. Use `/model <name>` explicitly to repin. This was observed on GPT 5.5 falling to GPT 5.3 Codex, and the mechanism is not model-specific.

2. **Quota readings can lie.** A weekly usage meter can read 0% while requests return rate-limit errors. When the Codex lane breaks, sub-agent tasks surface as `FailoverError`, not as a rate limit message.

3. **Concurrent sub-agents on the same OAuth.** Main and sub-agents on the same Codex token will sometimes 500 under load. With `subagents.maxConcurrent` at 8, spread work across Brigade seats instead of the gateway pool when a burst is expected.

4. **Don't dual-route the orchestrator through Claude.** Putting a Claude lane in the main agent's primary chain adds startup latency and confuses ownership. Keep Claude for bounded review escalation through a Brigade seat or the [tmux relay](claude-code-tmux-relay.md), with [ACP](acp-claude-code.md) only where you explicitly need it.

5. **Settings can go inert after a model change.** `strict-agentic` is the example: still present in config, no longer matched by the model check. After a model generation change, confirm each guard still fires on the new model id.

6. **History.** On 2026.4.x the retry guard had two known gaps (imperative verbs outside an allowlist, and short confident narration), which a local patch on the runner bundle closed, and the narration plugin was the backstop. Those specifics no longer apply on 2026.10.4. The plugin, and the lesson that no single guard is enough, do.
