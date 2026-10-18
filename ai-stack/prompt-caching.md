# Prompt Caching: Maximize Cache Hits, Minimize Token Costs

How OpenClaw's prompt caching works across providers, how to keep your cache hit rate high, and the anti-patterns that silently cost you money every turn.

**Tested on:** OpenClaw 2026.10.4 with GPT 6.1 Sol (Codex runtime) as main, Claude models on the `claude-cli` runtime, cache-ttl context pruning
**Last updated:** 2026-10-17

---

## Caching By Provider

The advice in this guide applies across providers, but the mechanics differ. OpenClaw handles the translation automatically, so you only need to know the shape to debug cache misses.

### Anthropic (direct API)

Anthropic caches the prompt prefix server-side with explicit `cache_control` markers. OpenClaw controls this with one knob, `cacheRetention`, with values `none`, `short`, or `long`. `short` maps to Anthropic's default 5-minute ephemeral cache. `long` requests the 1-hour TTL. When unset, OpenClaw seeds `short` for direct Anthropic routes. Cache reads run roughly 90% cheaper than uncached input.

An older version of this guide documented the knob as `cacheControlTtl: "1h"` under a model's `params`. That key is not in my live config, and the current reference docs list `cacheRetention` instead. If you carry the old key forward, check whether your release still reads it.

On my setup the knob is moot for Claude: Opus 5.5 and Sonnet 5.5 run through the `claude-cli` runtime (`agentRuntime.id` on the model entry), so Claude Code manages its own caching and OpenClaw's `cacheRetention` never applies. The Anthropic rules about stable prefixes still hold, because the same prefix discipline helps whichever runtime serves the turn.

### OpenAI (Main Agent Path)

OpenAI caches automatically on repeated prefixes. There is no explicit `cache_control` block. You keep the prefix stable. My main agent is GPT 6.1 Sol on the `codex` runtime, signed in with a subscription, so the cost is flat-rate and caching savings show up as *rate-limit headroom* rather than a dollar reduction. Breaking the cache still costs you: it eats more of the quota faster.

Two OpenAI-specific details from the OpenClaw reference docs are worth knowing. Changing the model always starts a new cache lineage, and changing the thinking or reasoning level can also invalidate reuse even when the prompt is identical. If cache continuity matters, pick the model and thinking level when you create the session and start a new session for a planned change instead of flipping them mid-conversation.

### Other Backends

OpenClaw supports other provider backends (OpenRouter, hosted open-weight models). The hygiene rules in this guide still apply (stable prefix, no mid-session bootstrap edits), but the per-turn savings are less visible on providers that handle context management internally. If you add a backend, measure whether your bootstrap stability is actually helping before assuming.

## OpenClaw Cache Configuration

