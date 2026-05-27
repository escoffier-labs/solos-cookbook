# Bootstrap Files: What Each Agent File Owns

> Your agent's personality, safety rails, memory index, and local runbook should not all live in one giant prompt. Split them by job so compaction, cache invalidation, and handoffs stay sane.

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
| `HEARTBEAT.md` | Heartbeat cadence and recurring status expectations | General cron inventory |
| `SAFETY_RULES.md` | Hard boundaries that should stay visible | Soft style preferences |
| `DREAMS.md` | Generated reflections or dreaming output | Canonical facts without review |
| `INSTALL_FOR_AGENTS.md` | How another agent should enter the workspace | Project documentation for humans |

If a note fits two files, prefer the one that changes least often. For example, a one-time port fix belongs in `TOOLS.md`; a standing rule to verify ports before publishing belongs in `AGENTS.md`.

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

### 5. Scrub before publishing

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
  IDENTITY.md HEARTBEAT.md SAFETY_RULES.md DREAMS.md INSTALL_FOR_AGENTS.md; do
  test -f "$HOME/.openclaw/workspace/$f" && echo "ok $f" || echo "missing $f"
done
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

**`MEMORY.md` bloat is quiet until it hurts.** A memory index that grows into a narrative file makes every session heavier. Promote content into cards and keep the index as pointers.

**Personality files are not safety boundaries.** `SOUL.md` can make an agent more pleasant and consistent, but hard policy belongs in `AGENTS.md`, `SAFETY_RULES.md`, hooks, or tool permissions.

**Public templates need placeholders, not your real setup.** The shape is useful. The exact hostnames, channels, account IDs, and paths are not.

## Templates

- [`../templates/bootstrap/`](../templates/bootstrap/) - sanitized skeletons for the core workspace files

## Related

- [`memory-architecture.md`](memory-architecture.md) - where bootstrap files sit in the trust hierarchy
- [`memory-token-optimization.md`](memory-token-optimization.md) - keeping loaded memory small
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - routing durable knowledge back to the canonical memory owner
