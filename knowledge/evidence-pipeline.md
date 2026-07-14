# The MiseLedger Evidence Pipeline: Searchable Work History From Session Logs

> Agent sessions are useful until you need to find a decision from six weeks ago. MiseLedger imports local harness logs into one SQLite archive, indexes them with FTS5, and returns citable evidence bundles without sending the archive over the network.

**Tested on:** MiseLedger 0.5.0, Linux, 2026-07-13. A clean-room smoke imported the shipped Codex, Claude, OpenClaw, Hermes, and OpenCode fixtures into a fresh archive: 5 sources, 24 items, FTS healthy, session search working, and a stable `miseledger://evidence/<id>` bundle returned.
**Last updated:** 2026-07-13

---

## What this is

This is the operational path from local agent-session files to searchable evidence. MiseLedger owns the native session parsers, the SQLite archive, deduplication, FTS5 search, and the evidence output.

Use this when plain `rg` is no longer enough because you need to search across several harnesses or hand a result to another tool with its source attached.

This guide covers:

- discovery and import for Codex, Claude Code, OpenClaw, Hermes, and OpenCode
- session-level search and item-level search
- stable evidence bundles for later retrieval
- archive and MCP health checks
- the privacy boundary around transcript data

It covers native session import only. Non-session crawlers have separate dependencies and should be added only after `miseledger doctor --json` reports what your installation can run.

## Why this way

Raw transcript search answers a one-off question. An archive handles repeated queries and keeps enough provenance to audit the result.

| Need | Raw files | MiseLedger archive |
|------|-----------|--------------------|
| Search several harnesses | one directory and format at a time | one query across imported sources |
| Find the original session | infer it from file paths | session result includes source, collection, raw path, and ordinal |
| Avoid duplicate imports | manage it yourself | content hashes and idempotent imports |
| Hand evidence to another tool | copy transcript text | bundle with a stable resource URI and source context |
| Check archive health | inspect files and SQLite manually | `doctor`, `status`, and archive checks |

Imported text remains evidence, not instructions. That distinction matters when an agent reads a bundle through the MCP server. A transcript can contain prompt injection, stale commands, secrets, or incorrect conclusions.

## Prerequisites

- Linux or macOS
- MiseLedger 0.5.0 or newer
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

OpenCode import expects sanitized export JSON. Hermes snapshots and trajectory JSONL are supported. `state.db` is not parsed directly.

## Before / After

**Before:** You know the answer exists somewhere in several session directories. Search results are loose lines with no stable identifier, and another agent cannot retrieve the same result later.

**After:** One local database holds normalized session records. You can find a session, inspect ranked item matches, and create an evidence bundle with a stable `miseledger://` URI.

## Implementation

### 1. Install a pinned release

Review the installer before running it:

```bash
MISELEDGER_VERSION=v0.5.0
curl -fsSLO https://raw.githubusercontent.com/escoffier-labs/miseledger/v0.5.0/install.sh
cat install.sh
MISELEDGER_VERSION="$MISELEDGER_VERSION" sh install.sh
miseledger version
```

Expected version output:

```text
miseledger 0.5.0
```

MiseLedger follows XDG paths when they are set. Its defaults are:

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

MiseLedger can expose read-only search and evidence tools over stdio MCP. Check the archive and MCP handshake before adding it to a harness:

```bash
miseledger doctor --archive --json
miseledger doctor --mcp --json
```

The MCP doctor should report `ok: true` and five tools on MiseLedger 0.5.0. Start the server with:

```bash
miseledger mcp
```

Brigade can report whether the binary and archive are available:

```bash
brigade evidence status
brigade evidence doctor
```

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
- both doctor commands return `"ok": true`.

For a clean-room check, set temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` paths before `miseledger init`, then import sanitized fixtures. The 0.5.0 verification for this guide produced 5 sources and 24 items from its five harness fixtures.

## Gotchas

**The archive contains transcript data.** Keep the database, cache, exports, and backups private. Search snippets can reproduce secrets or private paths already present in a session log.

**Imported evidence is untrusted.** A matching transcript may contain instructions aimed at an older agent. Treat it as quoted source material, never as authority to run a command.

**Discovery deserves review.** Run `crawl sessions --dry-run` before the first write. Old exports and copied session trees can expand the archive or import material you did not intend to retain.

**OpenCode needs export JSON.** Pointing the importer at internal binary storage does not make those message bodies readable. Produce a sanitized export first.

**Hermes does not read `state.db`.** Use session snapshots or trajectory JSONL under the session root.

**Non-session crawlers have their own readiness state.** This recipe does not claim every `crawl` mode is self-contained. Check `miseledger doctor --json` before documenting or automating a local-files, repository, or service crawler.

**A stable URI does not freeze the source forever.** Keep the archive and its raw references together. Moving or deleting the original session tree can make later source inspection harder even when the normalized item remains searchable.

## Templates

This recipe does not need a drop-in template. Use XDG environment variables in a temporary shell when you need an isolated smoke archive.

## Related

- [MiseLedger](https://github.com/escoffier-labs/miseledger) - source, release installer, and current command reference
- [`session-jsonl.md`](session-jsonl.md) - direct transcript inspection before you need an archive
- [`../tools/brigade.md`](../tools/brigade.md) - managed evidence and verification workflows
- [`../security/secret-management.md`](../security/secret-management.md) - keep source logs, databases, and exports out of public artifacts
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - scan material before it crosses a public boundary
