# Compaction & Context Tuning

How to configure OpenClaw's compaction, memory flush, context pruning, and session search so your agent doesn't lose its mind (or personality) during long sessions.

**Tested on:** OpenClaw 2026.10.4 with GPT 6.1 Sol (main, 475k context window). Applies to any main model
**Last updated:** 2026-10-17

---

## The Problem

Long sessions kill context. Here's the progression:

1. **Early in session:** Agent follows all your AGENTS.md rules, maintains personality, remembers what you said 10 messages ago.
2. **Mid session:** Context window fills up. Compaction kicks in and summarizes older exchanges. Some nuance gets lost.
3. **Late session:** Behavioral rules from AGENTS.md get compacted away. Personality drifts. The agent goes generic. Critical decisions from earlier in the session are gone.

The default compaction settings are conservative. They protect the model from running out of context, but they don't protect *your* context from being destroyed. Four config blocks fix that, and a fifth section covers how past sessions stay searchable. Everything below shows what my live config actually sets. Where an older version of this guide listed a key that is no longer in the config, I say so.

**Important:** Use `config.patch` for all of these. Never `config.apply` unless you're intentionally replacing your entire config file.

## Pre-flight: Schema Validation

Before patching anything, confirm the fields exist in your OpenClaw version:

```
config.schema.lookup → agents.defaults.compaction
config.schema.lookup → memory
```

If a field doesn't exist in the schema, your OpenClaw version may not support it. Keys get retired (see the notes in each step), so a field that worked on an older release can silently stop doing anything.

---

## Step 1: Compaction Tuning

**What it does:** Controls how OpenClaw summarizes older conversation history to free up context window space.

**Path:** `agents.defaults.compaction`

This is the complete live block, minus the memory flush and the re-injected sections covered in the next two steps:

```json
{
  "mode": "safeguard",
  "keepRecentTokens": 20000,
  "recentTurnsPreserve": 4
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `mode` | `"safeguard"` | Chunked summarization with a quality audit. Compacts when context pressure is real, not preemptively |
| `keepRecentTokens` | `20000` | Cut-point budget: the most recent 20K tokens stay verbatim (also the default) |
| `recentTurnsPreserve` | `4` | Keeps the last 4 user/assistant turns verbatim outside the summary (default is 3) |

Two keys that older versions of this guide recommended, `maxHistoryShare: 0.7` and `reserveTokens: 30000`, are not in my live config and are not in the current compaction reference. Compaction now sizes the retained tail from the system prompt, tool schemas, and pending input on its own. Don't add them back from an old note.

**Other knobs worth knowing (not set on my config):** `model` runs the summaries on a different model than the session, `thinkingLevel` sets the summarizer's reasoning level (defaults to low), and `notifyUser: true` posts a short notice when compaction starts and finishes. Manual `/compact` is available in a chat when the runtime supports it. A native Codex session signed in with a subscription login supports automatic compaction but not manual `/compact`.

**Tuning notes:**
- If you use a model with a smaller context window (e.g., 32K), reduce `keepRecentTokens` to 8000-10000.
- `recentTurnsPreserve: 4` is a minimum. If your workflow involves multi-step reasoning across exchanges, bump to 6-8.
- The context window is per model. My main model runs a 475K window and the cheaper cron model 258K, so the same percentages mean different token counts.

---

## Step 2: Memory Flush

**What it does:** Before compaction destroys context, memory flush runs a silent turn that writes important information to disk. Think of it as an auto-save before the game overwrites your checkpoint.

**Path:** `agents.defaults.compaction.memoryFlush`

```json
{
  "enabled": true,
  "softThresholdTokens": 32000,
  "forceFlushTranscriptBytes": "2mb"
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `enabled` | `true` | Turns on auto-flush |
| `softThresholdTokens` | `32000` | Triggers the flush when context nears the compaction point, with this much headroom left |
| `forceFlushTranscriptBytes` | `"2mb"` | Forces the flush when the model-visible transcript reaches 2MB, even if token counters are stale |

Earlier releases let you set a custom `prompt` and `systemPrompt` on the flush, and an older version of this guide shipped one. Those fields are not in my live config. In the current release the active memory plugin supplies the flush plan (what to write and where), and `openclaw doctor` strips the retired instruction fields. If you want different flush content, change what the memory plugin writes or your AGENTS.md memory rules, not a config string.

**Optional:** `memoryFlush.model` pins the flush turn to an exact `provider/model`, for example a local one, so housekeeping doesn't spend the main model's quota. It does not inherit the session's fallback chain.

**Tuning the threshold:**
- `softThresholdTokens` is relative to the model's window. With a 475K window, 32K gives the flush plenty of room. For smaller contexts, scale it down (roughly 40-50% of the window was the old advice for 200K models).
- The byte-based `forceFlushTranscriptBytes` catches cases where many tool outputs bloat the transcript without proportionally increasing token count.

---

## Step 3: Post-Compaction Rule Re-injection

**What it does:** After compaction summarizes old context, your behavioral rules from AGENTS.md may get compressed or lost. This setting re-injects specific sections from AGENTS.md after every compaction, so your agent's operating rules survive indefinitely.

**Path:** `agents.defaults.compaction.postCompactionSections`, capped by `agents.defaults.contextLimits.postCompactionMaxChars`

First, check what sections exist in your AGENTS.md:

```bash
grep -n '^## \|^### ' AGENTS.md
```

Then pick the sections that contain critical behavioral rules. Mine, by heading name:

```json
{
  "compaction": {
    "postCompactionSections": [
      "Authority and routing",
      "First run and session privacy",
      "Browser and external action boundaries",
      "Group behavior and visible work",
      "Tools and operations",
      "Brigade and writing"
    ]
  },
  "contextLimits": {
    "postCompactionMaxChars": 6000
  }
}
```

The names have to match your headings exactly. `postCompactionMaxChars` caps the AGENTS.md excerpt injected after compaction. The default is 1800 characters, and I raised it to 6000 because six sections do not fit in 1800.

**How to choose sections:**
- **Always include:** Startup behavior, safety rules, memory workflow
- **Usually include:** Communication style, delegation rules, tool preferences
- **Skip:** Project-specific sections, temporary sprint goals, large reference tables

**Why this matters:**
Without re-injection, a 4-hour session will gradually lose your agent's operating rules. It starts following instructions loosely, forgets writing rules (like "no em dashes"), and reverts to generic assistant behavior. Re-injection prevents this drift.

**Sizing note:** Each re-injected section costs tokens on every turn after compaction, and the character cap truncates the excerpt if your sections add up to more than it. Keep the sections short enough that the whole set fits under the cap. If a section is too large, extract the critical rules into a dedicated smaller section.

---

## Step 4: Context Pruning

**What it does:** Trims old, bloated tool outputs (web fetches, file reads, large API responses) from your context window. These outputs served their purpose when they were fresh but are dead weight 30 minutes later.

**Path:** `agents.defaults.contextPruning`

```json
{
  "mode": "cache-ttl",
  "ttl": "5m",
  "hardClear": {
    "enabled": true,
    "placeholder": "[tool output pruned]"
  }
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `mode` | `"cache-ttl"` | Time-based pruning of stale content |
| `ttl` | `"5m"` | Aggressive: pruning is eligible once the cache window is 5 minutes stale |
| `hardClear.enabled` | `true` | Replace pruned tool results with a placeholder |
| `hardClear.placeholder` | `"[tool output pruned]"` | Shorter than the built-in default marker |

The configurable surface is `mode`, `ttl`, `tools`, and `hardClear`. Everything my old config also listed (`keepLastAssistants`, `softTrimRatio`, `hardClearRatio`, `minPrunableToolChars`, `softTrim.*`) is not in the live config. The thresholds and trim windows are built-in behavior now: pruning waits for the TTL, skips sessions below roughly 30% context usage, soft-trims large results first, and hard-clears only when usage is still around 50% or more with enough prunable content left. Two safety rules always apply: the last three assistant turns are never pruned, and nothing before the first user message is pruned, which protects the bootstrap reads.

**Why cache-ttl:**
A single `web_fetch` can dump 50K characters into your context. Multiply that by a few research queries and you've burned half your window on content you referenced once. Cache-TTL prunes these after the configured time while keeping recent tool outputs available for follow-up questions.

**Tuning notes:**
- If you set `mode: "cache-ttl"` and no `ttl`, the TTL is 5 minutes. The bundled Anthropic plugin seeds `1h` for Anthropic routes instead. My explicit `5m` is aggressive because I do lots of web research and file scanning. Use `"1h"` if your workflow is quieter.
- Pruning is where the cache and the context window interact. See [prompt caching](prompt-caching.md) for why the TTL should match the provider's cache window.

**History: the tool_use/tool_result split (2026-04).** On older releases the pruner could remove a `tool_result` while keeping its `tool_use`, causing a hard Anthropic API error (`tool_use ids were found without tool_result blocks`). The workaround was starting a fresh conversation. Current releases keep tool calls paired with their results when choosing compaction split points, and I have not hit the error since. If you see it on an old release, upgrade.

---

## Step 5: Searching Past Sessions

**What it does:** Lets the agent find specific things said in previous conversations.

The old version of this step enabled "QMD" session indexing under `memory.qmd.sessions` with 90-day retention. That backend is gone: QMD was removed and the builtin memory engine is the only one. `openclaw doctor --fix` deletes the retired `memory.backend` and `memory.qmd` keys and, if session indexing was on, migrates it to builtin session indexing. My live `memory` block has no `qmd` key at all:

```json
{
  "memory": {
    "citations": "auto",
    "search": {
      "provider": "openai",
      "remote": { "baseUrl": "http://127.0.0.1:11434/v1/", "apiKey": "ollama-local" },
      "fallback": "none",
      "model": "qwen3-embedding:8b"
    }
  }
}
```

That is semantic search over memory notes and knowledge cards, with a local embedding model (see [local LLM fallback](local-llm-fallback.md) for the embedding setup). Two ways to reach past conversations from here:

- **Exact recall:** the `sessions_search` tool does full-text search over user and assistant text in visible past sessions, and `sessions_history` opens a hit. This needs no config. Visibility defaults to `"all"`.
- **Semantic recall of transcripts:** opt in by adding `"sessions"` to `memory.search.sources` (the default is `["memory"]`) and enabling `experimental.sessionMemory`. I have not turned this on. I rely on knowledge cards plus `sessions_search`.

Session transcripts are large and visible transcripts can include other users' conversations, so don't enable semantic session indexing on a shared gateway without checking `tools.sessions.visibility`.

---

## Verification

Check the live values with `jq` (or `config.get` through the agent):

```bash
jq '.agents.defaults.compaction, .agents.defaults.contextPruning, .agents.defaults.contextLimits, .memory' ~/.openclaw/openclaw.json
```

Confirm:
- `compaction.mode` is `"safeguard"`
- `compaction.memoryFlush.enabled` is `true`
- `compaction.postCompactionSections` contains section names that exist verbatim in your AGENTS.md
- `contextPruning.mode` is `"cache-ttl"`
- `memory.search` is present and `memory.qmd` is absent (`jq '.memory | has("qmd")' ~/.openclaw/openclaw.json` prints `false`)

Then check every re-injected section name against the file:

```bash
jq -r '.agents.defaults.compaction.postCompactionSections[]' ~/.openclaw/openclaw.json | while read -r sec; do
  grep -q "^##* $sec\$" ~/.openclaw/workspace/AGENTS.md && echo "ok      $sec" || echo "MISSING $sec"
done
```

Expected: `ok` for every section. A `MISSING` line is a section that will never be re-injected.

---

## How These Work Together

Here's the lifecycle during a long session:

1. **Early session:** Everything works normally. Full context available.
2. **Approaching compaction (within `softThresholdTokens`, 32K here, of the trigger):** Memory flush triggers. Agent writes key decisions and state to `memory/YYYY-MM-DD.md`.
3. **Context pressure builds:** Once the cache window has gone stale (5 minutes here), context pruning trims old tool outputs.
4. **Compaction triggers:** Safeguard mode compresses older exchanges but protects the last 20K tokens and 4 exchanges.
5. **Post-compaction:** Behavioral rules from AGENTS.md are re-injected. Agent retains personality and operating rules.
6. **Next session:** Agent searches memory files and, when needed, past transcripts with `sessions_search` to recover context from previous sessions.

The result: your agent maintains personality across multi-hour sessions, preserves critical decisions to disk before they're lost, and can recall past conversations through memory search and session search.

---

## Gotchas

- **Setting `keepRecentTokens` too high** on small-context models. If your model only has 32K tokens, keeping 20K recent means compaction has almost no room to work. Scale proportionally.
- **Forgetting to customize `postCompactionSections`** for your AGENTS.md structure. A name that does not match a heading in your file re-injects nothing, and nothing warns you. Run the verification loop above.
- **Setting `softThresholdTokens` too low.** If flush triggers on every other message, you'll get dozens of near-empty memory files. Set it high enough that flush only fires when there's real content to preserve.
- **Not verifying after patching.** `config.patch` merges silently. If you typo a field name, it creates a new (ignored) field instead of failing. Always verify with `config.get`.
- **Changing bootstrap files to shift compaction behavior.** Any edit to SOUL.md, AGENTS.md, IDENTITY.md, USER.md, or MEMORY.md invalidates the whole prefix cache. Don't treat bootstrap edits as free. See [prompt caching](prompt-caching.md).
- **Carrying retired keys forward.** `maxHistoryShare`, `reserveTokens`, `keepLastAssistants`, `softTrim`, the memory flush `prompt`/`systemPrompt`, and the whole `memory.qmd` block are not in my live config. An unknown key either fails validation or sits there doing nothing, and `config.patch` will not tell you which. If a tuning knob in an old note isn't in the reference docs for your release, treat it as gone.
- **Leaving `postCompactionMaxChars` at the default with many sections.** The default cap is 1800 characters. Re-inject six sections and the tail gets truncated.
