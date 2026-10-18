# Claude Code and Codex Memory Handoffs: A Sync Path Into OpenClaw

If you run Claude Code or Codex locally alongside an OpenClaw gateway, you end up with multiple session memories. This guide describes the shared handoff format and ingester that keep OpenClaw as the canonical durable-memory owner while letting each writing harness produce durable memory as a first-class output.

**Tested on:** Claude Code 2.1.302, codex-cli 0.163.0, Brigade 0.28.0, OpenClaw 2026.10.4, systemd timer ingester every 30 minutes
**Last updated:** 2026-10-17

Related product answers (installable path + LLM citation pages):

- [Memory handoffs across coding agents](https://brigade.tools/compare/memory-handoffs-across-coding-agents)
- [Stop Claude Code memory and bootstrap bloat](https://brigade.tools/compare/claude-code-memory-bloat)
- Install: `pipx install brigade-cli`, then see [brigade.tools](https://brigade.tools)

---

## The Problem

Claude Code has its own memory system (`~/.claude/projects/<project>/memory/MEMORY.md` + per-topic files). It works well for the agent that wrote the memory, but:

- It's per-machine. A handoff written on your desktop doesn't reach your homelab.
- It's per-project. A handoff written in `~/repos/foo` doesn't reach sessions working in `~/repos/bar`.
- It competes with OpenClaw's memory cards as "the place durable knowledge lives".

Two canonical memory systems is one too many. The rule on this setup: **Claude Code, Codex, and other side harnesses may keep local session memory, but durable knowledge must flow back into OpenClaw.**

## Architecture

```
┌──────────────────────┐    per-writer handoff inbox    ┌─────────────────────┐
│  Claude Code / Codex │───────────────────────────────►│   Writer inboxes    │
│  / other harnesses   │      YYYY-MM-DD-HHMM-slug.md   │   (one per harness, │
│  (any machine,       │                                │    per repo)        │
│   any repo)          │                                └──────────┬──────────┘
└──────────────────────┘                                           │ discover + claim
                                                                   ▼
                                                        ┌─────────────────────┐
                                                        │  Ingester           │
                                                        │  (systemd timer,    │
                                                        │   every 30 min)     │
                                                        └──────────┬──────────┘
                                                                   │
                                  ┌────────────────────────────────┼─────────────────────┐
                                  ▼                                ▼                     ▼
                          memory/cards/*.md               TOOLS.md / USER.md      .learnings/*.md
                          (auto-promote only if           rules/*.md              (append-only)
                           the plan validates)
```

The canonical OpenClaw host owns final routing. Workstations, laptops, and VPS hosts all produce handoffs. Only the canonical host ingests.

The shape is the same as the first version of this guide. What changed is how the ingester behaves. It used to move a file, write a card, and hope nothing died in between. It is now a small transaction system, described under [The Ingester](#the-ingester). The scheduler also moved: the 30-minute cron line is gone, replaced by a Brigade-managed systemd user timer that runs a reviewed runbook.

## The Handoff Format

A handoff is a single markdown file written by Claude Code or Codex at the end of a substantial task. Format:

```markdown
# Memory Handoff

## Type
setup | workflow | bugfix | decision | security | preference | research | project-context

## Title
Short, specific title

## Summary
2 to 4 sentences. What happened and why it matters.

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

## Expected card SHA256
64 hex characters. Required for update-card, omitted for create-card.
The SHA-256 of the target card as the writer last saw it.

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
Never use `##` here - it would look like a new handoff section to the parser.
```

Two sections are mutually exclusive: a handoff is either a card promotion (`Target card` + `Suggested card content`) or a document update (`Target document` + `Suggested document content`). Never both. My guarded ingest script rejects a handoff that carries fields for both.

`Expected card SHA256` is the hash guard. An `update-card` handoff replaces a whole card, so my guarded ingest script only applies it when the card on disk still hashes to the value the writer saw. If the card changed in the meantime, the handoff is rejected instead of silently overwriting the newer text. Writers get the hash with `sha256sum memory/cards/<name>.md`. A `create-card` handoff fails if the card already exists. Only the workspace's own script reads this section. Brigade 0.28.0's `brigade ingest` does not (see [The Ingester](#the-ingester)).

## Where Handoffs Live

On any machine running a side harness, handoffs are written to that harness's inbox under the active repo:

```
<repo-root>/.claude/memory-handoffs/YYYY-MM-DD-HHMM-<slug>.md
<repo-root>/.codex/memory-handoffs/YYYY-MM-DD-HHMM-<slug>.md
<repo-root>/.grok/memory-handoffs/YYYY-MM-DD-HHMM-<slug>.md
<repo-root>/.hermes/memory-handoffs/YYYY-MM-DD-HHMM-<slug>.md
```

Use `.claude/memory-handoffs/` for Claude Code and `.codex/memory-handoffs/` for Codex-driven flows, including Brigade defaults. The other two are for other writer harnesses I run. The ingester scans all of them, so which directory a harness uses matters less than keeping it consistent per harness. `brigade handoff doctor --target .` lists which of these exist, how many handoffs are pending and processed in each, and whether the ingester has run recently.

Examples that look like a correctly named handoff:

```
2026-04-20-1537-gstack-dual-setup.md
2026-04-20-1542-openclaw-acp-permission-fix.md
```

Once ingested, the handoff is moved to that inbox's `processed/` directory so re-runs are idempotent. A handoff that fails to parse is moved to a sibling `malformed/` directory instead, so it stops re-reporting on every timer tick and waits for a human.

The scan skips handoffs that git tracks. A tracked file is repository content (for example a template or a fixture), not an inbox item, and it is never transferred or archived.

## The Closeout Instruction

Claude Code needs one durable instruction in its project or user-level CLAUDE.md to make this work without manual prompting:

```markdown
## OpenClaw Memory Handoff Rule

OpenClaw is the canonical long-term memory for shared durable
knowledge. This Claude Code environment may keep local session context, but
anything durable should flow back through a Memory Handoff.

At the end of any substantial task, check whether the session produced
durable knowledge. If yes, create a Memory Handoff in
the configured handoff inbox using the standard format. Do this without waiting
to be reminded. Prefer updating shared OpenClaw knowledge over creating
duplicate memory.
```

The rule is what makes handoffs get written *without being asked for every task*. Without the closeout instruction, Claude Code will still produce handoffs when prompted, but the point is self-directed durable-memory capture.

## Codex Uses the Same Contract

Codex in this stack does not get a parallel memory system. It uses the same handoff format, routing rules, and canonical owner. New Brigade dogfood configs default Codex handoffs to `.codex/memory-handoffs/`. Older setups may still route Codex through `.claude/memory-handoffs/`.

The pattern is simple:

1. Codex keeps whatever local session context it wants.
2. Durable findings that belong to the shared stack get written to the configured handoff inbox in the active repo.
3. The canonical OpenClaw host ingests all configured writer inboxes and routes them into cards, `TOOLS.md`, `USER.md`, `rules/*.md`, or `.learnings/*.md`.

On this setup, the Codex workspace instructions explicitly say:

- follow the canonical memory handoff rule from the repo or user-level instructions
- write durable findings to `.codex/memory-handoffs/` or the repo's configured handoff inbox
- do not invent a parallel memory system

That means Claude Code and Codex converge on the same durable-memory contract. Different coding harness, same handoff schema, same ingester, same canonical storage.

## The Ingester

The first version was a short Python script that parsed a handoff and wrote the result straight to disk. It worked until a run was killed halfway between writing a card and archiving the handoff, which left a card changed and the handoff still pending to be applied a second time. The guarded script that runs on my canonical host now treats each handoff as a transaction:

1. **Discover.** A writers manifest lists each host and its inboxes. It also declares directories to walk (bounded depth) for repositories that carry a `.claude`, `.codex`, `.grok`, or `.hermes` handoff inbox. Missing declared inboxes stay visible in the receipt. A directory containing a `.no-memory-handoffs` file is skipped, and a symlinked inbox is rejected.
2. **Claim.** Each file is checked (regular file, at most 1 MiB), hashed with SHA-256, and claimed. Remote hosts transfer the exact version that was hashed, and the source is only acknowledged after the canonical host has stored it.
3. **Plan.** The ingester parses the handoff and prepares a plan that records the target path, the target's hash before, the content to write, and its hash after. Validation errors, unsafe target names, a missing `Expected card SHA256` on an update, or a hash conflict all stop here with a reason in the receipt.
4. **Commit.** The plan is applied only if the target still matches its recorded before-hash. A backup of the prior content is kept next to the plan. If a run dies after the write but before the receipt update, the next run sees the after-hash on disk and finishes the bookkeeping instead of writing twice.
5. **Archive.** The handoff moves to `processed/` under a name that includes its hash. Content already ingested (matched by hash, or by a legacy journal event) is recorded as a duplicate and not re-applied. A handoff that fails parsing is quarantined and stays out of the scan path.

Every run writes a JSON receipt and a log under `.brigade/handoff-ingest/`, so "did my handoff land, and where" has an answer that doesn't involve grepping cards.

The core of the parser and routing rules is still small enough to show. This skeleton is the shape without the transaction machinery:

```python
#!/usr/bin/env python3
import hashlib, re
from pathlib import Path

SECTION_RE = re.compile(r"^##\s+(?P<name>.+?)\s*$", re.MULTILINE)
# Only these names are section boundaries. Any other ## heading stays inline.
KNOWN = {"type", "title", "summary", "durable facts", "evidence",
         "recommended memory action", "target card", "expected card sha256",
         "suggested card content", "target document",
         "suggested document content", "reviewer notes"}
SAFE_CARD_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.md$")
SAFE_RULE_PATH_RE = re.compile(r"^rules/[A-Za-z0-9._-]+\.md$")
SAFE_SPECIAL_TARGETS = {
    "TOOLS.md", "USER.md",
    ".learnings/LEARNINGS.md",
    ".learnings/ERRORS.md",
    ".learnings/FEATURE_REQUESTS.md",
}

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def parse(path: Path) -> dict:
    body = path.read_text()
    marks = [m for m in SECTION_RE.finditer(body) if m.group("name").lower() in KNOWN]
    sections = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        sections[m.group("name").lower()] = body[m.end():end].strip()
    return sections

def plan(sections: dict, repo: Path):
    """Return (target, new_text) or None when the handoff needs human review."""
    action = sections.get("recommended memory action", "").strip().lower()
    if action in ("create-card", "update-card"):
        card = sections.get("target card", "").strip()
        content = sections.get("suggested card content", "")
        if not (SAFE_CARD_NAME_RE.match(card) and content.lstrip().startswith("---")):
            return None
        dest = repo / "memory/cards" / card
        if action == "create-card" and dest.exists():
            return None
        if action == "update-card":
            expected = sections.get("expected card sha256", "").strip().lower()
            if not dest.exists() or sha256(dest.read_bytes()) != expected:
                return None  # stale writer: review instead of overwrite
        return dest, content.rstrip() + "\n"
    if action == "no-card":
        target = sections.get("target document", "").strip()
        content = sections.get("suggested document content", "")
        if target in SAFE_SPECIAL_TARGETS or SAFE_RULE_PATH_RE.match(target):
            dest = repo / target
            old = dest.read_text() if dest.exists() else ""
            return dest, old + "\n\n" + content.strip() + "\n"
    return None
```

The production version wraps `plan()` in the claim, backup, atomic write, and receipt steps above. Do not skip those. The skeleton is enough to understand the routing, and not safe to run unattended on its own.

Brigade ships its own ingester, which follows the same routing idea but not the same guarantees:

```bash
brigade ingest --target . --dry-run                           # preview, writes nothing
brigade ingest --target . --promote-cards --route-documents   # apply
```

Both promotion paths are off by default. Without `--promote-cards` and `--route-documents`, handoffs land in the review inbox only. The hash-guarded, transactional behavior described above (claim, plan, before-hash check, backup, receipt) belongs to the workspace's guarded ingest script, not to `brigade ingest`. As of Brigade 0.28.0, `brigade ingest` recognizes only these sections: `Type`, `Title`, `Summary`, `Durable facts`, `Evidence`, `Recommended memory action`, `Target card`, `Suggested card content`, `Target document`, and `Suggested document content`. It treats `Expected card SHA256` as an unknown section and sends the whole handoff to the review inbox. So a handoff that carries a hash is never auto-promoted by `brigade ingest`, and `update-card` there has no stale-writer check. It keeps wholesale-replace semantics, backed by its other checks (safe card name, frontmatter present, injection scan, symlink and identity-migration refusals). If you rely on `brigade ingest`, omit the hash section and review `update-card` handoffs by hand, or keep the guarded script for updates.

My canonical host uses the guarded workspace script because it predates `brigade ingest` and carries the multi-host transport. A fresh setup can start with `brigade ingest` for `create-card` and document routing, and add a hash check of its own before it auto-promotes updates.

## Auto-Promotion Rules

Only two kinds of handoffs can silently mutate canonical memory. Everything else goes to a review inbox where you look at it manually. The rules below are the guarded script's. `brigade ingest` applies the same two paths with the differences noted above (no hash check).

**Card auto-promotion:**
- `Recommended memory action` is `create-card` or `update-card`.
- `Target card` matches `^[A-Za-z0-9][A-Za-z0-9._-]*\.md$` (no path traversal).
- `Suggested card content` starts with valid YAML frontmatter, and the handoff carries no document-routing fields.
- `create-card` requires that the card does not exist yet.
- `update-card` requires an `Expected card SHA256` that matches the card on disk (guarded script only).

**Document routing:**
- `Recommended memory action` is `no-card`.
- `Target document` is one of the allowed paths: `TOOLS.md`, `USER.md`, `rules/*.md`, `.learnings/*.md`.
- `Suggested document content` is present and contains no `##` headings.

Anything that doesn't meet those checks lands in `memory/handoff-inbox/` as a review draft, or in quarantine if it didn't parse. The inbox is designed to be scannable weekly, not ingested automatically.

**Why this is conservative:** auto-promotion writes real durable memory. A malformed or adversarial handoff becoming a memory card means every future session reads it. The safety bar is "high-confidence or route to review", not "best effort". The hash guard and the before/after hashes exist because the realistic failure is not an attacker. It is two writers editing the same card minutes apart.

## Scheduling

Run the ingester on a short timer so durable knowledge stops aging in the filesystem. I used to do this from cron. Brigade now owns the schedule: `brigade care` installs a systemd user timer that fires every 30 minutes and runs a pinned runbook, so each run leaves a receipt and the script it runs cannot change without the pin failing.

```ini
# ~/.config/systemd/user/brigade-care-<id>-handoff-ingest.timer (generated)
[Timer]
OnCalendar=*:0/30
Persistent=true
```

```bash
# the service it triggers (generated)
brigade runbook run --approved .brigade/memory-care/runbooks/ingest-sweep.json --target .
```

The runbook lists one allowed command, the workspace's ingest wrapper, with its SHA-256 pinned. Editing the wrapper without re-approving the runbook makes the run fail closed, which is what you want from something that writes to canonical memory unattended.

My wrapper script is longer than a fresh setup needs, because it also pulls from remote hosts and refreshes derived mirrors. A new setup can point the runbook at a two-line wrapper around `brigade ingest`, which already prints a `NO_UPDATES` line when nothing happened. That line lets a dashboard tell "ingester didn't run" from "ingester ran and found nothing":

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$HOME/.openclaw/workspace}"
brigade ingest --target . --promote-cards --route-documents
```

A dry run prints the summary shape:

```text
[dry-run] Processed 0  Promoted 0  Reinforced 0  Routed 0  Inboxed 0  Skipped 0
[dry-run] NO_UPDATES
```

## Cross-Machine Sync

If Claude Code, Codex, or another side harness runs on more than one machine, only one host should be the ingest point. On every other machine, each writer inbox gets delivered to the canonical host before the ingester fires.

Options that work:

1. **A writers manifest with a transport.** This is what I run now. The manifest lists each host, its inboxes, and directories to discover. The canonical host reads remote inboxes at ingest time, hashes each file, stores the exact bytes it hashed, and only then lets the remote side archive its copy. A rejected file (symlink, oversize, not a regular file) stays quarantined for review. The run only fails if the transport itself breaks.

2. **rclone bisync on a timer.** Simple, handles conflicts, works well if both machines are on the same LAN. Bisync every 5 minutes, ingest every 30. The window is small enough that handoffs land in OpenClaw within the same session on most workflows.

3. **Per-repo push on close.** Claude Code writes the handoff, then your shell hook or a small git-aware wrapper pushes the file to a shared branch. Ingester pulls that branch before running.

What matters is that workstation, laptop, and VPS handoffs are **not ingested locally.** Only the canonical host writes canonical memory. The remote machines produce, and the canonical host routes.

## Bootstrapping a Machine for Handoffs

On any new Claude Code or Codex install you want in the system:

1. Drop the closeout instruction into `~/.claude/CLAUDE.md`, `AGENTS.md`, or another instruction file that your local coding harness reliably loads.
2. Make sure the instruction explicitly routes durable knowledge to the configured handoff inbox in the active repo.
3. Create the relevant inbox in each repo you work in, such as `.claude/memory-handoffs/` for Claude Code or `.codex/memory-handoffs/` for Codex.
4. If not the canonical host, wire the sync path.
5. Test end-to-end: do a small task, then list the configured inbox to confirm the harness emitted a handoff.

The test loop matters. If the closeout rule is not firing, you will not notice for weeks, just slowly accumulating durable knowledge that never reached OpenClaw.

## Verification

Check that the pipeline is alive end-to-end:

```bash
# The ingest timer is installed and active
systemctl --user list-timers --all | grep handoff-ingest
# Expected: a row with a next run within 30 minutes

# Inbox coverage, pending vs processed counts, ingester freshness, lint state
brigade handoff doctor --target ~/.openclaw/workspace
# Expected: "[ok] handoff_watch: .claude/memory-handoffs ... pending=0, processed=<n>"
#           and "[ok] handoff_ingestor: .../latest.log (age=<minutes>)"

# Last ingest receipt
jq '{outcome, status, mode}' ~/.openclaw/workspace/.brigade/handoff-ingest/latest.json
# Expected: outcome "ok"; status "empty" when nothing was pending, "ingested" after a delivery

# Handoffs waiting in any inbox on this machine
find ~/repos \( -path "*/.claude/memory-handoffs/*.md" \
    -o -path "*/.codex/memory-handoffs/*.md" \) \
    -not -path "*/processed/*" -not -path "*/malformed/*" -mtime -7

# Validate a handoff before the ingester sees it
brigade handoff lint --target . .claude/memory-handoffs/<file>.md

# Cards that landed via promotion in the last week
find ~/.openclaw/workspace/memory/cards -maxdepth 1 -mtime -7 -name "*.md" | wc -l

# Review inbox depth (shouldn't accumulate forever)
ls ~/.openclaw/workspace/memory/handoff-inbox/ | wc -l
```

An inbox that grows unboundedly means the auto-promotion rules are too strict for your handoff quality. A `malformed/` directory that keeps growing means a writer is emitting handoffs that don't parse, so fix the writer's template. An empty inbox plus zero card promotions in a week means the closeout rule is not firing. Go check the instruction file loaded by Claude Code or Codex on every machine.

## Gotchas

1. **Only known section names split a handoff, but write `###` anyway.** My guarded script's parser treats just the standard section names as boundaries, so a stray `## Tier 1` inside `Suggested card content` stays inline. The handoff template still tells writers to keep `##` out of document content, so follow it. Use `###` or deeper everywhere and you never have to remember which rule applies.

2. **`update-card` without `Expected card SHA256` is rejected by the guarded script.** That's deliberate. A writer that cannot say which version of the card it edited should send `create-card` for a new card or a document-routing handoff for an append. When an update is rejected on a hash conflict, re-read the current card, merge by hand, and send a fresh handoff with the new hash.

3. **Bisync conflicts on the handoff directory are usually safe to resolve either way.** Handoff files are write-once and named with timestamps, so duplicate-looking files are actually distinct handoffs. Don't auto-resolve by deleting "duplicates". They're not. (The ingester dedupes by content hash on its own.)

4. **Auto-promotion writes to the filesystem on the canonical host immediately.** If that host also runs OpenClaw, a card landing mid-session invalidates the prefix cache for the remaining turns (see [Prompt Caching](../ai-stack/prompt-caching.md)). Ingest during quiet hours if you care about cache continuity.

5. **The `processed/` folder grows forever if you don't prune.** Mine holds roughly a thousand processed Claude handoffs. A job that deletes processed handoffs older than 30 days is fine, since by then the durable content is either in a card or you decided it didn't belong there. Keep `malformed/` until you've looked at it.

6. **Don't ingest your own OpenClaw session memory as handoffs.** It's tempting to wire the OpenClaw agent to emit handoffs about its own sessions, but this creates a loop where OpenClaw ingests its own output. If you want OpenClaw to promote session knowledge to cards, do it through OpenClaw's native memory writes (the sweep in [memory-token-optimization](memory-token-optimization.md)), not through the handoff path.

7. **A handoff file that git tracks is never ingested.** Templates and fixtures that live in a repo's handoff directory are skipped on purpose. If your real handoff is not being picked up, check `git ls-files` for it before you debug the ingester.

## Related

- [`memory-architecture.md`](memory-architecture.md) - why one host owns canonical memory
- [`memory-token-optimization.md`](memory-token-optimization.md) - the sweep, ingest, and decay jobs side by side
- [`../tools/brigade.md`](../tools/brigade.md) - `brigade ingest`, `brigade handoff`, and the managed timers
- [`../security/secret-management.md`](../security/secret-management.md) - keep credentials out of handoff text
