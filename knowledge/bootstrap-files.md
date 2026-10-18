# Bootstrap Files: What Each Agent File Owns

> Your agent's personality, safety rails, memory index, and local runbook should not all live in one giant prompt. Split them by job so compaction, cache invalidation, and handoffs stay sane.

**Tested on:** OpenClaw 2026.10.4, Brigade 0.28.0, `bootstrap-doctor` (OpenClaw bootstrap auditor), Claude Code 2.1.302, codex-cli 0.163.0
**Last updated:** 2026-10-17

## What this is

Most always-on agent stacks end up with a small pile of bootstrap files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, and friends. This guide explains what each file should own, what should never go there, and how to keep the set public-safe when pieces get copied into guides or templates.

The examples assume OpenClaw as the orchestrator, but the split works for Claude Code, Codex, Hermes, and other file-backed agent harnesses. If you want this layout installed rather than copied by hand, use [Brigade](../tools/brigade.md).

## Why this way

There are three common shapes:

| Shape | Feels easy | Breaks because |
|-------|------------|----------------|
| One massive `AGENTS.md` | Everything is in one place | Every small edit invalidates the prompt cache and makes rules harder to audit |
| Tool notes mixed into memory | Fast during a crisis | Durable memory fills with stale commands, ports, and temporary paths |
| Separate files by responsibility | More ceremony | Each file has a stable job, so updates are smaller and easier to review |

The stable split is:

- identity and voice in one place
- operating rules in one place
- local commands in one place
- memory index as pointers, not prose
- cross-harness rules duplicated only where the harness actually reads them

## Prerequisites

- An agent workspace loaded into the prompt at session start
- A way to search or inspect the workspace files
- A content scrubber or pre-push scanner before publishing examples
- Comfort treating local bootstrap files as sensitive operational material

## Before / After

**Before:** every correction becomes another paragraph in `AGENTS.md`. Tool commands, host notes, user preferences, and memory cards drift into each other. The agent gets slower, rules conflict, and public docs risk leaking private paths.

**After:** every bootstrap file has one owner role. Prompt-cache churn is lower, durable memory is easier to search, and public templates can be sanitized without stripping the system's actual architecture.

## Implementation

### 1. Keep the core file contract explicit

Use this ownership map:

| File | Owns | Does not own |
|------|------|--------------|
| `AGENTS.md` | Work rules, safety rules, delegation rules, recurring workflow requirements | Long personal biography, changing tool commands, large memory entries |
| `CLAUDE.md` | Claude Code-specific global or repo rules | OpenClaw-only config, duplicate memory cards |
| `SOUL.md` | Voice, pacing, personality, interaction style | Commands, secrets, project state |
| `USER.md` | Stable user preferences and durable user context | Temporary task plans, private credentials |
| `TOOLS.md` | Commands, ports, scripts, service notes, runbooks | Personal preferences, long architecture essays |
| `MEMORY.md` | Short index pointing to memory cards and daily notes | Full memory content, transcript dumps |
| `IDENTITY.md` | Short agent identity and role | Long behavioral policy |
| `HEARTBEAT.md` (optional) | Heartbeat cadence and recurring status expectations, only if your harness sends heartbeat polls | General cron inventory |
| `SAFETY_RULES.md` | Hard boundaries that should stay visible | Soft style preferences |
| `DREAMS.md` | Generated reflections or dreaming output | Canonical facts without review |
| `INSTALL_FOR_AGENTS.md` | How another agent should enter the workspace | Project documentation for humans |

If a note fits two files, prefer the one that changes least often. For example, a one-time port fix belongs in `TOOLS.md`, and a standing rule to verify ports before publishing belongs in `AGENTS.md`.

`HEARTBEAT.md` is the one file in this table I no longer keep. My install has neither `HEARTBEAT.md` nor `BOOTSTRAP.md`, and `bootstrap-doctor status` reports both as `OPTIONAL` rather than missing. The heartbeat interval is `0m` (disabled) in my config, and periodic checks run as scheduled jobs instead (see [cron patterns](../automation/cron-patterns.md)), where the timing is exact and the history is isolated. If your harness still polls a heartbeat and you want a one-line acknowledgment contract, keep the file. If not, don't create it for symmetry.

### 2. Split global and repo-level rules

Global files should hold rules that apply everywhere:

```text
~/.codex/AGENTS.md
~/.claude/CLAUDE.md
```

Repo-level files should hold project-specific rules:

```text
<repo>/AGENTS.md
<repo>/CLAUDE.md
<repo>/.claude/CLAUDE.md
```

If both `AGENTS.md` and `CLAUDE.md` exist in a repo, use `AGENTS.md` as the shared source of truth and let `CLAUDE.md` carry only Claude-specific differences.

### 3. Keep `MEMORY.md` as an index

`MEMORY.md` is loaded early and often, so treat it like a table of contents:

```markdown
## Card Categories
- `memory/cards/security.md` - hardening decisions and recurring incident patterns
- `memory/cards/publishing.md` - publish pipeline constraints and scrub rules
- `memory/cards/agent-routing.md` - model routing and escalation notes
```

Full explanations belong in cards, daily notes, or handoff files. Raw transcripts belong in the transcript store, not the memory index.

### 4. Route durable updates through handoffs

When a side harness learns something durable, it should create a handoff instead of editing canonical memory directly.

Good handoff targets:

