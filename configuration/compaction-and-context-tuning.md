# Compaction & Context Tuning

How to configure OpenClaw's compaction, memory flush, context pruning, and session search so your agent doesn't lose its mind (or personality) during long sessions.

**Tested on:** OpenClaw with Opus 4.6, 200K context window
**Last updated:** 2026-03-23

---

## The Problem

Long sessions kill context. Here's the progression:

1. **Early in session:** Agent follows all your AGENTS.md rules, maintains personality, remembers what you said 10 messages ago.
2. **Mid session:** Context window fills up. Compaction kicks in and summarizes older exchanges. Some nuance gets lost.
3. **Late session:** Behavioral rules from AGENTS.md get compacted away. Personality drifts. The agent goes generic. Critical decisions from earlier in the session are gone.

The default compaction settings are conservative. They protect the model from running out of context, but they don't protect *your* context from being destroyed. These five config changes fix that.

**Important:** Use `config.patch` for all of these. Never `config.apply` unless you're intentionally replacing your entire config file.

## Pre-flight: Schema Validation

Before patching anything, confirm the fields exist in your OpenClaw version:

```
config.schema.lookup → agents.defaults.compaction
config.schema.lookup → memory
```

If a field doesn't exist in the schema, your OpenClaw version may not support it yet. Check the docs or update.

---

## Step 1: Compaction Tuning

**What it does:** Controls how aggressively OpenClaw summarizes older conversation history to free up context window space.

**Path:** `agents.defaults.compaction`

