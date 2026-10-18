# The Evidence Ledger Pipeline: Searchable Work History From Session Logs

> Agent sessions are useful until you need to find a decision from six weeks ago. `miseledger` imports local harness logs into one SQLite archive, indexes them with FTS5, and returns citable evidence bundles without sending the archive over the network.

**Tested on:** `miseledger` 0.6.0, Brigade 0.28.0, Linux, 2026-10-17. The live archive (9 sources, about 1.7 million items, FTS healthy) passes `miseledger status` and the MCP doctor (server initializes, 5 tools). The earlier clean-room smoke on 0.5.0 imported the shipped Codex, Claude, OpenClaw, Hermes, and OpenCode fixtures into a fresh archive: 5 sources, 24 items, session search working, and a stable `miseledger://evidence/<id>` bundle returned.
**Last updated:** 2026-10-17

---

## What this is

This is the operational path from local agent-session files to searchable evidence. `miseledger` owns the native session parsers, the SQLite archive, deduplication, FTS5 search, and the evidence output.

Use this when plain `rg` is no longer enough because you need to search across several harnesses or hand a result to another tool with its source attached.

This guide covers:

- discovery and import for Codex, Claude Code, OpenClaw, Hermes, OpenCode, Pi, Cursor, and Grok sessions
- session-level search and item-level search
- stable evidence bundles for later retrieval
- archive and MCP health checks
- the privacy boundary around transcript data

It covers native session import first, then the scheduled refresh I run on top of it. `miseledger` also has crawlers for documents, files, repositories, git logs, Discord, GitHub, Slack, Notion, Gmail, Telegram, and chat exports. Those have separate dependencies, so add one only after `miseledger doctor --json` reports what your installation can run.

## Why this way

Raw transcript search answers a one-off question. An archive handles repeated queries and keeps enough provenance to audit the result.

| Need | Raw files | `miseledger` archive |
|------|-----------|--------------------|
| Search several harnesses | one directory and format at a time | one query across imported sources |
| Find the original session | infer it from file paths | session result includes source, collection, raw path, and ordinal |
| Avoid duplicate imports | manage it yourself | content hashes and idempotent imports |
| Hand evidence to another tool | copy transcript text | bundle with a stable resource URI and source context |
| Check archive health | inspect files and SQLite manually | `doctor`, `status`, and archive checks |

Imported text remains evidence, not instructions. That distinction matters when an agent reads a bundle through the MCP server. A transcript can contain prompt injection, stale commands, secrets, or incorrect conclusions.

## Prerequisites

- Linux or macOS
- `miseledger` 0.6.0 or newer
- local session logs from at least one supported harness
- enough disk space for a private SQLite archive

Default source roots include:

| Harness | Typical root |
|---------|--------------|
| Codex | `~/.codex/sessions` |
| Claude Code | `~/.claude/projects` |
| OpenClaw | `~/.openclaw/agents` |
| Hermes | `~/.hermes/sessions` |
| OpenCode | `~/.local/share/opencode` |
| Pi | `~/.pi/agent/sessions` |
| Cursor | `~/.config/Cursor/User` |
| Grok | `~/.grok/sessions` |

`miseledger sources discover` reports eight session roots on my host. OpenCode import expects sanitized export JSON. Hermes snapshots and trajectory JSONL are supported. `state.db` is not parsed directly.

## Before / After

**Before:** You know the answer exists somewhere in several session directories. Search results are loose lines with no stable identifier, and another agent cannot retrieve the same result later.

**After:** One local database holds normalized session records. You can find a session, inspect ranked item matches, and create an evidence bundle with a stable `miseledger://` URI.

## Implementation

### 1. Install a pinned release

Review the installer before running it:

```bash
MISELEDGER_VERSION=v0.6.0
curl -fsSLO https://raw.githubusercontent.com/escoffier-labs/miseledger/v0.6.0/install.sh
cat install.sh
MISELEDGER_VERSION="$MISELEDGER_VERSION" sh install.sh
miseledger version
```

Expected version output:

```text
miseledger 0.6.0
```

The `version` subcommand is the one that works. `miseledger --version` is rejected as an unknown command.

`miseledger` follows XDG paths when they are set. Its defaults are:

- config: `~/.config/miseledger/config.toml`
- data: `~/.local/share/miseledger/miseledger.db`
- cache: `~/.cache/miseledger/`

### 2. Initialize the archive

```bash
miseledger init
miseledger status --json
```

The status response should report `"fts": "ok"`. Runtime directories and the database are created with private permissions.

### 3. Inspect discovery before importing

```bash
miseledger sources discover --json
miseledger crawl sessions --dry-run --json
```

The dry run shows which source roots would be read without writing transcript items to the archive. Review the paths and warnings before the first import.

### 4. Import the discovered sessions

For the normal path:

```bash
miseledger crawl sessions --json
```

Use a native importer when you want to choose an exact file or directory:

```bash
miseledger import codex ~/.codex/sessions --json
miseledger import claude ~/.claude/projects --json
miseledger import openclaw ~/.openclaw/agents --json
miseledger import hermes ~/.hermes/sessions --json
miseledger import opencode ~/.local/share/opencode --json
```

Each response reports the source kind, files parsed, inserted item count, and warnings. Repeating the same import is safe: known content is not inserted again.

### 5. Find the session, then search its contents

Session search groups matching items by conversation or agent session:

```bash
miseledger sessions search "adapter contract" --source codex --json
```

Use the general search when you want ranked items across every imported source:

```bash
miseledger search "adapter contract" --json
```