OpenClaw handles caching automatically, and my live config sets almost nothing for it. This is everything cache-related under `agents.defaults` (checked with `jq '.agents.defaults | keys'` and a search for `cache` and `ttl` keys across the whole file):

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m",
        "hardClear": {
          "enabled": true,
          "placeholder": "[tool output pruned]"
        }
      },
      "compaction": {
        "mode": "safeguard",
        "memoryFlush": { "enabled": true }
      }
    }
  }
}
```

That is the whole list. There is no `cacheRetention`, no `cacheControlTtl`, and no per-model `params` block anywhere in the file. Every model entry carries only its `agentRuntime`. Everything else comes from defaults. If you want to tune retention on a direct Anthropic route, the documented merge order (later wins) is `agents.defaults.params`, then `agents.defaults.models["provider/model"].params`, then the per-agent entries under `agents.entries`.

The pruning `ttl` of `5m` matches the default Anthropic window. `cache-ttl` pruning trims old tool results once the cache window has elapsed, so a request after an idle gap does not re-cache oversized history. Matching the TTL to the provider's real window (5 minutes for the default Anthropic cache) is the point. A pruning TTL longer than the cache TTL prunes too late to help.

OpenClaw can also keep a cache warm with heartbeats (`agents.defaults.heartbeat.every`, for example `"55m"` against a 1-hour cache). Mine is set to `"0m"`, which is off, because the main model's cost is flat-rate.

**Do not change these without a specific reason.** Bootstrap file order, system prompt section ordering, and skill delivery order are decided by OpenClaw's runtime, not by config. Don't try to reorder context via hooks.

## Bootstrap File Load Order

Workspace files are injected into the system prompt, ahead of the conversation. The current reference docs list these:

```
AGENTS.md
SOUL.md
IDENTITY.md
USER.md
BOOTSTRAP.md   (only on a brand-new workspace)
MEMORY.md      (when present)
────────────────────
Skills prompt, tool definitions
────────────────────
User message + conversation history
```

Older releases also injected a `HEARTBEAT.md`. Heartbeat scratch is no longer a bootstrap file, and my workspace has none. Order inside the prefix is not configurable. What you control is the content and its stability.

Two details change the picture on the Codex runtime. First, OpenClaw does not repeat stable workspace files in every user turn there: Codex loads the execution folder's `AGENTS.md` through its own project-doc discovery. Second, `MEMORY.md` is not pasted into each Codex turn when memory tools are available. The turn gets a short note pointing at `memory_search` and `memory_get` instead. On other runtimes `MEMORY.md` is injected, so keeping it small still pays.

Volatile sections (runtime info, messaging hints, group context) are appended below an internal cache boundary, so they do not break the stable prefix above it. Whatever you control sits above that line and has to stay byte-identical between requests.

Size limits truncate with a notice rather than failing. Defaults are 20,000 characters per file and 60,000 total. Mine are raised to `bootstrapMaxChars: 40000` and `bootstrapTotalMaxChars: 120000`.

## Cache Hygiene Rules

### 1. Never Edit Bootstrap Files Mid-Session

SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md, USER.md are all part of the cached prefix. Editing any of them mid-session invalidates the cache for all remaining turns.

**Wrong:**
```
Turn 15: Agent updates TOOLS.md with a new port number
Turn 16-50: Cache miss on every turn, full-price prefix
```

**Right:**
```
Turn 15: Agent notes the port change in a tool result message
Session boundary: Agent updates TOOLS.md between sessions
Turn 1 of next session: New cache built with updated TOOLS.md
```

### 2. Keep MEMORY.md as a Slim Index

On runtimes that inject it, MEMORY.md is in the cached prefix and every edit invalidates the cache. Keep it small (mine is about 4KB) and static. Write detailed information to knowledge cards (`memory/cards/*.md`) which are searched semantically, not loaded into the prompt.

### 3. Hook-Injected Files Must Be Deterministic

If you use OpenClaw hooks that inject bootstrap files, the content must be identical every request. No timestamps, no request counters, no dynamic content. Static strings only.

**Wrong:**
```markdown
# Rules (injected at 2026-03-17T08:15:23Z)
Always check the local API first.
```

**Right:**
```markdown
# Rules
Always check the local API first.
```

### 4. Don't Edit Files to Communicate State

If your agent needs to signal a state change (switching modes, updating a plan), use system messages or tool results. Don't rewrite a bootstrap file, because that breaks the cache.

### 5. Keep the Skill List Stable

The skills prompt (item 10) includes available skills. Adding or removing skills mid-session changes the prefix. Load all skills you might need at session start.

## Anti-Pattern Reference

| Anti-Pattern | Cache Impact | Fix |
|-------------|-------------|-----|
| Edit SOUL.md mid-session | Full invalidation | Use system messages for state changes |
| Timestamp in bootstrap file | Invalidation every request | Move timestamps to user message |
| Dynamic hook content | Invalidation per request | Make hooks deterministic |
| Add/remove skills mid-session | Partial invalidation | Keep skill list stable |
| Shuffle tool definitions | Invalidation (order matters) | Maintain alphabetical/stable order |
| Frequent MEMORY.md updates | Invalidation per edit | Write to cards, keep index slim |

## Cost and Quota Impact

### Pay-Per-Token Path (Direct Anthropic API)

Illustrative arithmetic for a ~10K token prefix, using Opus-class pricing of $15 per million input tokens with cache reads at 10% of that. Check current pricing for the model you actually run. The ratios are what matter.

| Scenario | Cost per Turn (prefix) | 50-Turn Session |
|----------|----------------------|-----------------|
| Perfect cache hits | $0.015 | $0.75 |
| Cache broken at turn 25 | $0.015 × 24 + $0.15 × 26 | $4.26 |
| No caching at all | $0.15 | $7.50 |

One mid-session bootstrap edit at turn 25 costs an extra $3.51 over the remaining session. Over a month of daily sessions, that adds up. (This ignores cache write premiums, which make a rebuild slightly more expensive than the table shows.)

### Subscription Path (Codex, Claude via Claude Code)

On a flat-rate subscription, a cache miss doesn't show up on your bill - it shows up as earlier rate-limit throttling. A session that used to last 4 hours might hit the hourly cap at 2.5 hours if you're invalidating the prefix every turn. Same effect on your workflow, different failure mode.

## Verification

There's no direct way to query a provider's cache status from the client, but you can verify the config is what you think it is and the prefix is stable:

```bash
# What cache-related config is actually set? (expect only contextPruning and compaction)
jq '.agents.defaults | keys' ~/.openclaw/openclaw.json
jq '.agents.defaults.contextPruning' ~/.openclaw/openclaw.json
jq -r '[paths(scalars) | map(tostring) | join(".")] | .[] | select(test("cacheRetention|cacheControlTtl"))' ~/.openclaw/openclaw.json

# Bootstrap file sizes (smaller = more stable cache)
echo "=== Bootstrap File Sizes ==="
for f in AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md; do
  if [ -f ~/.openclaw/workspace/$f ]; then
    SIZE=$(wc -c < ~/.openclaw/workspace/$f)
    printf "%-20s %6d bytes\n" "$f" "$SIZE"
  fi
done

# Check MEMORY.md isn't too large
echo ""
MEMSIZE=$(wc -c < ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo 0)
if [ "$MEMSIZE" -gt 6144 ]; then
  echo "⚠ MEMORY.md is $MEMSIZE bytes - consider trimming for cache efficiency"
else
  echo "✓ MEMORY.md is $MEMSIZE bytes (cache-friendly)"
fi

# Check for dynamic content in bootstrap files
echo ""
echo "=== Checking for Dynamic Content ==="
grep -rn "$(date +%Y)" ~/.openclaw/workspace/IDENTITY.md ~/.openclaw/workspace/SOUL.md 2>/dev/null && echo "⚠ Date found in bootstrap files" || echo "✓ No dynamic dates in bootstrap files"
```

Expected: the `keys` list includes `compaction` and `contextPruning` but nothing cache-named, `contextPruning` shows `mode: "cache-ttl"` and `ttl: "5m"`, the third command prints nothing, and every file is under the per-file limit you have configured.

To see real cache behavior, run `/status` in a session: OpenClaw normalizes provider usage into `cacheRead` and `cacheWrite` counters wherever the provider exposes them.

## Gotchas

1. **The cache TTL is short unless you ask for long.** Anthropic's default window is 5 minutes, and `cacheRetention: "long"` requests 1 hour. Once the window passes, the next turn pays full price for the prefix. My pruning TTL is 5 minutes for the same reason. This is fine for active sessions but intermittent usage benefits less.

2. **OpenRouter uses ephemeral caching.** The behavior is slightly different from direct Anthropic API calls. OpenClaw handles the translation automatically, but cache lifetime may vary.

3. **Compaction resets the cache.** When OpenClaw compacts your conversation history (to fit within context limits), the conversation portion changes significantly. The prefix cache survives, but any context-dependent caching at the provider level may reset.

4. **You can't force a cache build.** The cache is built automatically on the first request with a given prefix. There's no "warm the cache" command. The first turn of each session always pays full price for the prefix.

5. **History: context pruning used to split tool_use/tool_result pairs.** On older releases the pruner could remove a `tool_result` while keeping its `tool_use`, which produced a hard Anthropic API error (`tool_use ids were found without tool_result blocks`). No cache advice helped. The only fix was a fresh conversation. The current release line no longer does this, but if you run an older release and hit that error, start a new session.

6. **Cache advice applies even without Anthropic.** If your main is a GPT model on a Codex subscription, the rules above still protect your quota. Stable prefix = more effective throughput before you hit the weekly cap.

7. **Switching thinking level mid-session is an edit too.** Changing the reasoning level can invalidate reuse on OpenAI routes even when the prompt text is unchanged. Treat it like a bootstrap edit: do it at a session boundary.
