# Claude Code Memory Handoffs: A Sync Path Into OpenClaw

If you run Claude Code locally (in terminal sessions, in an IDE, on a separate machine) alongside an OpenClaw gateway, you end up with two memory systems. This guide describes the handoff format and ingester that keeps OpenClaw as the canonical durable-memory owner while letting Claude Code sessions produce memory as a first-class output.

**Tested on:** Claude Code 2.1.113, OpenClaw 2026.4.x, cron ingester every 30 minutes
**Last updated:** 2026-04-20

---

## The Problem

Claude Code has its own memory system (`~/.claude/projects/<project>/memory/MEMORY.md` + per-topic files). It works well for the agent that wrote the memory, but:

- It's per-machine. A handoff written on your desktop doesn't reach your homelab.
- It's per-project. A handoff written in `~/repos/foo` doesn't reach sessions working in `~/repos/bar`.
- It competes with OpenClaw's memory cards as "the place durable knowledge lives".

Two canonical memory systems is one too many. The rule on this setup: **Claude Code may keep local memory, but durable knowledge must flow back into OpenClaw.**

## Architecture

```
┌──────────────────────┐    .claude/memory-handoffs/    ┌─────────────────────┐
│  Claude Code         │────────────────────────────────►│   Handoff inbox     │
│  (any machine,       │       YYYY-MM-DD-HHMM-slug.md   │   memory/           │
│   any repo)          │                                  │   handoff-inbox/    │
└──────────────────────┘                                  └──────────┬──────────┘
                                                                     │
                                                                     ▼
                                                          ┌─────────────────────┐
                                                          │  Ingester (cron)    │
                                                          │  every 30 min       │
                                                          └──────────┬──────────┘
                                                                     │
                                             ┌───────────────────────┼─────────────────────┐
                                             ▼                       ▼                     ▼
                                     memory/cards/*.md      TOOLS.md / USER.md     .learnings/*.md
                                     (auto-promote only if  rules/*.md              (append-only)
                                      high-confidence)
```

the OpenClaw host (the OpenClaw host) owns final routing. our Windows desktop, laptops, VPS hosts all produce handoffs; only the OpenClaw host ingests.

## The Handoff Format

A handoff is a single markdown file written by Claude Code at the end of a substantial task. Format:

```markdown
# Memory Handoff

## Type
setup | workflow | bugfix | decision | security | preference | research | project-context

## Title
Short, specific title

## Summary
2–4 sentences. What happened and why it matters.

## Durable facts
- Fact 1
- Fact 2

## Evidence
- files changed: …
- commands run: …
- error strings: …

## Recommended memory action
create-card | update-card | no-card

## Target card
card-name-if-known.md

## Suggested card content
Exact durable content to save if a card should be created or updated.
Starts with YAML frontmatter:
---
topic: …
category: …
tags: [list]
---

## Target document
TOOLS.md | USER.md | rules/<name>.md | .learnings/LEARNINGS.md | .learnings/ERRORS.md | .learnings/FEATURE_REQUESTS.md

## Suggested document content
Exact content to append when this handoff should update a non-card document
instead of a memory card. Use `###` headings or deeper inside this section.
Never use `##` here — it would look like a new handoff section to the parser.
```

Two sections are mutually exclusive: a handoff is either a card promotion (`Target card` + `Suggested card content`) or a document update (`Target document` + `Suggested document content`). Never both.

## Where Handoffs Live

On any machine running Claude Code, handoffs are written to the active repo at:

```
<repo-root>/.claude/memory-handoffs/YYYY-MM-DD-HHMM-<slug>.md
```

Examples that look like a correctly named handoff:

```
2026-04-20-1537-gstack-dual-setup.md
2026-04-20-1542-openclaw-acp-permission-fix.md
```

Once ingested, the handoff is moved to `.claude/memory-handoffs/processed/` so re-runs are idempotent.

## The Closeout Instruction

Claude Code needs one durable instruction in its project or user-level CLAUDE.md to make this work without manual prompting:

```markdown
## the OpenClaw host Memory Handoff Rule

OpenClaw on the OpenClaw host is the canonical long-term memory for shared durable
knowledge. This Claude Code environment may keep local session context, but
anything durable should flow back through a Memory Handoff.