```json
{
  "mode": "safeguard",
  "keepRecentTokens": 20000,
  "recentTurnsPreserve": 4,
  "maxHistoryShare": 0.7,
  "reserveTokens": 30000
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `mode` | `"safeguard"` | Only compacts when context pressure is real, not preemptively |
| `keepRecentTokens` | `20000` | Protects the last 20K tokens from summarization |
| `recentTurnsPreserve` | `4` | Always keeps the last 4 full exchanges intact |
| `maxHistoryShare` | `0.7` | History can use up to 70% of the context window |
| `reserveTokens` | `30000` | Keeps 30K tokens free for the model's response and tool use |

**Tuning notes:**
- If you use a model with a smaller context window (e.g., 32K), reduce `keepRecentTokens` to 8000-10000 and `reserveTokens` to 15000.
- `recentTurnsPreserve: 4` is a minimum. If your workflow involves multi-step reasoning across exchanges, bump to 6-8.

---

## Step 2: Memory Flush

**What it does:** Before compaction destroys context, memory flush tells the agent to write important information to disk. Think of it as an auto-save before the game overwrites your checkpoint.

**Path:** `agents.defaults.compaction.memoryFlush`

```json
{
  "enabled": true,
  "softThresholdTokens": 32000,
  "forceFlushTranscriptBytes": "2mb",
  "prompt": "Write a durable session note to memory/YYYY-MM-DD.md (use today's date). Capture: decisions made, corrections given, constraints or preferences learned, open questions with owners, new projects or resources discovered, any state that would break the plan if forgotten. If nothing meaningful happened, write NO_FLUSH.",
  "systemPrompt": "Be terse. Prefer bullet points. Do not rewrite the conversation."
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `enabled` | `true` | Turns on auto-flush |
| `softThresholdTokens` | `32000` | Triggers flush when context exceeds 32K tokens |
| `forceFlushTranscriptBytes` | `"2mb"` | Forces flush when raw transcript exceeds 2MB |
| `prompt` | *(see above)* | Tells the agent exactly what to capture |
| `systemPrompt` | *(see above)* | Keeps the flush output concise |

**Tuning the prompt:**
The default prompt above captures the most critical session state. Customize it based on what matters to your workflow:
- Working on code? Add "file paths modified, test results, and unresolved errors."
- Research heavy? Add "sources consulted, key findings, and remaining questions."
- The `NO_FLUSH` escape hatch prevents empty files from cluttering your memory directory.

**Tuning the threshold:**
- `softThresholdTokens: 32000` works well for 200K context models. For smaller contexts, set this to roughly 40-50% of your model's window.
- The byte-based `forceFlushTranscriptBytes` catches cases where many tool outputs bloat the transcript without proportionally increasing token count.

---

## Step 3: Post-Compaction Rule Re-injection

**What it does:** After compaction summarizes old context, your behavioral rules from AGENTS.md may get compressed or lost. This setting re-injects specific sections from AGENTS.md after every compaction, so your agent's personality and operating rules survive indefinitely.

**Path:** `agents.defaults.compaction.postCompactionSections`

First, check what sections exist in your AGENTS.md:

```bash
grep -n '^## \|^### ' AGENTS.md
```

Then pick the sections that contain critical behavioral rules:

```json
["Every Session", "Memory", "Safety"]
```

**How to choose sections:**
- **Always include:** Startup behavior, safety rules, memory workflow
- **Usually include:** Communication style, delegation rules, tool preferences
- **Skip:** Project-specific sections, temporary sprint goals, large reference tables

**Why this matters:**
Without re-injection, a 4-hour session will gradually lose your agent's personality. It starts following instructions loosely, forgets writing rules (like "no em dashes"), and reverts to generic assistant behavior. Re-injection prevents this drift.

**Sizing note:** Each re-injected section costs tokens on every turn after compaction. Keep the total under ~2000 tokens. If a section is too large, extract the critical rules into a dedicated smaller section.

---

## Step 4: Context Pruning

**What it does:** Trims old, bloated tool outputs (web fetches, file reads, large API responses) from your context window. These outputs served their purpose when they were fresh but are dead weight 30 minutes later.

**Path:** `agents.defaults.contextPruning`

```json
{
  "mode": "cache-ttl",
  "ttl": "2h",
  "keepLastAssistants": 10,
  "minPrunableToolChars": 2000
}
```

**What each field does:**

| Field | Value | Why |
|-------|-------|-----|
| `mode` | `"cache-ttl"` | Time-based pruning of stale content |
| `ttl` | `"2h"` | Tool outputs older than 2 hours get pruned |
| `keepLastAssistants` | `10` | Always keeps the last 10 assistant messages intact |
| `minPrunableToolChars` | `2000` | Only prunes tool outputs larger than 2000 chars |

**Why cache-ttl:**
A single `web_fetch` can dump 50K characters into your context. Multiply that by a few research queries and you've burned half your window on content you referenced once. Cache-TTL prunes these after the configured time while keeping recent tool outputs available for follow-up questions.

**Tuning notes:**
- Shorten `ttl` to `"1h"` or `"30m"` if you do lots of web research or file scanning in a single session.
- Increase `minPrunableToolChars` to `5000` if you want to keep smaller tool outputs around longer (they cost less anyway).
- `keepLastAssistants: 10` ensures the agent always has its recent conversation thread intact regardless of tool output pruning.

---

## Step 5: QMD Session Transcript Search

**What it does:** Enables semantic search over raw conversation transcripts from past sessions. Without this, `memory_search` only searches your MEMORY.md and knowledge card files. With it, your agent can find specific things said in previous conversations.

**Path:** `memory.qmd.sessions`

```json
{
  "enabled": true,
  "retentionDays": 90
}
```

Also confirm this is set:

```json
// memory.qmd.includeDefaultMemory should be true
```

**Why 90 days:**
Session transcripts are large. Retaining them indefinitely bloats your search index and slows queries. 90 days gives you three months of searchable history, which covers most "what did we decide about X last month?" questions. Increase to 180 if you have long-running projects with infrequent check-ins.

---

## Verification

After applying all patches, verify with `config.get`:

```
config.get → agents.defaults.compaction
config.get → memory
```

Confirm:
- `compaction.mode` is `"safeguard"`
- `compaction.memoryFlush.enabled` is `true`
- `compaction.postCompactionSections` contains your chosen section names
- `contextPruning.mode` is `"cache-ttl"`
- `memory.qmd.sessions.enabled` is `true`

---

## How These Work Together

Here's the lifecycle during a long session:

1. **Early session (< 32K tokens):** Everything works normally. Full context available.
2. **Approaching threshold (32K tokens):** Memory flush triggers. Agent writes key decisions and state to `memory/YYYY-MM-DD.md`.
3. **Context pressure builds:** Context pruning removes stale tool outputs older than 2 hours.
4. **Compaction triggers:** Safeguard mode compresses older exchanges but protects the last 20K tokens and 4 exchanges.
5. **Post-compaction:** Behavioral rules from AGENTS.md are re-injected. Agent retains personality and operating rules.
6. **Next session:** Agent searches QMD transcripts and memory files to recover context from previous sessions.

The result: your agent maintains personality across multi-hour sessions, preserves critical decisions to disk before they're lost, and can recall past conversations through semantic search.

---

## Common Mistakes

- **Setting `keepRecentTokens` too high** on small-context models. If your model only has 32K tokens, keeping 20K recent means compaction has almost no room to work. Scale proportionally.
- **Forgetting to customize `postCompactionSections`** for your AGENTS.md structure. The default example `["Every Session", "Memory", "Safety"]` only works if those exact section names exist in your file.
- **Setting `softThresholdTokens` too low.** If flush triggers on every other message, you'll get dozens of near-empty memory files. Set it high enough that flush only fires when there's real content to preserve.
- **Not verifying after patching.** `config.patch` merges silently. If you typo a field name, it creates a new (ignored) field instead of failing. Always verify with `config.get`.
