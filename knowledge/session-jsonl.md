# Session JSONL as Memory Source, Not Noise

> Transcript logs are an audit trail and a mining seam. Treat them as search-only source material, not something to shovel raw into every prompt.

**Tested on:** OpenClaw 2026.10.4, Claude Code 2.1.302, codex-cli 0.163.0, sqlite3 3.45, `miseledger` 0.6.0
**Last updated:** 2026-10-17

## What this is

Agent harnesses keep session history on disk, and it is useful. It means you can answer "what was said when," recover the real shape of a past session, and feed a memory sweep from ground truth instead of vibes. Where the history lives depends on the harness, and for OpenClaw it moved:

| Harness | Where transcripts live now | Format |
|---------|---------------------------|--------|
| OpenClaw 2026.10 | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | SQLite: `transcript_events` rows holding the same event JSON, plus an FTS5 index |
| OpenClaw, Codex runtime | `~/.openclaw/agents/<agentId>/agent/codex-home/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL, one file per Codex run |
| OpenClaw before the move | `~/.openclaw/agents/<agentId>/sessions/*.jsonl` | JSONL, now mostly renamed `*.migrated`, `*.deleted.*.zst`, or `*.reset.*` |
| Claude Code | `~/.claude/projects/<project-path>/*.jsonl` | JSONL |
| Codex CLI | `~/.codex/sessions/` | JSONL |

The title of this guide predates the OpenClaw change. The principle (search the transcript, promote the durable fact) is unchanged. Only the way you open the file changed.

It is also dangerous if you use it lazily. Raw transcripts are noisy, repetitive, and full of ephemeral junk. If you load whole session logs into context or dump them into memory cards unchanged, you turn your memory system into a landfill.

This guide is the sane middle path: transcripts stay searchable, quotable, and auditable. Durable memory stays curated.

## Why this way

You have three choices:

| Model | Feels convenient | Failure mode |
|-------|------------------|--------------|
| **Ignore transcripts completely** | Less storage to think about | You lose the best source for "what actually happened?" |
| **Load raw transcripts into prompts or notes** | Maximum context, supposedly | Token burn explodes. Important facts drown in tool chatter. |
| **Search transcripts, then promote only durable facts** | Slightly more work | This is the one that scales. |

Conversation history and memory are different jobs.

- **Transcript logs** answer: what was said, when, by whom, in what order?
- **Memory cards** answer: what should future sessions know without rereading the whole story?

Mix those up and the system gets dumber as it gets bigger.

## Prerequisites

- OpenClaw or another agent stack that writes per-session transcripts to disk
- Basic comfort with `jq`, `grep`, `sqlite3`, or a search indexer
- A memory system with somewhere curated facts can land, such as cards, daily logs, or rules files
- Willingness to keep transcripts behind a trust boundary because they may contain sensitive content

## Before / After

**Before:** every question about prior work becomes either guesswork or a full transcript reread. Memory cards start copying giant conversation chunks. Searches surface tool spam and status chatter instead of actual decisions.

**After:**

- Transcript logs stay on disk as the audit trail
- Search pulls only the relevant slice of conversation
- Memory sweep jobs promote decisions, corrections, and lessons into cards
- Trivial chatter stays in the transcript where it belongs

## Implementation

### 1. Treat transcript logs as source material

The JSONL store is not your memory layer. It is the raw evidence layer.

Typical uses:

- "What promise did the agent make in that session?"
- "When did we decide to switch models?"
- "Did the user correct this workflow before?"
- "Which session introduced this bug or workaround?"

Not typical uses:

- Loading whole `.jsonl` files into the prompt
- Copy-pasting entire conversations into vault notes
- Treating a transcript line as a durable truth without checking whether the world has changed since then

### 2. Search first, extract second

The right workflow looks like this:

1. Search transcripts for the topic or phrase
2. Pull only the relevant span
3. Decide whether the span contains durable knowledge
4. Promote the distilled fact, not the whole transcript

That can be powered by semantic search, plain grep, or a hybrid index. The method matters less than the discipline.

### 3. Know what is worth promoting

Good candidates for promotion out of transcripts:

- A durable decision with a reason
- A correction that changes future behavior
- A workflow gotcha that already bit once
- An open question with a named owner
- A constraint that would break future work if forgotten

Bad candidates:

- Tool output that can be re-derived from current state
- Temporary plan steps
- Casual chatter
- Repetitive status updates
- Emotional framing without an operational takeaway

If the best version of the memory still looks like a chat log, it probably should not be memory.

### 4. Keep role boundaries straight

Transcript lines are not all equal.

- **User turns** are authoritative for preferences, instructions, and decisions they explicitly make
- **Assistant turns** are evidence of promises, reasoning paths, and mistakes
- **Tool turns** are evidence of system state at that moment, not permanent truth

Example:

- User says "Never push code straight to main." That is a durable rule.
- Assistant says "I am running it now" and then never called the tool. That is a workflow failure worth capturing.
- Tool says a port was open on one date. That is historical evidence, not a forever fact.

### 5. Use transcripts to drive memory sweep jobs

This is where JSONL gets genuinely useful.

A sweep job can review recent sessions and extract:

- decisions
- corrections
- newly learned constraints
- repeated failure patterns
- open questions that need owners

That is much better than relying on memory cards alone, because cards only show what already got promoted. Transcript logs show what got missed.

### 6. Keep the trust boundary tight

Transcript logs often contain:

- private prompts
- copied error output
- file paths
- secrets that appeared in tool output by mistake
- user data that should not be broadly readable

Lock down the session-log directory. If you need stronger separation between agents or users, separate them at the OS-user or host boundary, not just in prompt instructions.

### 7. Retention is part of the design

Decide upfront what stays forever and what rolls off.

- **Recent transcripts:** high-value for sweep jobs and active recall
- **Older transcripts:** keep if you need auditability, prune if you do not
- **Promoted knowledge:** should outlive the transcript that birthed it

If you retain transcripts forever, index them in a way that favors recency. Otherwise search quality quietly gets worse as the archive grows.

## Verification

Basic inspection on a host running OpenClaw 2026.10 or later:

```bash
# 1. List recent sessions the supported way (pass --agent on a multi-agent install)
openclaw sessions --agent main --limit 5
# Expected: "Session store: .../agents/main/agent/openclaw-agent.sqlite", a count, and a table

# 2. Inspect the shape of the stored events (open the database read-only)
DB=~/.openclaw/agents/main/agent/openclaw-agent.sqlite
sqlite3 -readonly "$DB" "select count(*), sum(event_json is null) from transcript_events;"
# Expected: total event rows, and how many are stored compressed (event_zstd) instead of as text

sqlite3 -readonly "$DB" "select substr(event_json,1,160) from transcript_events where event_json is not null limit 2;"
# Expected: lines like {"type":"session","version":3,...} and {"type":"message","id":...}

# 3. Search the transcript index for a phrase or decision
sqlite3 -readonly "$DB" "select role, timestamp, length(text) from session_transcript_fts where session_transcript_fts match 'memory sweep' limit 5;"
# Expected: rows with a role and an epoch-millisecond timestamp

# 4. Estimate database size (the file includes sessions and other agent data)
du -h "$DB"

# 5. The JSONL-based harnesses: count and sample
find ~/.claude/projects -name '*.jsonl' | wc -l
LATEST=$(find ~/.claude/projects -name '*.jsonl' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
head -3 "$LATEST" | jq -c 'keys'
```

Healthy signs:

- you can locate a past decision quickly
- sweep jobs can cite transcript-backed evidence without loading whole files
- memory cards created from transcripts are concise and topic-based, not chat dumps

If you want one query across every harness instead of one command per store, that is what [the evidence pipeline](evidence-pipeline.md) is for.

## Gotchas

**Old grep recipes find nothing on OpenClaw 2026.10.** A `grep -R` over `agents/*/sessions/*.jsonl` still works on old files, but live sessions are not written there any more. If your sweep job greps that path, it quietly reviews stale history and reports "nothing new". Query the SQLite store, or use `openclaw sessions`, and check that the newest result is from today.

**Open the database read-only.** The store is live, with a write-ahead log and other tables in the same file (sessions, delivery state, auth profiles). Use `sqlite3 -readonly`, never edit rows by hand, and never copy the file somewhere with looser permissions than the original. A transcript store is as sensitive as the credentials that might have appeared in it.

**Some events are compressed.** About a third of the event rows on my main agent store the payload as zstd instead of text, so `event_json` is null for them. A plain `select` on `event_json` skips those rows. The FTS index covers message text either way, so search with it first.

**Whole-transcript loading is token arson.** It feels safe because you think "more context means better answers." Usually it means the model spends half its attention on stale tool chatter and buried status noise.

**Tool messages dominate raw logs.** The most verbose thing in a session is rarely the most important thing. If your transcript mining pipeline does not explicitly down-rank tool spam, it will surface the wrong stuff.

**Assistant claims are not always facts.** A transcript is the record of what was said, not proof that the claim is still true. If the assistant said a file lived at a path three weeks ago, re-check the file today before promoting it.

**Privacy failures compound.** Session logs often contain more than people realize. A copied stack trace might include hostnames. A tool result might include tokens or private links. Keep transcript access narrow and audit it like you would any other sensitive datastore.

**Recency matters.** Old transcripts are useful, but they should not outrank yesterday's correction or this week's design change. Indexing without age-awareness turns archaeology into the default answer path.

## Related

- [`memory-architecture.md`](memory-architecture.md) - where transcript evidence fits in the trust hierarchy
- [`memory-token-optimization.md`](memory-token-optimization.md) - how transcript search plugs into a lean memory system
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - promoting durable machine-local knowledge without copying raw session logs
- [`evidence-pipeline.md`](evidence-pipeline.md) - one searchable archive over every harness's transcripts
