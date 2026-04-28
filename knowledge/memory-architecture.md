# Memory Architecture

> Memory in an agent stack is a layered store of point-in-time claims, not live state. Pick the wrong relationship between memory and current reality and your agent will confidently recommend file paths that were renamed three weeks ago, write duplicate cards every session, and treat its own out-of-date notes as ground truth.

## What this is

Memory in an agent stack does not actually store state. It stores **claims about state at a moment in time**. The card that says "the bundle is `pi-embedded-runner-*.js` and the symbol lives at line 380" was true the day it was written. Six framework releases later the bundle was renamed and the line moved, and the memory is still sitting there saying it's at 380.

Most stacks build on top of cards + indexes + handoffs (covered in [memory-token-optimization](memory-token-optimization.md) and [claude-code-memory-handoffs](claude-code-memory-handoffs.md)) without making the point-in-time-vs-live distinction explicit. They treat memory as ground truth. The agent reads a card, recommends what it says, and the recommendation is wrong because the world moved.

This guide is the operating model that connects the primitives in the other two guides into a system you can actually trust. It covers what memory IS, what memory IS NOT, the trust hierarchy that resolves conflicts, the write loop that keeps memory non-redundant, and the decay loop that retires stale claims before they bite.

## Why this way

Three operating models exist. Two of them break:

| Model | Behavior | Failure mode |
|-------|----------|---------------|
| **Memory as ground truth** | Read card, act on what it says. | Confident recommendations against renamed paths, removed flags, replaced architecture. The agent says "as documented in the card, do X" when X no longer exists. |
| **Memory as ephemeral notes** | Read card for color, verify everything against current state every time. | No leverage from prior sessions. Same investigations repeat weekly. Cards drift further out of date because nobody is updating them when they're caught wrong. |
| **Layered trust + verify-before-recommend** | Memory is one input among several with explicit precedence: current code > current git log > recent memory > older memory > stub. Verify any specific claim (path, function, line, flag) before acting. | Slower turn time on tasks that touch a memory'd subsystem; otherwise this is the model that works. |

The cost of model 1 (ground truth) is a steady stream of wrong recommendations, none of which are obviously the agent's fault — it's just doing what the card said. The cost of model 2 (ephemeral) is that durable knowledge never accumulates and the agent's per-session quality plateaus low. The cost of model 3 is one extra `Read` or `grep` before recommending any specific identifier the memory mentions.

Pay the verify cost. The other two costs compound.

## Prerequisites

- A memory store of some kind. The patterns in this guide assume the OpenClaw cards + index + Claude Code per-project memory + cross-machine handoff inbox model from the other two knowledge guides, but the operating model generalizes to any layered memory system.
- A version-controlled codebase you can grep and read against. The trust hierarchy below leans hard on the assumption that the code itself is queryable in real time.
- Comfort dropping a memory entry the moment you find it wrong, rather than amending around it.

## Before / After

**Before:** A few months in, your stack has 100+ memory cards. The agent confidently cites a card claiming a function lives at `dist/embedded-CQnl8oWA.js:382`. The bundle hasn't been called that for five releases. You spend twenty minutes debugging why the recommendation doesn't apply to current code before realizing the citation rotted. Two cards say almost the same thing about the n8n workflow_history gotcha because nobody read the existing one before writing the second. Maintenance feels like an unpaid second job and you start wondering if memory is worth it at all.

**After:**

- Every memory entry has a creation date in its frontmatter. The system surfaces age when reading.
- Specific identifiers (file paths, function names, flag names, line numbers) are verified against current state before being relied on.
- Before writing a new card, the workflow searches for an existing one on the same topic. Updates beat creates.
- Memories that turn out wrong are deleted or replaced in place. They do not accumulate as "former truths."
- The five memory stores have explicit jobs and the trust hierarchy is written down so conflicts have a deterministic resolution.

## Implementation

### The five stores and what each is good at

| Store | What it holds | Lifetime | Authority |
|-------|---------------|----------|-----------|
| **Index** (`MEMORY.md` in OpenClaw, per-project `MEMORY.md` for Claude Code) | One-line pointers into cards | Edited at session boundaries; loaded into prompt every turn | Pointer only — never the source of truth for content |
| **Cards** (`memory/cards/*.md`) | Atomic durable knowledge, one topic per card, semantic-search-able | Updated when wrong; rarely deleted | Highest among memory stores; still subordinate to current code |
| **Daily logs** (`memory/YYYY-MM-DD.md`) | Raw session notes, what happened, what was decided | Skim today + yesterday on session start; older only via search | Time-anchored — useful for "when did this change?" queries |
| **Handoffs** (`.claude/memory-handoffs/`) | Pending durable knowledge from per-machine sessions, awaiting ingest into cards or rule docs | Move to `processed/` after ingest; review inbox for low-confidence ones | Pre-canonical — content is a *proposal* until promoted |
| **Session transcripts** (`~/.openclaw/agents/<agent>/sessions/*.jsonl`) | Full message history of past conversations | Search-only; never load whole files | Authoritative for "what was said when," but not curated |