- `TOOLS.md` for commands, service paths, ports, and setup notes
- `USER.md` for stable preferences
- `rules/*.md` for recurring workflow policy
- `.learnings/ERRORS.md` for concrete failure records
- memory cards for architecture, root causes, and reusable concepts

This lets the canonical memory owner review and route the update.

### 5. Keep each file under a size budget

Every bootstrap file is injected into every session, so its size is a per-turn cost. `bootstrap-doctor` is the tool I use to watch that:

```bash
bootstrap-doctor status     # read-only size report against soft and hard limits
bootstrap-doctor runtime    # what OpenClaw actually injected into the last compiled prompt
bootstrap-doctor lint       # lifecycle and context drift report
bootstrap-doctor audit      # heuristic shortlist plus an LLM judge of what could move out (no mutations)
```

The defaults are 17,000 characters soft and 40,000 hard per file, 120,000 total. My current numbers: `AGENTS.md` 21.8K characters (over the soft limit, flagged `SOFT`), `TOOLS.md` 11.5K, `USER.md` 11.3K, `SOUL.md` 3.1K, `IDENTITY.md` 0.3K, `MEMORY.md` 4.3K, 52K of 120K total. A file over the soft limit still loads in full. The warning is a prompt to move a section into a card or a rule file before the hard limit starts truncating it.

`AGENTS.md` grows fastest, because every correction wants to become a standing rule. Treat that as the signal to split by job: workflow policy that only matters during one kind of task belongs in `rules/*.md` or a skill, loaded when relevant, not in the always-on file.

### 6. Scrub before publishing

Bootstrap files often contain private hostnames, local paths, channel IDs, phone numbers, and personal context. Never copy them directly into public docs.

Use deterministic replacements:

| Sensitive shape | Public placeholder |
|-----------------|--------------------|
| private hostnames | `the host`, `your-host`, `agent-host` |
| private IPs | `192.0.2.10` or `[redacted-ip]` |
| phone numbers or account IDs | `[redacted-identity]` |
| local home paths | `~/.openclaw/workspace/...` or `[redacted-path]` |
| secret env vars | `EXAMPLE_API_KEY` |

## Verification

Check the file set:

```bash
for f in AGENTS.md CLAUDE.md SOUL.md USER.md TOOLS.md MEMORY.md \
  IDENTITY.md SAFETY_RULES.md DREAMS.md INSTALL_FOR_AGENTS.md; do
  test -f "$HOME/.openclaw/workspace/$f" && echo "ok $f" || echo "missing $f"
done
# HEARTBEAT.md and BOOTSTRAP.md are optional. Absence is fine.
```

Check sizes and what is actually injected:

```bash
bootstrap-doctor status
# Expected: a row per tracked file, a "summary:" line with 0 over hard and 0 missing;
#           HEARTBEAT.md and BOOTSTRAP.md show OPTIONAL when absent

bootstrap-doctor runtime
# Expected: after at least one full agent turn, each file shows disk and injected sizes;
#           before that, "evidence not_observed" and UNKNOWN per file (cron and heartbeat runs don't count)
```

Check that memory is not turning into a giant prompt payload:

```bash
wc -c ~/.openclaw/workspace/MEMORY.md
find ~/.openclaw/workspace/memory/cards -type f -name '*.md' | wc -l
```

Run a public-safe scan before publishing copied examples:

```bash
rg -n '([0-9]{1,3}\.){3}[0-9]{1,3}|localhost:[0-9]+|@[A-Za-z0-9._-]+|token|secret|password' .
```

## Gotchas

**`CLAUDE.md` is not automatically equivalent to `AGENTS.md`.** Different harnesses read different files. If a rule must apply everywhere, put it in the file that harness actually loads or use a short repo-level bridge file.

**Editing bootstrap files mid-session can blow the prompt cache.** If the file is part of the cached prefix, a tiny change can invalidate the whole prefix. Batch edits at session boundaries when possible.

**`MEMORY.md` bloat is quiet until it hurts.** A memory index that grows into a narrative file makes every session heavier. Promote content into cards and keep the index as pointers. Mine stood at about 4.2KB in October 2026 after an automatic promotion job once pushed it past 40KB.

**A file on disk is not proof it was injected.** Truncation happens at injection time. `bootstrap-doctor status` reads the files on disk, and `bootstrap-doctor runtime` compares them with the compiled prompt. When a rule seems ignored, run `runtime` before rewriting the rule.

**An always-on file past its soft limit is a refactor ticket.** `AGENTS.md` is the usual offender. Move task-specific policy into `rules/*.md` or a skill rather than raising the limit.

**Personality files are not safety boundaries.** `SOUL.md` can make an agent more pleasant and consistent, but hard policy belongs in `AGENTS.md`, `SAFETY_RULES.md`, hooks, or tool permissions.

**Public templates need placeholders, not your real setup.** The shape is useful. The exact hostnames, channels, account IDs, and paths are not.

## Templates

- [`../templates/bootstrap/`](../templates/bootstrap/) - sanitized skeletons for the core workspace files. `HEARTBEAT.md` is marked optional there.

## Related

- [`memory-architecture.md`](memory-architecture.md) - where bootstrap files sit in the trust hierarchy
- [`memory-token-optimization.md`](memory-token-optimization.md) - keeping loaded memory small
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - routing durable knowledge back to the canonical memory owner
- [`../ai-stack/prompt-caching.md`](../ai-stack/prompt-caching.md) - why mid-session edits to these files cost you the cache
