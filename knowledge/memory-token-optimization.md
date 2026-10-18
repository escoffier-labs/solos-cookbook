# Memory Management & Token Optimization

How to build an agent memory system that does not eat your context window alive. From a slim bootstrap index to semantic search with local embeddings, plus the scheduled jobs that keep the card set honest.

**Tested on:** OpenClaw 2026.10.4, Ollama with `qwen3-embedding:8b`, Brigade 0.28.0, a 64GB RAM host
**Last updated:** 2026-10-17

---

## The Problem

Every OpenClaw session starts fresh. Your agent has no memory of previous conversations unless you build a system for it. The naive approach (dump everything into one file, load it every session) works until it doesn't.

Here's what happens without memory management:
- **Token burn escalates.** Each message carries the full memory payload. A 50K token memory file means 50K tokens of overhead on every single interaction.
- **Quality degrades.** Models get worse at following instructions when stuffed with irrelevant context. Important details get buried under noise.
- **Sessions break.** Long contexts cause coherence loss. The model repeats itself, hallucinates about old tasks, or loses track of what's current.

I went through three iterations of memory architecture before landing on what works. The shape has held since: a small index in the prompt, a large card set behind search, and daily logs for raw notes. What changed over time is the scale (the card set is now in the thousands) and the maintenance tooling around it.

## Architecture: Three-Tier Memory

### Tier 1: Master Index (MEMORY.md)

A slim file loaded every session. Contains:
- Identity and quick context
- Agent architecture overview
- Links to where detailed info lives
- Category pointers into the knowledge cards

**Rules:**
- Keep it small. Mine is about 4.2KB (`bootstrap-doctor status` reports 4,254 characters against a soft limit of 17,000). The first version of this guide said 2KB, and the template says "under ~7KB". Pick a number below your soft limit and defend it.
- Never dump raw logs here. Distill and point to cards.
- Edit only at session boundaries (edits invalidate the prompt cache, see below).

There is a second, longer file at `memory/MEMORY.md`: a categorized card index of about 180 lines. Brigade's `brigade memory status` budgets that one (179 of 180 lines, 17,000 of 24,000 bytes on mine). It is navigation for people and tooling, not part of the bootstrap prompt. `bootstrap-doctor` only tracks the root `MEMORY.md`. Do not confuse the two when you check sizes.

### Tier 2: Knowledge Cards (memory/cards/*.md)

Atomic files, one topic per card, searched semantically and loaded on demand. I have 1,610 top-level card files (plus `decay/` and `archive/` subdirectories that tooling reads or ignores).

```
memory/cards/
├── active-ports.md
├── model-chain-rules.md
├── security-posture.md
├── handoff-flow.md
├── decay/            # scan-latest.json, refresh-queue.json (generated)
├── archive/          # retired cards
└── ... (1,600+ cards)
```

Each card has YAML frontmatter. At this size the frontmatter is what makes the set maintainable, not just searchable. Fields I actually use, with a current example:

```yaml
---
topic: Short subject line for search
category: security
tags: [security, firewall, ssh]
created: 2026-02-20
updated: 2026-10-01
last_reviewed: 2026-10-01
fresh_until: 2027-01-01
confidence: medium
evidence: [<brigade-evidence-id>]
---
```

Field notes from a count across the live set:

- `topic` is the most common subject field (1,208 cards). 358 older or generated cards use `title` instead. Search does not care, but pick one for new cards.
- `last_reviewed` and `fresh_until` drive the staleness scan (see below). About 1,260 cards carry the former and 1,230 the latter.
- `confidence` (`high`, `medium`, `low`, `verified`, `unknown`) and `evidence` are newer. `evidence` holds Brigade evidence ids, or a plain note such as "no evidence found on <date>" when none exists. Only a few hundred cards have them, so treat them as optional.
- `created` and `updated` predate the review fields. I still write them, but the scan reads the review fields.