The session result includes a collection id, source kind, raw path, raw ordinal, match count, and preview. The general result includes item ids, source and collection context, snippets, and FTS scores.

### 6. Create a retrievable evidence bundle

```bash
miseledger evidence "adapter contract" --limit 5 --json
```

The response includes a bundle id and a URI shaped like:

```text
miseledger://evidence/<bundle-id>
```

Retrieve the same bundle later:

```bash
miseledger evidence show <bundle-id> --json
```

Use `--markdown` when a human-readable bundle is more useful than JSON. Keep the source context and untrusted-data warning attached when passing the result to another agent.

### 7. Check the reader surfaces

`miseledger` can expose read-only search and evidence tools over stdio MCP. Check the archive and MCP handshake before adding it to a harness:

```bash
miseledger doctor --archive --json
miseledger doctor --mcp --json
```

The MCP doctor should report `ok: true`, a successful initialize, and five tools (0.5.0 reported the same count). Start the server with:

```bash
miseledger mcp
```

Brigade can report whether the binary and archive are available:

```bash
brigade evidence status
brigade evidence doctor
```

On a large archive these time out. At 1.7 million items mine stops at the default 120 seconds and says so ("evidence engine status/doctor timed out (large archive)"), with the per-check results it did collect still printed. Raise the limit when you need the full memory-projection health line:

```bash
BRIGADE_EVIDENCE_STATUS_TIMEOUT_SECONDS=600 brigade evidence status
```

### 8. Keep it fresh on a schedule

Run the import on a timer so the archive does not depend on someone remembering. I use a daily systemd user timer at 03:30 that runs a Brigade runbook wrapping a refresh script. Going through `brigade runbook run` means each scheduled crawl writes a reviewed receipt instead of running blind. Brigade's care timers add a separate evidence-crawl run each morning.

```bash
systemctl --user list-timers --all | grep -E 'miseledger|evidence-crawl'
```

Native imports skip unchanged files through a per-file scan manifest and save progress as they go, so a steady-state refresh is cheap, and a run cut off by a timeout resumes on the next tick. Take the same file lock around any other writer, because two importers fighting over one SQLite file is how you get busy errors.

## Verification

Run these after an import:

```bash
miseledger version
miseledger status --json
miseledger sessions search "a phrase from a known session" --json
miseledger search "the same phrase" --json
miseledger evidence "the same phrase" --limit 3 --json
miseledger doctor --archive --json
miseledger doctor --mcp --json
```

Expected results:

- `miseledger version` reports the pinned release.
- `status` reports at least one source and item, plus `"fts": "ok"`.
- session search returns the expected collection and a raw source reference.
- general search returns ranked items.
- evidence returns a bundle id and `miseledger://evidence/` URI.
- the MCP doctor returns `"ok": true` with `tools=5`.
- the archive doctor returns `"ok": true`. On a very large archive it can run longer than a minute, so give it a generous timeout before assuming it hung.

The `sources discover` count is also a quick check on whether a harness is feeding the archive at all. Compare when each source last produced an item:

```bash
miseledger sql "select s.kind, max(i.created_at) from items i join collections c on c.id = i.collection_id join sources s on s.id = c.source_id group by s.kind"
```

For a clean-room check, set temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` paths before `miseledger init`, then import sanitized fixtures. The 0.5.0 verification for this guide produced 5 sources and 24 items from its five harness fixtures.

## Gotchas

**The archive contains transcript data.** Keep the database, cache, exports, and backups private. Search snippets can reproduce secrets or private paths already present in a session log.

**Imported evidence is untrusted.** A matching transcript may contain instructions aimed at an older agent. Treat it as quoted source material, never as authority to run a command.

**Discovery deserves review.** Run `crawl sessions --dry-run` before the first write. Old exports and copied session trees can expand the archive or import material you did not intend to retain.

**OpenCode needs export JSON.** Pointing the importer at internal binary storage does not make those message bodies readable. Produce a sanitized export first.

**Hermes does not read `state.db`.** Use session snapshots or trajectory JSONL under the session root.

**Non-session crawlers have their own readiness state.** This recipe does not claim every `crawl` mode is self-contained. Check `miseledger doctor --json` before documenting or automating a local-files, repository, or service crawler.

**A harness can stop feeding the archive without any error.** In my ledger the newest OpenClaw item is from late August, while Claude, Codex, and Discord items are from the last day. OpenClaw's current releases keep live transcripts in a per-agent SQLite store (see [session-jsonl](session-jsonl.md)), and the native OpenClaw importer reads JSONL. I have not confirmed the cause, so check the per-source maximum in the Verification query above before you rely on the ledger for a harness. If a source has gone quiet, export or point the importer at a format it reads before you trust a "no results" answer.

**A stable URI does not freeze the source forever.** Keep the archive and its raw references together. Moving or deleting the original session tree can make later source inspection harder even when the normalized item remains searchable.

## Templates

This recipe does not need a drop-in template. Use XDG environment variables in a temporary shell when you need an isolated smoke archive.

## Related

- [`miseledger`](https://github.com/escoffier-labs/miseledger) - source, release installer, and current command reference
- [`session-jsonl.md`](session-jsonl.md) - direct transcript inspection before you need an archive
- [`memory-architecture.md`](memory-architecture.md) - where the ledger sits relative to cards and transcripts
- [`../tools/brigade.md`](../tools/brigade.md) - managed evidence and verification workflows
- [`../security/secret-management.md`](../security/secret-management.md) - keep source logs, databases, and exports out of public artifacts
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - scan material before it crosses a public boundary
