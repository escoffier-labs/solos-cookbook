# Prompt Caching: Maximize Cache Hits, Minimize Token Costs

How OpenClaw's prompt caching works across providers, how to keep your cache hit rate high, and the anti-patterns that silently cost you money every turn.

**Tested on:** OpenClaw with OpenAI Codex (GPT 5.4) as main, ACP Opus 4.6 as escalation, cache-ttl context pruning
**Last updated:** 2026-04-19

---

## Caching By Provider

The advice in this guide applies across providers, but the mechanics differ. OpenClaw handles the translation automatically — you only need to know the shape so you can debug cache misses.

### Anthropic (Direct API and ACP Opus)

Anthropic caches the system prompt prefix server-side with explicit `cache_control` markers. OpenClaw maps `cacheControlTtl: "1h"` to `cacheRetention: "long"` on direct calls and injects `cache_control: { type: "ephemeral" }` via OpenRouter. Cache reads run ~90% cheaper than uncached input.

Since the April 2026 [claude-cli → ACP migration](claude-cli-to-acp-migration.md), Opus is no longer the main agent in most OpenClaw setups. Caching still matters on the ACP escalation path — each Opus call pays the cache penalty if the prefix shifts — but the cost surface is smaller.

### OpenAI Codex (Main Agent Path)

OpenAI caches automatically on repeated prefixes when requests come from the same API key within a short window. There's no explicit `cache_control` block; you just keep the prefix stable.

For GPT 5.4 on a Codex Pro subscription, the cost is already flat-rate, so caching savings show up as *rate-limit headroom* rather than a dollar reduction. Breaking the cache still costs you — it eats more of your weekly quota faster.

### Other Backends

OpenClaw supports other provider backends (Gemini CLI, direct Anthropic API, OpenRouter). The cache hygiene rules in this guide still apply — stable prefix, no mid-session bootstrap edits — but the per-turn savings are less visible on providers that handle context management internally. If you add a backend, measure whether your bootstrap stability is actually helping before assuming.

## OpenClaw Cache Configuration

OpenClaw handles caching automatically. The relevant config:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-6": {
          "params": {
            "cacheControlTtl": "1h"
          }
        }
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m",
        "keepLastAssistants": 3,
        "softTrim": { "maxChars": 3000 },
        "hardClear": { "enabled": true }
      },
      "compaction": {
        "mode": "safeguard",
        "memoryFlush": { "enabled": true }
      }
    }
  }
}
```

**Do not change these without a specific reason.** They represent optimal caching through config — the only user-facing knobs that actually matter for cache hit rate.

**Hardcoded internals you can't tune.** Bootstrap file load order, system-prompt section ordering, skill loading strategy, and cache metrics are all compiled into OpenClaw's runtime JS. Don't waste time trying to reorder context via hooks — it won't stick.

## Bootstrap File Load Order

OpenClaw loads workspace files into the system prompt in this order (hardcoded, not configurable):

```
 1. IDENTITY.md
 2. SOUL.md
 3. AGENTS.md
 4. MEMORY.md
 5. TOOLS.md
 6. USER.md
 7. HEARTBEAT.md
 8. BOOTSTRAP.md
 9. Hook-injected files
10. Skills prompt
11. Tool definitions
────────────────────
12. User message + conversation history
```

Items 1-11 form the **cacheable prefix**. Item 12 (conversation) changes every turn and is never cached. The entire prefix must be byte-identical between requests for the cache to hit.

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

MEMORY.md is in the cached prefix. Every edit invalidates the cache. Keep it small (~2KB) and static. Write detailed information to knowledge cards (`memory/cards/*.md`) which are searched semantically, not loaded into the prompt.

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

For a typical Opus session with a ~10K token prefix:

| Scenario | Cost per Turn (prefix) | 50-Turn Session |
|----------|----------------------|-----------------|
| Perfect cache hits | $0.015 | $0.75 |
| Cache broken at turn 25 | $0.015 × 24 + $0.15 × 26 | $4.26 |
| No caching at all | $0.15 | $7.50 |

One mid-session bootstrap edit at turn 25 costs an extra $3.51 over the remaining session. Over a month of daily sessions, that's $100+ in unnecessary spend.

### Subscription Path (Codex Pro, Claude Max via ACP)

On a flat-rate subscription, a cache miss doesn't show up on your bill — it shows up as earlier rate-limit throttling. A session that used to last 4 hours might hit the hourly cap at 2.5 hours if you're invalidating the prefix every turn. Same effect on your workflow, different failure mode.

## Verification

There's no direct way to query Anthropic's cache status from the client, but you can verify your setup is cache-friendly:

```bash
# Check bootstrap file sizes (smaller = more stable cache)
echo "=== Bootstrap File Sizes ==="
for f in IDENTITY.md SOUL.md AGENTS.md MEMORY.md TOOLS.md USER.md HEARTBEAT.md; do
  if [ -f ~/.openclaw/workspace/$f ]; then
    SIZE=$(wc -c < ~/.openclaw/workspace/$f)
    printf "%-20s %6d bytes\n" "$f" "$SIZE"
  fi
done

# Check MEMORY.md isn't too large
echo ""
MEMSIZE=$(wc -c < ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo 0)
if [ "$MEMSIZE" -gt 4096 ]; then
  echo "⚠ MEMORY.md is $MEMSIZE bytes - consider trimming for cache efficiency"
else
  echo "✓ MEMORY.md is $MEMSIZE bytes (cache-friendly)"
fi

# Check for dynamic content in bootstrap files
echo ""
echo "=== Checking for Dynamic Content ==="
grep -rn "$(date +%Y)" ~/.openclaw/workspace/IDENTITY.md ~/.openclaw/workspace/SOUL.md 2>/dev/null && echo "⚠ Date found in bootstrap files" || echo "✓ No dynamic dates in bootstrap files"
```

## Gotchas

1. **Cache TTL is 1 hour.** If your session is idle for more than an hour, the cache expires and the next turn pays full price. This is fine for active sessions but means intermittent usage doesn't benefit as much.

2. **OpenRouter uses ephemeral caching.** The behavior is slightly different from direct Anthropic API calls. OpenClaw handles the translation automatically, but cache lifetime may vary.

3. **Compaction resets the cache.** When OpenClaw compacts your conversation history (to fit within context limits), the conversation portion changes significantly. The prefix cache survives, but any context-dependent caching at the provider level may reset.

4. **You can't force a cache build.** The cache is built automatically on the first request with a given prefix. There's no "warm the cache" command. The first turn of each session always pays full price for the prefix.

5. **Context pruning can split tool_use/tool_result pairs.** When the conversation grows past the pruning threshold, the pruner may remove a `tool_result` while keeping its `tool_use` — resulting in a hard Anthropic API error (`tool_use ids were found without tool_result blocks`). No cache advice will help here; the only fix is starting a fresh conversation. Upstream fix is queued.

6. **Cache advice applies even without Anthropic.** If your main is GPT 5.4 on Codex Pro, the rules above still protect your quota. Stable prefix = more effective throughput before you hit the weekly cap.