**Rules:**
- One topic per card. If you're writing about two things, make two cards.
- Keep cards short enough that a search hit is useful on its own. The scan flags cards over 12,000 bytes as oversized.
- Update in place when information changes (new port assigned, project status change), and bump `last_reviewed`.
- Search first, load second. Use memory search to find relevant cards instead of loading everything.

### Tier 3: Daily Logs (memory/YYYY-MM-DD.md)

Raw session notes. What happened, what was decided, what broke.

```
memory/
├── 2026-10-16.md
├── 2026-10-15.md
├── 2026-10-14.md
└── ...
```

On session start, the agent skims today's and yesterday's logs for recent context. Older logs are only accessed through semantic search.

**Rules:**
- Write freely. These are journals, not polished docs.
- Periodically review and promote important findings to knowledge cards.
- Don't load more than 2 days of logs into context.

## Semantic Memory Search with Ollama

The key to making this work: instead of loading entire files into context, search for what's relevant and load only those chunks.

### Setup

Install Ollama and pull an embedding model:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-embedding:8b
```

Memory search config is a **top-level** `memory.search` key in `~/.openclaw/openclaw.json`. Older releases nested it under `agents.defaults.memorySearch`. On 2026.10.4 that path is empty on my install and the top-level key is the live one:

```json
{
  "memory": {
    "citations": "auto",
    "search": {
      "provider": "openai",
      "remote": {
        "baseUrl": "http://127.0.0.1:11434/v1/",
        "apiKey": "ollama"
      },
      "fallback": "none",
      "model": "qwen3-embedding:8b"
    }
  }
}
```

`provider: "openai"` means "speak the OpenAI embeddings wire format". Ollama exposes that on `/v1/`, so no real OpenAI account is involved. Ollama ignores the key value. My live file stores `apiKey` as a file SecretRef instead of a literal, which is the better habit even for a throwaway value, and OpenClaw accepts either.

**Why qwen3-embedding:8b over nomic-embed-text (the 2026-03 recommendation):** Qwen3 embeddings gave noticeably better ranking on memory cards with mixed domains (security, infra, career, code). Nomic is still fine if 8GB VRAM is tight. It's ~1.6GB on disk vs. ~5GB for qwen3-embedding. Changing the embedding model changes the vector dimensions (4096 for qwen3 here), so plan on a full reindex when you switch.

### How It Works

1. Memory files get indexed by the embedding model (OpenClaw keeps the index and an embedding cache in the agent's SQLite database).
2. The agent calls its memory search tool with a natural-language query.
3. Results come back ranked, with file path, line range, a snippet, and a blended score (vector plus full-text).
4. The agent pulls just the relevant chunk instead of the whole file.

You can run the same search by hand, which is the fastest way to check that retrieval works:

```bash
openclaw memory search "handoff ingest" --agent main --max-results 3
```

Instead of loading 50K+ characters of memory, the agent loads maybe 500-1000 characters of exactly what it needs.

### Before and After

| Metric | Before (Full Load) | After (Semantic Search) |
|--------|-------------------|------------------------|
| Memory tokens per turn | 50-100K | 500-2K |
| Session quality | Degrades after 30 min | Consistent all day |
| Search accuracy | Manual (agent reads everything) | Ranked by relevance |
| Embedding cost | N/A | Local, no per-token charge |

That is a 50-100x reduction in memory-related prompt tokens. On a subscription lane you don't see dollars for the difference. You see rate-limit headroom.

## Prompt Caching: Don't Break It

The provider-specific mechanics live in [prompt caching](../ai-stack/prompt-caching.md). The memory-specific rule is short: the bootstrap files are part of the cached prefix, so every edit to one of them costs you the cache for the rest of that session.

### What Gets Injected

`bootstrap-doctor runtime` reports the files OpenClaw tracks for the main agent: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, and `MEMORY.md`. The last two besides `MEMORY.md` are optional and absent on my install. The injection order was hardcoded when I last read it (identity first, then soul, agents, memory, tools, user, heartbeat, bootstrap, hook-injected files, skills, tool definitions). I have not re-read that order against 2026.10.4, so treat the order as a fact about older builds and the file set as the current one.

If any byte in the prefix changes, the cache invalidates and you pay full price for the whole prefix on the next turn.

### Cache Hygiene Rules

1. **Never edit SOUL.md, AGENTS.md, or TOOLS.md mid-session.** These form the cached prefix. Edit only at session boundaries.
2. **Keep MEMORY.md slim.** Every edit invalidates the prefix cache. Write to knowledge cards instead (they're searched, not loaded into the prompt).
3. **Hook-injected files must be deterministic.** No timestamps, no per-request dynamic content. Static strings only.
4. **Don't add/remove skills mid-session.** The skill list is part of the prefix.

### Anti-Patterns

| Pattern | Why It Breaks Cache | Fix |
|---------|-------------------|-----|
| Edit SOUL.md mid-session | Prefix bytes change | Use system messages instead |
| Add timestamps to bootstrap files | Different every request | Move to user message |
| Add/remove skills mid-session | Tool list changes prefix | Keep stable from session start |
| Edit files to communicate state | File content in prefix changes | Use tool results/messages |

### Size Budgets

`bootstrap-doctor status` is the read-only size report. Its defaults are a soft limit of 17,000 characters per file, a hard limit of 40,000, and a 120,000 total. The hard and total numbers match the bootstrap caps `bootstrap-doctor runtime` reads from `openclaw.json` on my install (40,000 per file, 120,000 total). Today `status` reports `AGENTS.md` at 21,831 characters (SOFT, over the soft limit but 18,000 under hard) and everything else green, 52,436 of 120,000 total. `bootstrap-doctor runtime` goes one step further and checks what OpenClaw actually injected into the last compiled prompt, so a truncated file shows up even when the file on disk looks fine. It reports `not_observed` until one full agent turn has run (cron and heartbeat runs don't count).

## Memory Maintenance

Three scheduled jobs keep the set healthy. Keep them separate.

### 1. Memory sweep

This is the judgment pass. An isolated agent turn reviews recent sessions, pulls durable decisions and corrections, updates cards, and promotes recurring mistakes into rules. Mine runs nightly. The per-job model is pinned on the job, not inherited:

```json
{
  "name": "memory-sweep",
  "schedule": {
    "kind": "cron",
    "expr": "0 22 * * *",
    "tz": "America/New_York"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Review recent sessions. Update daily logs. Create or update knowledge cards for durable decisions, corrections, and lessons. Skip trivial chatter.",
    "model": "openai/gpt-6-luna"
  },
  "delivery": { "mode": "none" },
  "sessionTarget": "isolated"
}
```

Luna is enough for this. The sweep is extraction and filing, not hard reasoning. See [cron patterns](../automation/cron-patterns.md) for how model pinning per job works.

### 2. Handoff ingest

Other harnesses and machines emit memory handoffs. A short timer ingests them so they don't rot in a folder. On my install that is a Brigade-managed systemd user timer firing every 30 minutes (`OnCalendar=*:0/30`) that runs a reviewed Brigade runbook wrapping the ingester script. Details and the safety rules are in [claude-code-memory-handoffs](claude-code-memory-handoffs.md).

### 3. Card staleness scan

The decay pass doesn't create knowledge. It finds cards whose claims are aging out and queues them for review. Brigade owns it now:

```bash
brigade memory care status --target ~/.openclaw/workspace
brigade memory care scan --target ~/.openclaw/workspace
brigade memory care plan-fixes --target ~/.openclaw/workspace
```

`scan` reads the `.brigade/memory-care.toml` config (card roots, `stale_after_days = 90`, which checks are enabled, the 12,000-byte oversized limit) and writes `memory/cards/decay/scan-latest.json` plus a refresh queue. It never edits card content. `plan-fixes` only plans metadata fixes and reports which ones are blocked because they need a current evidence review or an operator-supplied freshness date. A daily Brigade runbook runs `status` and `plan-fixes`, and a nightly OpenClaw cron job works the refresh queue.

On my set the last scan reported 565 stale cards, 603 with an expired `fresh_until`, and 333 missing a review date. That backlog is normal for a set this size, and it is the reason the scan exists.

A clean division of labor helps:

| Job | Purpose | Typical cadence |
|-----|---------|-----------------|
| Memory sweep | Distill recent work into durable memory | Nightly |
| Handoff ingest | Pull machine-local memory proposals into canonical storage | Every 30 minutes |
| Card staleness scan | Flag aging or suspicious cards for refresh | Daily |

If you blur those together, you usually get one of two bad outcomes: either the sweep becomes bloated and slow, or stale cards sit around forever because nobody owns the decay loop.

## Verification

```bash
# Ollama is running with the embedding model
curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[].name' | grep -i embed
# Expected: qwen3-embedding:8b (or whatever you configured)