At the end of any substantial task, check whether the session produced
durable knowledge. If yes, create a Memory Handoff in
`.claude/memory-handoffs/` using the standard format. Do this without waiting
to be reminded. Prefer updating shared OpenClaw knowledge over creating
duplicate memory.
```

The rule is what makes handoffs get written *without being asked for every task*. Without the closeout instruction, Claude Code will still produce handoffs when prompted — but the point is self-directed durable-memory capture.

## The Ingester

A small Python script parses handoffs, validates them, and routes them. The conservative v1 behavior, matching what runs in production:

1. Scan `.claude/memory-handoffs/` for `*.md` files that are not in `processed/`.
2. Parse each file's `##`-delimited sections.
3. Decide: auto-promote, route to a non-card document, or drop into review inbox.
4. Move processed files to `.claude/memory-handoffs/processed/`.

Minimal skeleton:

```python
#!/usr/bin/env python3
import re, shutil, sys
from pathlib import Path
from datetime import datetime, timezone

SECTION_RE = re.compile(r"^##\s+(?P<name>.+?)\s*$", re.MULTILINE)
SAFE_CARD_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.md$")
SAFE_RULE_PATH_RE = re.compile(r"^rules/[A-Za-z0-9._-]+\.md$")
SAFE_SPECIAL_TARGETS = {
    "TOOLS.md", "USER.md",
    ".learnings/LEARNINGS.md",
    ".learnings/ERRORS.md",
    ".learnings/FEATURE_REQUESTS.md",
}

def parse(path: Path) -> dict:
    body = path.read_text()
    sections, last_name, last_pos = {}, None, 0
    for m in SECTION_RE.finditer(body):
        if last_name:
            sections[last_name.lower()] = body[last_pos:m.start()].strip()
        last_name, last_pos = m.group("name"), m.end()
    if last_name:
        sections[last_name.lower()] = body[last_pos:].strip()
    return sections

def route(sections: dict, repo: Path) -> str:
    action = sections.get("recommended memory action", "").strip().lower()
    if action in ("create-card", "update-card"):
        card = sections.get("target card", "").strip()
        content = sections.get("suggested card content", "")
        if SAFE_CARD_NAME_RE.match(card) and content.lstrip().startswith("---"):
            dest = repo / "memory/cards" / card
            dest.write_text(content)
            return f"promoted → {dest}"
    if action == "no-card":
        target = sections.get("target document", "").strip()
        content = sections.get("suggested document content", "")
        if target in SAFE_SPECIAL_TARGETS or SAFE_RULE_PATH_RE.match(target):
            dest = repo / target
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("a") as f:
                f.write("\n\n" + content.strip() + "\n")
            return f"routed → {dest}"
    # fallback: drop in review inbox
    inbox = repo / "memory/handoff-inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    slug = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    (inbox / f"{slug}.md").write_text(
        "\n\n".join(f"## {k}\n{v}" for k, v in sections.items())
    )
    return f"inbox → {inbox}"
```

Full production version is ~200 lines with archive handling, duplicate detection, and logging. This skeleton is enough to understand the shape of the ingester.

## Auto-Promotion Rules

Only three kinds of handoffs can silently mutate canonical memory. Everything else goes to a review inbox where you look at it manually.

**Card auto-promotion:**
- `Recommended memory action` is `create-card` or `update-card`.
- `Target card` matches `^[A-Za-z0-9._-]+\.md$` (no path traversal).
- `Suggested card content` starts with YAML frontmatter (`---`).

**Document routing:**
- `Recommended memory action` is `no-card`.
- `Target document` is one of the allowed paths: `TOOLS.md`, `USER.md`, `rules/*.md`, `.learnings/*.md`.
- `Suggested document content` is present and contains no `##` headings.

Anything that doesn't meet those checks lands in `memory/handoff-inbox/` as a review draft. The inbox is designed to be scannable weekly, not ingested automatically.

**Why this is conservative:** auto-promotion writes real durable memory. A malformed or adversarial handoff becoming a memory card means every future session reads it. The safety bar is "high-confidence or route to review", not "best effort".

## Scheduling

Run the ingester on a short cron so durable knowledge stops aging in the filesystem:

```cron
*/30 * * * * bash ~/.openclaw/workspace/scripts/run-memory-handoff-ingest.sh
```

Wrap it to log cleanly and emit a `NO_UPDATES` line when nothing happened — useful for a heartbeat dashboard to distinguish "ingester didn't run" from "ingester ran and found nothing".

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${1:-$HOME/.openclaw/workspace}"
cd "$REPO_ROOT"

