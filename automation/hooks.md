# Hooks

> Hooks enforce policy at boundaries and shape behavior at seams. Pick the wrong layer and you'll scrub private DMs, fight your orchestrator's hook contract, or watch async work disappear into a synchronous runner.

## What this is

Most agent stacks accumulate hooks the same way they accumulate cron entries: one at a time, wherever there happened to be a callback handy. Six months later there's a `message_sending` hook scrubbing private DMs, a `PostToolUse` hook returning `decision: "block"` that the framework silently ignores, and a substitution plugin whose async work never lands because the runner is synchronous.

This is how I split mine. Three layers, each picked for one thing it's good at: **boundary hooks** at the exit points (git pre-push, publish-time CLIs), **tool-call hooks** in the agent's tool-use loop (`PreToolUse`, `PostToolUse`, OpenClaw `before_tool_call` / `tool_result_persist`), and **lifecycle hooks** at session edges (`SessionStart`, `Stop`, bootstrap, `before_prompt_build`, `message_sending`).

Every gotcha below is from a real incident on this stack.

## Why this way

Three layers, each picked for what it's good at:

| Layer | Good at | Bad at |
|-------|---------|--------|
| **Boundary hooks** (git pre-push, publish-time CLIs) | Catching leaks at the exit point with full context, blocking irreversible publishes, running scanners that are too slow for the inner loop | Anything inside the agent's turn — these don't fire until the agent is done |
| **Tool-call hooks** (`PreToolUse`/`PostToolUse`, `before_tool_call`, `tool_result_persist`) | Rewriting tool inputs before execution, inspecting tool outputs, blocking dangerous calls, capturing data for later use | Replacing tool output content (most frameworks don't actually substitute, despite what the schema implies) |
| **Lifecycle hooks** (`SessionStart`, bootstrap, `before_prompt_build`, `message_sending`, `llm_output`) | Loading context, injecting just-in-time enforcement, scrubbing outbound messages, running per-session bookkeeping | Anything that needs to see the tool's actual input or output — too early or too late |

The wrong layer doesn't just feel awkward, it produces failures the docs won't warn you about. A `message_sending` hook scrubbing localhost out of DMs your bot uses to talk to you. A `PostToolUse` hook whose `decision: "block"` is ignored, leaving the unreduced tool output in context anyway. A `tool_result_persist` plugin whose async file read returns a Promise that the runner silently drops.

The cost of getting this right once is low. The cost of getting it wrong recurs every turn the hook fires.

### Adapting to other stacks

Specific hook names below are from Claude Code (boundary + tool-call + lifecycle) and OpenClaw (tool-call + lifecycle). If you're on a different orchestrator the three-layer model still applies.

| You run | Boundary | Tool-call | Lifecycle |
|---------|----------|-----------|-----------|
| Claude Code | git hooks, publish-time scripts | `PreToolUse`, `PostToolUse` | `SessionStart`, `Stop`, `UserPromptSubmit` |
| OpenClaw | git hooks, publish-time scripts | `before_tool_call`, `after_tool_call`, `tool_result_persist` | `before_prompt_build`, `llm_output`, `message_sending`, `agent_end` |
| Hermes Agent | git hooks, publish-time scripts | Whatever its current tool-event surface exposes | Whatever lifecycle events it exposes |
| No orchestrator-level hooks | git hooks + CLI scrubs are still load-bearing — start there | Skip — push enforcement to system prompts and trust verification | Skip |

The universal rule: the further from the LLM turn the hook runs, the more reliable it is. Boundary hooks always work. Lifecycle hooks usually work. Tool-call hooks often have surprising contracts.

## Prerequisites

- A Linux host with git (any modern distro)
- An orchestrator with at least a tool-call hook surface, or a willingness to live with boundary + lifecycle only
- Comfort with editing JSON config and writing small scripts
- A scanner like [content-guard](https://github.com/solomonneas/content-guard) for the boundary layer (or roll your own — the pattern is regex + policy file)

## Before / After

**Before:** Ad-hoc enforcement scattered across system prompts, with no mechanical way to verify it's holding. The agent narrates "running it now" and then doesn't, you find out a day later. A blog post leaks an internal hostname because nothing stopped it. A sub-agent finds and calls a destructive endpoint because nothing inspected its tool calls.

**After:** Three layers, each visible:

- `ls .git/hooks/` and `git config --get core.hooksPath` show boundary hooks
- The orchestrator's plugin/extensions dir shows tool-call and lifecycle hooks
- One `state.json` per behavioral hook records what it caught and when

Failures fail loud (push blocked, message annotated with a warning) instead of silent.

## Implementation

### Routing decision tree

```
Does the policy need to fire only when content leaves the host (git push, publish, post)?
├─ YES → Boundary hook. Git pre-push, or a CLI you run at the publish boundary.
└─ NO  → Does it need to inspect or rewrite a specific tool call?
         ├─ YES → Tool-call hook. PreToolUse/before_tool_call to rewrite input,
         │        PostToolUse/tool_result_persist to inspect or substitute output
         │        (caveats below — substitution is not always what it looks like).
         └─ NO  → Lifecycle hook. SessionStart/before_prompt_build to inject context,
                  llm_output/message_sending to inspect or annotate the agent's output,
                  agent_end/Stop for per-run bookkeeping.
```

### Layer 1 — Boundary hooks

Use for: catching leaks at exit points, blocking irreversible publishes, running scanners too slow for the inner loop.

The two boundary hooks worth running on a stack like this:

**Git pre-push** that runs a content scanner against the working tree before anything reaches a remote. Skeleton at [`../templates/hooks/pre-push`](../templates/hooks/pre-push). Drop it in `hooks/pre-push` of any repo you publish, then activate:

```bash
git config core.hooksPath hooks
```

The hook in this repo runs [content-guard](https://github.com/solomonneas/content-guard) against `policies/public-repo.json`. It blocks pushes that contain RFC 1918 IPs, secrets, or internal hostnames. Bypass with `git push --no-verify` only when you understand exactly what you're allowing through.

**Publish-time CLI** that scrubs generated content before it touches the publishing pipeline. The shape that works on this stack is a sed-rules script with a preview mode and an apply mode:

```bash
# Preview leaks across all drafts, no writes.
scrub-content drafts/

# Apply scrubs in place once you've reviewed the diff.
scrub-content --apply drafts/
```

Run it manually, or wire it as the first node in a publish workflow. Either way the file is the boundary, not the agent's output.

**Why two layers and not one?** The git hook catches commits before they reach a remote. The publish CLI catches generated content before it reaches a CMS, social platform, or static-site repo. They overlap deliberately — the failure modes are different (a wrong commit vs. a wrong DraftJS paste) and one not catching it doesn't mean the other won't.

### Layer 2 — Tool-call hooks

Use for: rewriting tool inputs before execution, inspecting outputs, blocking dangerous calls, capturing tool data for downstream hooks.

Skeletons live in [`../templates/hooks/`](../templates/hooks/) — one Claude Code `PostToolUse` settings.json snippet, one OpenClaw sync `tool_result_persist` plugin.

Three things to get right (orchestrator-agnostic):

1. **Substitution is rarely what it looks like.** Most schemas advertise a "block" or "replace" decision on post-tool hooks. In practice, frameworks vary in whether that actually rewrites the message the next turn sees. Verify by running the agent with full transcript logging and diffing the tool-result content against your hook's output. If the schema lies, fall back to PreToolUse-style rewriting (change the tool's input so it produces the output you want natively) or live with append-only `additionalContext`.

2. **Sync vs async matters more than the docs say.** Some hook runners are strictly synchronous and silently drop Promise returns. Others are async-aware. Read the runner source before relying on `await`. If sync-only: pre-load any data you need at plugin registration time and cache in module scope.

3. **Capture in `before`, read in `persist`.** When you need to know what command produced a given tool result (for log redaction, command-aware reduction, etc.), capture in the `before_tool_call`/`PreToolUse` hook keyed on `toolCallId`, then read in `tool_result_persist`/`PostToolUse`. The id is present in both events, so a `Map<toolCallId, command>` works cleanly.

#### Claude Code specifics

Claude Code hooks are configured in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` if set). Each entry is a shell command the binary spawns; communication is JSON over stdin/stdout. The events that matter most for tool-call layer:

- `PreToolUse` — fires before a tool call. Returning `{ "decision": "block", "reason": "..." }` actually blocks the call. Returning a rewrite is also supported.
- `PostToolUse` — fires after a tool call. **`decision: "block"` plus `reason` does NOT replace the tool result content** (verified through 2.1.116, see Gotchas). Only `hookSpecificOutput.additionalContext` lands. If you need to replace tool output, rewrite the call in `PreToolUse`.

#### OpenClaw specifics

OpenClaw plugins register hooks via the SDK's `api.on(eventName, handler)` from a TypeScript or JavaScript entry. Plugin install shape:

```
~/.openclaw/workspace/.openclaw/extensions/<plugin-id>/
├── package.json           # "openclaw": { "extensions": ["./index.ts"] }
├── openclaw.plugin.json   # { id, name, description, configSchema }
└── index.ts               # default export: (api: OpenClawPluginApi) => void
```

The events that matter most:

- `before_tool_call` — async-safe. Can rewrite `params`, block with `blockReason`, or require approval. Use for command rewriting and dangerous-call gates.
- `after_tool_call` — append-only. Returns void. Same trap as Claude Code `PostToolUse` — do not use for substitution.
- `tool_result_persist` — **strictly synchronous**. Returning `{ message }` substitutes the persisted toolResult. Promise returns are silently dropped with a warning in the gateway log. Use for substitution only when your work can run sync.
- `before_message_write` — also synchronous. Broader than `tool_result_persist` (fires for all messages, not just toolResults). Same `{ block: true }` and `{ message }` semantics.

The tool name for shell execution in OpenClaw is `"exec"`, not `"bash"`. ToolResult content is Anthropic-style `[{ type: "text", text: "..." }]`. `message.details.aggregated` holds the full raw output if OpenClaw capped `content[0].text`.

### Layer 3 — Lifecycle hooks

Use for: loading context at session start, injecting just-in-time enforcement before the next prompt, scrubbing or annotating outbound messages, per-run bookkeeping.

The canonical example on this stack is `tool-narration-guard`, a four-hook plugin that catches the agent claiming to run a tool without actually calling one. The shape is worth copying verbatim:

```
after_tool_call          → record runId in toolCallsInRun Set
llm_output               → check action-promise keywords against runId tools
                           if keywords && zero tools called for run → record violation
before_prompt_build      → if recent violations → inject prependContext warning
message_sending          → if violation → append visible warning to outbound message
agent_end                → cleanup
```

Three patterns from this plugin worth lifting:

1. **Track per `runId`, not per `lastAssistant`.** A naïve narration check on "did the last assistant message call a tool?" produces false positives in multi-turn tool-use flows. Tracking tool calls keyed on the run id (which spans the whole turn) is correct.

2. **Persist state to disk, expire by TTL.** The plugin writes its violation map to `state.json` in the plugin dir on every change, and loads it back on plugin init filtered by a configurable TTL (default 10 min). Survives gateway restarts; auto-clears stale violations.

3. **Inject enforcement at `before_prompt_build`, not at `message_sending`.** The framework's behavior shapes via the prompt, not the chat output. Putting the warning in `prependContext` reaches the model. Putting it in the outbound message just yells at the user.

For lifecycle hooks that need to scrub content, do not use `message_sending` for anything that fires on private DMs you actually rely on. Push that work to the publish-boundary CLI in Layer 1 (see Gotchas).

## Verification

After wiring hooks across the three layers, you should be able to enumerate them all in three commands:

```bash
# Layer 1 — boundary hooks
git config --get core.hooksPath; ls "$(git config --get core.hooksPath || echo .git/hooks)"

# Layer 2/3 — orchestrator hooks (Claude Code)
jq '.hooks // {}' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

# Layer 2/3 — orchestrator hooks (OpenClaw)
ls ~/.openclaw/workspace/.openclaw/extensions/
jq '.plugins.entries' ~/.openclaw/openclaw.json
```

A live behavioral hook should also show up in its plugin dir as a `state.json` (or whatever you named the persistence file). If the plugin claims to be tracking violations but `state.json` never changes, the hook isn't firing — read the gateway log for plugin-init errors.

## Gotchas

**`PostToolUse` `decision: "block"` does not replace tool output in Claude Code.** Verified persistent across Claude Code 2.1.113 through 2.1.116: a `PostToolUse` hook returning `{ "decision": "block", "reason": "<reduced text>", "hookSpecificOutput": { "additionalContext": "<hint>" } }` logs `outcome: "success"`, the agent receives the `additionalContext`, but the `tool_result` block in the transcript is byte-identical to what would have landed without the hook. The reduced text is dropped on the floor. **Fix:** if you need to *replace* tool output, rewrite the tool call in `PreToolUse` so the tool produces reduced output natively. If you need to *append*, use `additionalContext` and accept the original is still in context.

**OpenClaw `tool_result_persist` is strictly synchronous and silently drops Promise returns.** The runner logs `"[hooks] tool_result_persist handler from <pluginId> returned a Promise; this hook is synchronous and the result was ignored."` and continues with the original message. **Fix:** any substitution work must run sync. Pre-load inputs at plugin registration time, cache in module scope, then transform inline in the handler. If you genuinely need async work, pivot to `before_tool_call` (which is async-safe and can rewrite the tool's `params` so the tool produces the output you want directly).

**`message_sending` hooks scrub everything, including the DMs you rely on.** A content-scrubber prototype wired as a `message_sending` hook caught its target (generated blog text leaking internal hostnames), but it also scrubbed every chat reply the bot sent the operator. Real hostnames and ports were sometimes useful in those DMs. **Fix:** don't put publish-policy enforcement at the chat boundary. Push it to a publish-time CLI run against generated files, before they touch the publishing pipeline. The boundary you care about is "content leaves the host," not "bot sends a message."

**Naïve narration detection produces false positives in multi-turn tool-use flows.** Checking only "did the last assistant message contain a tool call?" flags valid runs where earlier turns called tools and the final turn was a clean text summary. **Fix:** track tool calls per run id across the whole turn (in `after_tool_call`), then evaluate at `llm_output` time against the run-level set. Only flag a violation when action-promise keywords appear AND zero tools were called in the entire run.

**Pre-push hooks live in `.git/hooks/` by default and are not tracked.** A hook dropped in the default location is invisible to anyone cloning the repo. **Fix:** ship the hook in a tracked directory (this repo uses `hooks/`), and instruct contributors to run `git config core.hooksPath hooks` once after cloning. The pre-push file in this repo also fails fast with a clear message if its scanner dependency isn't installed.

**Bootstrap files require an exact shape or the agent crashes with no useful error.** OpenClaw `WorkspaceBootstrapFile` entries must include `{ name, path, content, missing }`. Using nearby property names (e.g., `basename`) produces an `undefined.replace()` crash deep in plugin init with no stack pointing at the offending file. **Fix:** validate against the SDK type before shipping a bootstrap-injecting hook. The relevant type lives in `dist/plugin-sdk/agents/workspace.d.ts` of the OpenClaw install.

## Templates

- [`templates/hooks/pre-push`](../templates/hooks/pre-push) — git pre-push wrapper that runs content-guard against the working tree
- [`templates/hooks/claude-code-posttooluse.json`](../templates/hooks/claude-code-posttooluse.json) — Claude Code `~/.claude/settings.json` snippet for a `PostToolUse` hook (with the `additionalContext`-only caveat baked into the comment)
- [`templates/hooks/openclaw-sync-hook.ts`](../templates/hooks/openclaw-sync-hook.ts) — OpenClaw plugin skeleton for a synchronous `tool_result_persist` substitution hook, with the Promise-return warning called out

## Related

- [`automation/cron-patterns.md`](cron-patterns.md) — three-layer scheduling model that the hook layering here mirrors
- [`automation/sandbox-shims.md`](README.md) (planned) — wrapping git/network/exec for sub-agents that should not have free access; pairs with tool-call hooks
- [`security/publish-time-scrubbing.md`](../security/) (planned) — deep dive on the publish-boundary CLI pattern, including the rule set and false-positive handling
- [content-guard](https://github.com/solomonneas/content-guard) — the policy-driven scanner the pre-push template depends on
- [tokenjuice](https://github.com/vincentkoc/tokenjuice) — Claude Code `PostToolUse` reducer; useful prior art for the `additionalContext`-only constraint