# The live config uses the top-level memory.search key
jq '.memory.search | {provider, model, fallback}' ~/.openclaw/openclaw.json
# Expected: provider "openai", model "qwen3-embedding:8b", fallback "none"

# Index health: provider, model, files indexed, chunks, vector dims, FTS state
openclaw memory status
# Expected lines: "Model: qwen3-embedding:8b", "Vector dims: 4096", "FTS: ready"

# Retrieval works end to end (pass --agent when more than one agent is configured)
openclaw memory search "handoff ingest" --agent main --max-results 3
# Expected: ranked results with a path under memory/cards/, a score, and a snippet

# Bootstrap size budgets
bootstrap-doctor status
# Expected: one row per tracked file, MEMORY.md "ok", a summary line with 0 over hard

# Card count and index size
ls ~/.openclaw/workspace/memory/cards/*.md | wc -l
wc -c ~/.openclaw/workspace/MEMORY.md

# Card health
brigade memory care status --target ~/.openclaw/workspace
# Expected: reviewed/freshness counts and a short list of top issues
```

## Gotchas

1. **Local embeddings are more than good enough.** qwen3-embedding:8b (5GB) or nomic-embed-text (274M / 1.6GB) both beat round-tripping to a cloud embedding API for memory search. You need *good enough* relevance ranking, not SOTA, and the round-trip latency alone makes cloud embeddings a worse experience.

2. **`openclaw memory search` needs `--agent` on a multi-agent install.** Without it the CLI refuses with "Multiple agents are configured, but this operation has no explicit owner." That is an ownership check, not a broken index. Pass `--agent main`.

3. **Config moved.** If a guide or old config tells you to put the embedding settings under `agents.defaults.memorySearch`, check where your release reads them. On 2026.10.4 it is the top-level `memory.search` key, and `jq '.agents.defaults.memorySearch'` returns `null`.

4. **A dirty index is not an outage.** `openclaw memory status` can say `Dirty: yes` with all but a couple of files indexed. New cards land constantly, so a small gap is the steady state. Run `openclaw memory index` if the gap grows.

5. **Don't load the backup.** If you migrated from a monolithic MEMORY.md, the backup file might be 50-60KB. Never load it in a session. It exists for reference only.

6. **Card frontmatter matters for search and for decay.** The `tags` and `topic` fields improve search accuracy, and `last_reviewed` plus `fresh_until` are what the staleness scan reads. A card with no review date counts as missing, not fresh.

7. **Memory search before answering.** Make it a habit: before your agent answers questions about past decisions, dates, or people, it should search memory first. This catches things the agent "forgot" because they weren't in that day's context.

8. **Automatic promotion into `MEMORY.md` bloats it fast.** A nightly job that appended raw session fragments to the index took mine to 41KB and triggered bootstrap truncation on every run. I disabled it on 2026-05-11 and trimmed the file back. Promote into cards, never into the index.

## Related

- [`memory-architecture.md`](memory-architecture.md) - trust hierarchy and the write/decay loops
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - the ingest path for side-harness memory
- [`bootstrap-files.md`](bootstrap-files.md) - what each bootstrap file owns
- [`../ai-stack/prompt-caching.md`](../ai-stack/prompt-caching.md) - provider-specific caching mechanics
- [`../ai-stack/local-llm-fallback.md`](../ai-stack/local-llm-fallback.md) - the local embedding server