OUTPUT=$(python3 scripts/ingest-memory-handoffs.py --repo . \
    --promote-cards --route-documents 2>&1)
printf '%s\n' "$OUTPUT"

processed=$(printf '%s\n' "$OUTPUT" | awk '/^Processed / {print $2}' | tail -1)
promoted=$(printf '%s\n' "$OUTPUT" | awk '/^Promoted / {print $2}' | tail -1)
routed=$(printf '%s\n' "$OUTPUT"   | awk '/^Routed / {print $2}'   | tail -1)

if [[ "${processed:-0}" == "0" && "${promoted:-0}" == "0" && "${routed:-0}" == "0" ]]; then
    echo "NO_UPDATES"
fi
```

## Cross-Machine Sync

If Claude Code runs on more than one machine, only one should be the ingest point. On every other machine, the `.claude/memory-handoffs/` directory gets synced to the canonical host (the OpenClaw host in this setup) before the ingester fires.

Options that work:

1. **rclone bisync on a timer.** Simple, handles conflicts, works well if both machines are on the same LAN. Bisync every 5 minutes, ingest every 30. The window is small enough that handoffs land in OpenClaw within the same session on most workflows.

2. **Per-repo push on close.** Claude Code writes the handoff, then your shell hook or a small git-aware wrapper pushes the file to a shared branch. Ingester pulls that branch before running.

3. **SSH + rsync pull.** the OpenClaw host's ingester connects to each remote machine at ingest time, rsyncs handoffs in, then runs. Less moving parts, more latency.

What matters is that our Windows desktop/laptop/VPS handoffs are **not ingested locally.** Only the OpenClaw host writes canonical memory. The remote machines produce; the canonical host routes.

## Bootstrapping a Machine for Handoffs

On any new Claude Code install you want in the system:

1. Drop the closeout instruction into `~/.claude/CLAUDE.md` (global) or the project's `CLAUDE.md`.
2. Create `.claude/memory-handoffs/` in each repo you work in (or have Claude do it).
3. If not the canonical host, wire the sync path.
4. Test end-to-end: ask Claude Code to do a small task, then `ls .claude/memory-handoffs/` to confirm it emitted a handoff.

The test loop matters. If the closeout rule isn't firing, you won't notice for weeks — just slowly accumulating untracked durable knowledge that never reached OpenClaw.

## Verification

Check that the pipeline is alive end-to-end:

```bash
# Handoffs being produced on this machine
find ~/repos -path "*/.claude/memory-handoffs/*.md" \
    -not -path "*/processed/*" -mtime -7

# Ingester has been running
tail -20 ~/.openclaw/workspace/logs/memory-handoff-ingest.log

# Cards that landed via promotion in the last week
find ~/.openclaw/workspace/memory/cards -mtime -7 -name "*.md"

# Review inbox depth (shouldn't accumulate forever)
ls ~/.openclaw/workspace/memory/handoff-inbox/ | wc -l
```

An inbox that grows unboundedly means the auto-promotion rules are too strict for your handoff quality. An empty inbox plus zero card promotions in a week means the closeout rule isn't firing — go check CLAUDE.md on every machine.

## Gotchas

1. **`##` inside `Suggested document content` parses as a new handoff section.** The parser is naive. If your proposed content has `## Something` inside it, the ingester will think you started a new top-level section. Use `###` or deeper, or escape it.

2. **Bisync conflicts on the handoff directory are usually safe to resolve either way.** Handoff files are write-once and named with timestamps; duplicate-looking files are actually distinct handoffs. Don't auto-resolve by deleting "duplicates" — they're not.

3. **Auto-promotion writes to the filesystem on the canonical host immediately.** If that host also runs OpenClaw, a card landing mid-session invalidates the prefix cache for the remaining turns (see [Prompt Caching](prompt-caching.md)). Ingest during quiet hours if you care about cache continuity.

4. **The `processed/` folder grows forever if you don't prune.** A cron that deletes processed handoffs older than 30 days is fine — by then the durable content is either in a card or you decided it didn't belong there.

5. **Don't ingest your own OpenClaw session memory as handoffs.** It's tempting to wire the OpenClaw agent to emit handoffs about its own sessions; this creates a loop where OpenClaw ingests its own output. If you want OpenClaw to promote session knowledge to cards, do it through OpenClaw's native memory writes, not through the handoff path.