The index never holds content. The cards never hold timeline. The daily logs never replace cards. The handoffs never bypass review. The transcripts are the audit trail, not the answer.

### The trust hierarchy

When two sources disagree, follow this order. Always.

```
Current code / file system
  > Current git log / git blame
    > Memory written in last few days
      > Memory written longer ago
        > No memory at all (better than wrong memory)
```

Concretely:

- A memory says a function lives at a specific path and line. **Read the file.** If the function isn't there, the memory is wrong; update or remove it.
- A memory says "we decided to use X over Y two months ago." **Check `git log`** for the change. If the codebase already moved past that decision, the memory is a snapshot, not a directive.
- A card claims a service runs on port 5204 and the systemd unit says 5300. **Trust the unit.** The card was right when written.
- A memory and a CLAUDE.md instruction conflict. CLAUDE.md is the user's durable instruction. Memory is your earlier observation. **CLAUDE.md wins.**

The hierarchy is the entire reason you can build on memory at all. Without it, every disagreement requires a judgment call and the cost compounds across turns.

### The verify-before-recommend rule

Memories that name specific identifiers are claims that those identifiers existed when the memory was written. They may have been renamed, removed, or never merged.

Before *recommending* (not just citing) anything from a memory:

| Memory mentions | Verify by |
|-----------------|-----------|
| A file path | `Read` it; if missing, memory is stale |
| A function or flag name | `grep` for it in current code |
| A specific line number | Read the file; lines drift even if the symbol survives |
| A bundle hash filename (`*-CQnl8oWA.js`) | Find the bundle by symbol grep, not filename — bundle hashes change every release |
| A workflow ID, container ID, port number | Query the live system once before acting |
| A "we decided X" claim | Check `git log` for the actual change |

"The memory says X exists" is not the same as "X exists now." For history queries (when did this change, why did we pick this) the memory is fine. For action queries (recommend the right command, edit the right file) verify first.

### The write loop

The default failure mode of memory is duplication. Two cards covering the same gotcha because nobody read the existing card before writing the new one. The fix is mechanical:

```
About to write a new memory entry?
├─ Search index + existing cards for the topic FIRST.
│  ├─ Existing card covers it → update in place; bump frontmatter date.
│  └─ Nothing covers it → write new card; add ONE line to index.
└─ Is the content actually durable?
   ├─ Code pattern, file path, project structure → NO. Derivable from current state.
   ├─ Git history, who-changed-what, recent commits → NO. `git log` is authoritative.
   ├─ Debugging fix recipe → NO. The fix is in the code; the commit message is the context.
   ├─ Already in CLAUDE.md → NO. Don't duplicate user instructions.
   ├─ Ephemeral task state, current conversation context → NO. Use plan/task tools.
   └─ Architecture decision, non-obvious gotcha, durable preference, security finding → YES.
```

The "is it durable" filter is the one most stacks skip. It is the difference between a memory store that is useful at month 6 and a memory store that is a maintenance burden at month 6.

Frontmatter every card. Minimum:

```yaml
---
topic: <one-line topic, used for search>
category: <coarse category>
tags: [list, of, tags]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

The dates are not decoration. They are how the trust hierarchy resolves "recent vs older."

### The decay loop

Memory accumulates wrong claims if nothing is removing them. The decay loop is what keeps the store healthy:

1. **At read time, surface age.** When a memory entry is loaded, the system should annotate it with how old the claim is. (OpenClaw and Claude Code both do this — the system reminders that say "this memory is N days old" exist for exactly this reason.)
2. **At verify time, replace stale claims.** When verify-before-recommend catches a memory that's wrong (path renamed, line moved), update the card immediately. Bump the `updated` date. Do not amend around the wrong claim with a "(formerly at line 380, now at line 414)" note — those don't decay either.
3. **At conflict time, drop the loser.** If a memory contradicts current code or git log, the memory is wrong. Update or delete. Do not record a new memory saying "the old card is wrong" — that is two pieces of incorrect state.
4. **At maintenance time, prune handoff inbox.** Anything in the review inbox older than ~30 days is either content nobody decided on (delete) or content that has already become true another way (delete).

The decay loop is the part most stacks miss. They write enthusiastically, verify reluctantly, and never delete. After six months the index is full of pointers to claims that haven't been true for months.

### Cross-store reconciliation

The five stores can disagree with each other. The reconciliation rules:

- **Index disagrees with the card it points at:** card wins. Update the index.
- **Card disagrees with a daily log:** card wins for *current state*; daily log wins for *what happened on that date*. Both can be right.
- **Handoff in inbox disagrees with an existing card:** if confidence is high, update card and process handoff. If not, leave handoff in review until you've resolved which is right.
- **Card disagrees with session transcript:** transcript is what was said; card is what you decided. Card wins for go-forward state.
- **Anything in memory disagrees with current code:** code wins. Update memory.

When in doubt, the answer is always: re-derive from current state, then update memory.

## Verification

You should be able to answer five questions about your memory store at any moment:

```bash
# 1. How many cards do I have? (sanity check on growth)
ls ~/.openclaw/workspace/memory/cards/*.md | wc -l

# 2. How old is the oldest card I haven't touched? (decay candidate)
ls -lt ~/.openclaw/workspace/memory/cards/*.md | tail -5

# 3. How big is the index? (cache-cost canary; see memory-token-optimization)
wc -c ~/.openclaw/workspace/MEMORY.md

# 4. How many handoffs are awaiting ingest? (pipeline health)
ls .claude/memory-handoffs/ 2>/dev/null | grep -v processed | wc -l

# 5. Are there obvious dupes? (write-loop hygiene check)
grep -h '^topic:' ~/.openclaw/workspace/memory/cards/*.md | sort | uniq -c | sort -rn | head
```

A healthy store has: index under target size, no card older than your decay budget without an `updated` bump, handoff inbox under double digits, and zero topic strings appearing twice in the dupe-check.

## Gotchas

**Stale file/line citations rot the fastest.** A card that says "function X lives at `dist/foo-CQnl8oWA.js:382`" stops being true the moment the bundle is rebuilt. Bundle hashes change every release; line numbers drift on any edit. **Fix:** never store identifiers that change frequently. Store *symbol grep targets* instead — `PLANNING_ONLY_PROMISE_RE\\s*=` survives bundle renames; the explicit filename does not. Wrap any tool that depends on a hashed bundle to find the file by symbol grep, not filename pattern.

**Duplicate cards happen when the write loop skips the read step.** "I'll write this down before I forget" produces a second card on a topic that already has one. Six months later the contradictions are lurking. **Fix:** make "search index for this topic" a hard prerequisite of writing any new card. If you find an existing card, update it. The line in the index doesn't double; the card content gets the new fact appended or merged.

**Saving the wrong things bloats the store.** "User asked me to remember they prefer tabs over spaces" — that's already in their dotfiles. "Remember the auth token is X" — that's in the credential store. "Remember we fixed the bug by checking for null first" — the fix is in the code, the why is in the commit. **Fix:** apply the durability filter from the write loop. If the answer is in current code, current git log, current dotfiles, current secrets store, or already in CLAUDE.md, do not save it. Memory is for things that those stores can't tell future-you about.

**Memory and current code disagreeing causes confidently-wrong recommendations.** This is the failure mode that drives "what breaks most" — an agent reads a card, follows the card, and the card was right two months ago but isn't now. **Fix:** verify before recommending. Memory's job is "remember this exists, here's where to look"; current code's job is "actually run." Treat them as different sources with different authorities.

**Index truncation is invisible until it bites.** Most agent harnesses load the index into the prompt and truncate past some line count (Claude Code's auto-memory truncates after ~200 lines, OpenClaw's MEMORY.md is bounded by the context budget). Pointers below the truncation line silently disappear from prompt context. **Fix:** keep the index under target size *with margin*. When it grows, consolidate (multiple related lines → one line + sub-card) before adding. Never put long content in the index itself — that's what cards are for.

**Cross-machine drift from multiple canonical writers.** If two machines both write canonical memory, eventually they diverge in non-trivial ways (one ingested handoff A first, the other B, both updated the same card differently). **Fix:** exactly one host is the canonical writer. Other hosts produce handoffs that sync to the canonical host's inbox. The pipeline is in [claude-code-memory-handoffs](claude-code-memory-handoffs.md); this guide just states the rule: one canonical writer, full stop.

**"User said remember X" is not a durability check.** A user asking you to remember something does not, on its own, mean it belongs in long-term memory. They might be venting, working through a thought, or assuming the memory system is the right fit when CLAUDE.md or a project-level note is. **Fix:** when explicitly asked to save, save the thing — but pick the right store. Stable preferences → user-profile memory. Workflow rules → `rules/*.md`. Architecture decisions → cards. Project state → conversation/plan tools, not memory.

**Conversation context written as memory rots immediately.** "We're currently debugging X, the next step is Y" is plan/task content, not memory. By the next session it's stale; by next week it's actively misleading. **Fix:** use the plan/task tools for in-flight work. Save memory only when the *outcome* of the work is durable knowledge. The thing that gets saved is "X was caused by Y because of Z," not "we are debugging X."

## Related

- [`knowledge/memory-token-optimization.md`](memory-token-optimization.md) — three-tier physical layout (index, cards, daily logs), semantic search with local embeddings, prompt-caching hygiene
- [`knowledge/claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) — cross-machine handoff format, ingester, auto-promotion rules, the canonical-writer pattern
- [`knowledge/obsidian-sync.md`](README.md) (planned) — bidirectional cloud sync that doesn't lose handoffs to conflict roulette
- [`knowledge/session-jsonl.md`](README.md) (planned) — using session transcripts as a memory source for "what was said when" questions
