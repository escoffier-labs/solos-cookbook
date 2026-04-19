# Memory Management & Token Optimization

How to build an AI agent memory system that doesn't eat your context window alive. From raw conversation history to semantic search with local embeddings.

**Tested on:** OpenClaw 2026.4.x with Ollama (qwen3-embedding:8b), 64GB RAM host
**Last updated:** 2026-04-19

---

## The Problem

Every OpenClaw session starts fresh. Your agent has no memory of previous conversations unless you build a system for it. The naive approach (dump everything into one file, load it every session) works until it doesn't.

Here's what happens without memory management:
- **Token burn escalates.** Each message carries the full memory payload. A 50K token memory file means 50K tokens of overhead on every single interaction.
- **Quality degrades.** Models get worse at following instructions when stuffed with irrelevant context. Important details get buried under noise.
- **Sessions break.** Long contexts cause coherence loss. The model repeats itself, hallucinates about old tasks, or loses track of what's current.

We went through three iterations of memory architecture before landing on what works.

## Architecture: Three-Tier Memory

### Tier 1: Master Index (MEMORY.md)

A slim file (~2KB) loaded every session. Contains:
- Identity and quick context
- Agent architecture overview
- Links to where detailed info lives
- Category index of knowledge cards

**Rules:**
- Keep under 2KB. This goes into your system prompt every turn.
- Never dump raw logs here. Distill and point to cards.
- Edit only at session boundaries (edits invalidate prompt cache, see below).

### Tier 2: Knowledge Cards (memory/cards/*.md)

Atomic files, one topic per card, ~350 tokens each. Searched semantically, loaded on demand.

```
memory/cards/
├── hardware-specs.md
├── active-ports.md
├── model-chain-rules.md
├── career-seu-intel.md
├── security-posture.md
└── ... (~40 cards)
```

Each card has YAML frontmatter for search:

```yaml
---
topic: Security Audit & Hardening Status
category: security
tags: [security, firewall, ssh, audit]
created: 2026-02-20
updated: 2026-03-11
---
```

**Rules:**
- One topic per card. If you're writing about two things, make two cards.
- ~350 tokens max. If it's longer, split it.
- Update in place when information changes (new port assigned, project status change).
- Search first, load second. Use `memory_search` to find relevant cards instead of loading everything.

### Tier 3: Daily Logs (memory/YYYY-MM-DD.md)

Raw session notes. What happened, what was decided, what broke.

```
memory/
├── 2026-03-17.md
├── 2026-03-16.md
├── 2026-03-15.md
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

Configure OpenClaw to use it (nested under `agents.defaults.memorySearch`):

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",
        "remote": {
          "baseUrl": "http://localhost:11434/v1/",
          "apiKey": "ollama"
        },
        "fallback": "none",
        "model": "qwen3-embedding:8b"
      }
    }
  }
}
```

**Why qwen3-embedding:8b over nomic-embed-text (the 2026-03 recommendation):** Qwen3 embeddings gave us noticeably better ranking on memory cards with mixed domains (security, infra, career, code). Nomic is still fine if 8GB VRAM is tight — it's ~1.6GB on disk vs. ~5GB for qwen3-embedding.

### How It Works

1. Memory files get indexed by the embedding model (automatic on startup).
2. Agent calls `memory_search(query="what did we decide about the API architecture?")`.
3. Returns ranked results with file paths and line numbers.
4. Agent calls `memory_get(path, from, lines)` to pull just the relevant chunk.

Instead of loading 50K+ characters of memory, the agent loads maybe 500-1000 characters of exactly what it needs.

### Before and After

| Metric | Before (Full Load) | After (Semantic Search) |
|--------|-------------------|------------------------|
| Memory tokens per turn | 50-100K | 500-2K |
| Session quality | Degrades after 30 min | Consistent all day |
| Search accuracy | Manual (agent reads everything) | Ranked by relevance |
| API cost for memory | $0.25-0.50/turn (Opus) | ~$0.005/turn |
| Local embedding cost | N/A | $0 (Ollama) |

That's a 50-100x reduction in memory-related token usage.

## Prompt Caching: Don't Break It

Anthropic caches your system prompt prefix server-side. Cached tokens cost 90% less than uncached. OpenClaw handles this automatically, but you can break it.

### What Gets Cached

Your bootstrap files load in this order (hardcoded in OpenClaw):

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
12. User message + conversation
```

Everything from 1-11 forms the cacheable prefix. If ANY byte changes, the cache invalidates and you pay full price for the entire prefix on the next turn.

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

### Cost Impact

Two failure modes depending on your provider:

**Pay-per-token (direct Anthropic API):** Prefix cost drops ~90% with caching. A 10K-token prefix with caching runs ~$0.005/turn; without caching, ~$0.05/turn. One mid-session bootstrap edit at turn 25 costs ~$3.51 in extra spend over the remaining session.

**Subscription (Codex Pro, Claude Max via ACP):** You don't see dollars — you see rate-limit headroom. A session that used to last 4 hours hits the cap at 2.5 hours if you keep invalidating the prefix. Same pain, different dashboard. See [prompt caching](prompt-caching.md) for provider-specific detail.

## Memory Maintenance

Schedule periodic maintenance (we do it during heartbeats every few days):

1. Read recent daily logs.
2. Identify significant events, lessons, or decisions.
3. Create or update knowledge cards for anything worth keeping.
4. Remove outdated info from MEMORY.md.
5. Archive daily logs older than 30 days if desired.

Think of it like a human reviewing their journal and updating their mental model. Daily files are raw notes. Knowledge cards are curated reference material.

## Verification

```bash
# Check Ollama is running with embedding model
curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[].name' | grep -i embed
# Expected: qwen3-embedding:8b (or whatever you configured)

# Check memory file structure
echo "=== Master Index ==="
wc -c ~/.openclaw/workspace/MEMORY.md

echo ""
echo "=== Knowledge Cards ==="
ls ~/.openclaw/workspace/memory/cards/ | wc -l
echo "cards"

echo ""
echo "=== Daily Logs ==="
ls ~/.openclaw/workspace/memory/20*.md 2>/dev/null | wc -l
echo "daily log files"

echo ""
echo "=== MEMORY.md Size Check ==="
SIZE=$(wc -c < ~/.openclaw/workspace/MEMORY.md)
if [ "$SIZE" -gt 4096 ]; then
  echo "⚠ MEMORY.md is ${SIZE} bytes. Consider trimming (target: <2KB)"
else
  echo "✓ MEMORY.md is ${SIZE} bytes (healthy)"
fi
```

## Gotchas

1. **Local embeddings are more than good enough.** qwen3-embedding:8b (5GB) or nomic-embed-text (274M / 1.6GB) both beat round-tripping to OpenAI's embedding API for memory search. You need *good enough* relevance ranking, not SOTA — and the round-trip latency alone makes cloud embeddings a worse experience.

2. **Don't load the backup.** If you migrated from a monolithic MEMORY.md, the backup file might be 50-60KB. Never load it in a session. It exists for reference only.

3. **Card frontmatter matters for search.** The `tags` and `topic` fields in YAML frontmatter improve semantic search accuracy. Don't skip them.

4. **Memory search before answering.** Make it a habit: before your agent answers questions about past decisions, dates, or people, it should search memory first. This catches things the agent "forgot" because they weren't in today's context.
