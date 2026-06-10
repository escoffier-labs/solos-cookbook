# The MiseLedger Evidence Pipeline: Searchable Work History From Scattered Session Logs

> Your agent did the work. The proof is smeared across `~/.codex/sessions`, `~/.claude/projects`, `~/.openclaw/agents`, a pile of notes, and a git log. None of it is searchable, none of it is citable, and six weeks later "did we already decide this?" has no answer you can pull up in one command. This is the trio that fixes it: StationTrail and SourceHarvest export local history into one adapter contract, MiseLedger imports it into a local SQLite evidence archive with FTS search and Brigade-ready evidence bundles. Local-only, no network calls, imported text stays data and never becomes instructions. 🦞

**Tested on:** miseledger 0.1.5, stationtrail 0.1.4, sourceharvest 0.1.1 (Go 1.22+), Linux. End-to-end run on 2026-06-10: three codex session fixtures exported to 27 `miseledger.adapter.v1` records, imported into a fresh SQLite FTS archive, searched, evidence-bundled across CLI + loopback HTTP + stdio MCP, then a markdown note imported through SourceHarvest into the same archive to prove cross-source search.
**Last updated:** 2026-06-10

---

## What this covers

This guide is the recipe for turning the raw agent-session logs that [`session-jsonl.md`](session-jsonl.md) teaches you to grep into a durable, searchable, citable evidence archive. `session-jsonl.md` is the "search the transcripts" answer when you have one machine and a shell. This guide is the answer when you want that search to be indexed, deduplicated, cross-source, and consumable by an agent through a stable resource URI.

It covers:

- the problem: work history scattered across harness session logs with no searchable evidence trail
- the three tools and the single adapter contract they share
- install via `go install`
- a real export -> import -> search -> evidence-bundle walkthrough with actual commands and the output they produced
- how Brigade discovers the trio as a managed evidence station with advisory `brigade doctor` checks
- the privacy and evidence boundary: local-only, untrusted-context flags, imported text as data not instructions
- verification steps and the gotchas that bite

It does not re-document every CLI subcommand. The repos' own READMEs and `docs/QUICKSTART.md` are the reference; this is the operational walkthrough of why the pipeline is shaped the way it is and what it actually does when you run it.

## Why this way

The naive approach to "what has my agent been doing" is `grep -r` across session directories. It works on one machine for one question. It falls apart the moment you want any of:

| You want | grep gives you | The archive gives you |
|----------|----------------|-----------------------|
| Ranked relevance | every literal match, unordered | FTS5-scored hits, best first |
| Cross-source search | one directory at a time | codex, claude, openclaw, notes, git, all in one query |
| Dedup | the same line in three session copies, three times | one item per content hash |
| A citable result | a file path and line you have to re-find | a stable `miseledger://evidence/<id>` URI an agent can fetch |
| Provenance | nothing | source kind, collection, actor, raw ref with path + hash + ordinal |
| An evidence handoff | copy-paste a transcript chunk and hope | a structured bundle marked `untrusted_context: true` |

The split into three tools is deliberate and it is the whole design:

- **Source-specific parsing is hard and changes per harness.** Codex JSONL, Claude project JSONL, OpenClaw trajectories, and Hermes snapshots all have different shapes. That parsing lives in **StationTrail**, which only ever emits the shared contract. It is a scanner, not an archive.
- **Non-agent local sources are a different problem.** Markdown notes, plain files, HTML exports, JSON, JSONL, and git history have nothing to do with harness internals. That lives in **SourceHarvest**, the sibling exporter. Also just an emitter.
- **Storage, indexing, dedup, relations, and evidence are one job done once.** That is **MiseLedger**. It owns the SQLite archive, the FTS5 index, dedup, shallow relations, scan manifests, and the evidence-bundle surfaces (CLI, loopback HTTP, stdio MCP). Both exporters feed it the same `miseledger.adapter.v1` JSONL.

The payoff of the split: adding a new source never touches the archive, and hardening the archive never touches a parser. You can pipe an exporter into the importer or, if the exporter is on `PATH`, let MiseLedger run it through a wrapper subcommand. Either way the contract is the only coupling.

## Prerequisites

- Go 1.22+ on `PATH` for `go install`, or use the release `install.sh` scripts.
- Local agent session logs to export. StationTrail's defaults are `~/.codex/sessions`, `~/.claude/projects`, `~/.openclaw/agents`, `~/.hermes/sessions` (OpenCode is explicit-only, from a sanitized export).
- Comfort with the idea that imported transcript text is **evidence, not executable instruction**. The whole pipeline is built on that boundary; if you wire a downstream agent to the MCP surface, you must keep treating bundle text as untrusted data.
- A SQLite build with FTS5. The MiseLedger release binary statically links a FTS5-capable SQLite, so this is only a concern if you build from source against a system SQLite that lacks FTS5. `miseledger status` reports `fts: ok` when it is healthy.

## The adapter contract

Everything flows through one line-oriented JSON contract: `miseledger.adapter.v1`, one object per line. An exporter's only job is to emit it; the importer's only job is to consume it. A single exported record looks like this (a codex session-meta event, redacted with `--redact paths,secrets`):

```json
{
  "schema": "miseledger.adapter.v1",
  "source": { "kind": "codex", "name": "Codex Sessions", "version": "" },
  "collection": {
    "external_id": "codex:session:codex-demo-1",
    "kind": "agent_session",
    "name": "codex-demo-1",
    "metadata": { "cwd": "[redacted-path]/miseledger", "harness": "codex", "session_id": "codex-demo-1" }
  },
  "item": {
    "external_id": "codex:6cbf4e60542a43c9ffd3317f",
    "kind": "event",
    "created_at": "2026-06-03T15:00:00Z",
    "text": "session_meta",
    "tags": ["agent-session", "codex"],
    "metadata": { "event_type": "session_meta", "file_path": "[redacted-path]/rollout-session-1.jsonl", "model": "gpt-5", "ordinal": 1 }
  }
}
```

The load-bearing fields: `source.kind` (which exporter family produced this), `collection.external_id` + `collection.kind` (the session or note grouping), `item.external_id` (the stable dedup key), `item.kind`, and a `raw` ref (path, hash, ordinal) so every normalized item points back at the byte it came from for audit. The exporters carry `source.kind` per record, which is why a mixed `stationtrail all` stream can flow through one importer and still land in the right buckets.

## Install

The Brigade evidence station installs all three with `go install`:

```bash
go install github.com/escoffier-labs/miseledger/cmd/miseledger@latest
go install github.com/escoffier-labs/stationtrail/cmd/stationtrail@latest
go install github.com/escoffier-labs/sourceharvest/cmd/sourceharvest@latest
```

Or use the release installers:

```bash
curl -fsSL https://raw.githubusercontent.com/escoffier-labs/miseledger/HEAD/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/escoffier-labs/stationtrail/HEAD/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/escoffier-labs/sourceharvest/HEAD/install.sh | sh
```

MiseLedger uses XDG paths: config at `~/.config/miseledger/config.toml`, the archive at `~/.local/share/miseledger/miseledger.db`, cache at `~/.cache/miseledger/`. Everything is created with private permissions.

## Walkthrough: export, import, search, bundle

This is a real run from 2026-06-10 in an isolated `$HOME` sandbox. The numbers below are the actual output. Use the same shape against your own session roots.

### 1. Initialize the archive

```bash
$ miseledger init
{
  "ok": true,
  "paths": {
    "db_path": ".../miseledger/miseledger.db",
    "cache_dir": ".../miseledger"
  },
  "schema_version": 1
}
```

### 2. Export agent sessions with StationTrail

StationTrail reads the session JSONL, normalizes it, applies the requested redaction, and writes one adapter record per line. Always redact when the archive might later be inspected by anything but you:

```bash
$ stationtrail codex ~/.codex/sessions --out codex.adapter.jsonl --redact paths,secrets
$ wc -l codex.adapter.jsonl
27 codex.adapter.jsonl
```

`--redact safe` is the convenient profile (paths, secrets, emails). `--redact paths,secrets` is the minimum I run for anything that leaves my own eyes. StationTrail's `discover` and `doctor --json` report which source roots are ready without printing a single line of transcript text.

### 3. Import into the SQLite archive

Pipe the export into the importer, or pass the file. The importer parses and validates each record, normalizes sources/collections/items/actors/artifacts/raw-refs, dedups by stable external id, and maintains the FTS index:

```bash
$ cat codex.adapter.jsonl | miseledger import adapter - --source codex --json
{ "inserted_items": 27, "already_known": false }
```

Imports are idempotent. Re-running the exact same export inserts nothing:

```bash
$ cat codex.adapter.jsonl | miseledger import adapter - --source codex --json
{ "inserted_items": 0, "already_known": true }
```

That idempotency is the property that makes a re-run-on-cron import safe. A growing session file re-imported tomorrow adds only the new items.

```bash
$ miseledger status --json
{
  "schema_version": 1,
  "sources": 1,
  "items": 27,
  "artifacts": 3,
  "fts": "ok",
  "source_counts": { "codex": 27 }
}
```

### 4. Search

FTS5-ranked, best first, with bracketed snippets:

```bash
$ miseledger search "adapter contract"
7249d3be... [codex/artifact] Please connect the [adapter contract] to Brigade evidence bundle output.
3cfc5ef2... [codex/event]    The [adapter contract] should produce normalized agent-session evidence for MiseLedger search.
...
```

`--json` adds per-hit FTS scores, source kind, item kind, and snippet. `explain` runs the same FTS path and reports the quoted query, filters, result count, and source/item-kind counts, which is how you debug "why did this rank here."

### 5. Create an evidence bundle

This is the surface that makes the archive an evidence layer and not just a search box. A bundle is a structured, cached, explicitly-untrusted package of results with provenance:

```bash
$ miseledger evidence "adapter contract" --source codex --limit 10 --json
```

Captured fields from the real run:

```
id:                678d4642ed92af1a40123c26
resource_uri:      miseledger://evidence/678d4642ed92af1a40123c26
untrusted_context: true
results:           2          # 6 raw FTS hits, deduped to 2 unique by content hash
```

Each result carries `id`, `external_id`, `source_kind`, `collection`, `actor`, `kind`, `score`, `snippet`, `timestamp`, `raw_ref`, and `artifacts`. The bundle is cached under MiseLedger's private cache, so the same `id` is retrievable later:

```bash
$ miseledger evidence show 678d4642ed92af1a40123c26 --json
shown id: 678d4642...  uri: miseledger://evidence/678d4642...  results: 2
```

The dedup is the quiet win: three identical codex sessions produced six FTS hits, which the bundle collapsed to two unique items by content hash. You cite the result, not the noise.

### 6. The same data through HTTP and MCP

The CLI, a loopback HTTP server, and a stdio MCP server are three doors onto one archive. HTTP binds to loopback only by default:

```bash
$ miseledger serve --addr 127.0.0.1:8765 &
$ curl -s "http://127.0.0.1:8765/search?q=adapter+contract"          # 6 hits
$ curl -s -X POST http://127.0.0.1:8765/evidence \
    -d '{"query":"adapter contract","limit":10}'
# -> { "resource_uri": "miseledger://evidence/...", "untrusted_context": true, ... }
```

The MCP server exposes `search_evidence`, `show_item`, `create_evidence_bundle`, `show_evidence_bundle`, and `list_sources` for an agent to consume directly:

```bash
$ miseledger mcp
$ miseledger doctor --mcp --json
# checks: paths ok, schema ok, fts ok, permissions ok, mcp_initialize ok, mcp_tools ok
```

### 7. Cross-source: one archive, many sources

SourceHarvest proves the contract is genuinely source-agnostic. Export a markdown notes directory into the same archive:

```bash
$ sourceharvest markdown ./notes --source notes --collection notes:local --out - \
    | miseledger import adapter - --json
{ "inserted_items": 1 }

$ miseledger status --json
{ "sources": 2, "items": 28, "source_counts": { "codex": 27, "notes": 1 } }
```

Now one query spans both source kinds:

```bash
$ miseledger search "adapter contract" --json   # total hits: 7  ->  codex: 6, notes: 1
```

That is the entire point of the layering: the note and the agent session are the same kind of evidence the moment they are in the archive, and a single search returns both with their provenance intact.

## How Brigade discovers the trio

[Brigade](https://github.com/escoffier-labs/brigade) treats the three tools as one managed **evidence station** ("local-first evidence ledger and source exporters"). The station's tools are `miseledger`, `stationtrail`, and `sourceharvest`, each installed via the `go install` lines above when you run `brigade add evidence`.

`brigade doctor` runs the station's checks as **advisory**, never as a workspace `FAIL`. This is the right call: the evidence archive is host-global operator state (your real session history), not a per-workspace artifact Brigade owns, so a missing or empty archive should not red-flag an otherwise-healthy workspace. The checks Brigade runs:

| Tool | Brigade check | What it reads |
|------|---------------|---------------|
| `miseledger` | runs `miseledger status --json` | reports `schema`, `items`, `sources`, `fts`; `WARN` if `fts != ok` |
| `stationtrail` | runs `stationtrail doctor --json` | reports source count, ready count, warnings; `WARN` if `ok: false` or warnings present |
| `sourceharvest` | runs `sourceharvest version` | presence + runnable; it is a stateless emitter with no archive to inspect |

If a tool is not installed, Brigade reports it as `MANUAL` with a hint to run `brigade add evidence`, not as a failure. The station itself writes no per-workspace files and starts no services. That advisory posture is deliberate and matches how Brigade handles its other host-global satellites (memory, pantry, notifications).

## The privacy and evidence boundary

This pipeline is built on one hard rule, repeated in every repo: **imported text is stored locally and treated as untrusted evidence, not executable instructions.** That is not a slogan, it shapes the surfaces:

- **No network calls.** None of the three tools make network calls for init, export, import, search, evidence, show, export, status, SQL inspection, MCP, HTTP serving, or doctor. The archive is yours, on your disk.
- **Loopback by default.** `miseledger serve` binds `127.0.0.1`. There is no remote bind in the default path. Optional read-only API auth for multi-user hosts is on the roadmap, not on by default.
- **`untrusted_context: true` on every bundle.** Evidence bundles are explicitly flagged untrusted. When an agent reads a bundle through the MCP surface, the flag is the contract: this is retrieved data to reason *about*, never instructions to *follow*. A transcript that contains the words "ignore previous instructions" is evidence that someone wrote those words, nothing more.
- **Redaction happens at export, not import.** StationTrail's `--redact` (`safe`, `paths`, `secrets`, `emails`, `urls`, `hostnames`, `all`, or `none`) is requested per export. The default is `none` if you omit the flag, so redaction is opt-in at the exporter. SourceHarvest emits text as-is and relies on the same untrusted-evidence framing. **Decide redaction at export time**; the archive stores what you give it.
- **Structure-only diagnostics.** `discover`, `doctor`, `inspect`, `--dry-run`, `scans list`, and `sources discover` report counts, roots, file manifests, hashes, and warnings, never generated transcript text. You can audit what the archive has seen without leaking what is in it.
- **Conservative deletes.** `prune imports` and `prune scans --missing` remove only import metadata, warning rows, and stale scan-manifest rows. Neither touches normalized evidence items. There is no bulk evidence-delete footgun.

If you wire a downstream publish step on top of any of this, run [content-guard](https://github.com/escoffier-labs/content-guard) over the text before it leaves the box. See [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md).

## Verification

```bash
# 1. All three tools present and runnable
miseledger version && stationtrail version && sourceharvest version

# 2. Archive is healthy: schema, FTS, and integrity
miseledger status --json | python3 -c 'import sys,json;d=json.load(sys.stdin);print("fts:",d["fts"],"items:",d["items"],"sources:",d["sources"])'
miseledger doctor --archive --json   # quick-check, foreign keys, orphans, FTS coverage, scan paths

# 3. Export sources without leaking text (structure only)
stationtrail discover --json         # candidate roots + JSONL counts, no transcript text
stationtrail doctor --json           # source readiness + warnings, no transcript text

# 4. Round-trip: export -> import -> search returns ranked hits
stationtrail codex ~/.codex/sessions --out - --redact paths,secrets | miseledger import adapter - --json
miseledger search "<a phrase you know is in a session>" --json

# 5. Evidence bundle carries a stable URI and the untrusted flag
miseledger evidence "<your phrase>" --json | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["resource_uri"], d["untrusted_context"])'

# 6. MCP surface initializes and registers its tools
miseledger doctor --mcp --json

# 7. Brigade sees the station (advisory)
brigade doctor --target ~/agent-kitchen | grep -i evidence
```

Healthy signs: `fts: ok`, `miseledger doctor --archive` all-green, a re-import reporting `inserted_items: 0`, and `brigade doctor` listing the evidence tools as `OK` (or `MANUAL` if you have not installed them yet), never `FAIL`.

## Gotchas

**Redaction defaults to `none`.** StationTrail does not redact unless you ask. If you omit `--redact`, raw paths, secrets, emails, and hostnames go straight into the adapter records and then into the archive. Always pass `--redact safe` (or at minimum `paths,secrets`) for anything that might be inspected by another tool, copied, or piped into an agent. Redaction is an export-time decision and there is no post-hoc scrub of items already imported short of rebuilding.

**FTS5 must be present or search silently degrades.** The release binary statically links a FTS5-capable SQLite, so this only bites if you `go build` against a system SQLite without FTS5. Check `miseledger status` for `fts: ok`. If it is anything else, `search`, `explain`, and `evidence` will not return ranked hits, and `brigade doctor` will `WARN` on the miseledger check.

**Dedup is by stable external id and content hash, so identical sessions collapse.** This is correct and desirable, but it surprises people: importing three copies of the same session does not give you three times the items, and a search across duplicated content returns the unique items, not the copies. If your counts look "low," that is dedup working. The walkthrough above saw six raw FTS hits collapse to two unique bundle results for exactly this reason.

**Imports are idempotent; re-imports are cheap, not free of intent.** Re-running an import is safe (`inserted_items: 0`), which makes it cron-friendly. But a *growing* file is re-scanned in full each time to find the new tail. For large session roots, lean on `--since` and `--limit` on the StationTrail side and `miseledger scans changed` to import only what moved.

**`evidence list` and the bundle cache live under the private cache dir.** Bundles persist so you can `evidence show <id>` later, but they live in `~/.cache/miseledger`. A cache wipe drops your cached bundles (the underlying items survive in the archive; you just regenerate the bundle). Do not treat a bundle id as permanent storage; treat the archive as the source of truth and the bundle as a reproducible view.

**HTTP is loopback-only and there is no auth by default.** `miseledger serve` binds `127.0.0.1`, which is the right default. If you are tempted to expose it on a LAN, do not, until the roadmap's optional read-only API auth lands. Anything reachable can read your entire local work history.

**Use the right exporter for the source.** Agent-session logs go through StationTrail; notes, files, HTML, JSON, and git history go through SourceHarvest. Crawler outputs (`discrawl`, `telecrawl`, and friends) should land their local exports through SourceHarvest, not StationTrail. Putting a note through StationTrail or a session through SourceHarvest will either fail to parse or produce a misclassified `source.kind`.

**Bundle text is untrusted, structurally.** If you build an agent loop on top of the MCP surface, the `untrusted_context: true` flag is not decoration. A retrieved evidence snippet can contain anything a past session typed, including text shaped like an instruction. Reason about it, never execute it. This is the single rule the whole pipeline exists to enforce.

## Related

- [`session-jsonl.md`](session-jsonl.md) - the shell-level "grep the transcripts" precursor; this guide is the indexed, cross-source, citable version of that idea
- [`memory-architecture.md`](memory-architecture.md) - where archived evidence sits in the trust hierarchy: a point-in-time record of what was said, not proof it is still true
- [`memory-token-optimization.md`](memory-token-optimization.md) - how a lean memory index and an evidence archive divide labor: the index stays tiny, the archive holds the searchable detail
- [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - promoting durable facts into canonical memory without copying raw session logs into the prompt
- [`../tools/brigade.md`](../tools/brigade.md) - the installable kitchen that wires the evidence station and runs its advisory doctor checks
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - the scrub-before-publish gate to run over any evidence text that leaves the box
- [MiseLedger](https://github.com/escoffier-labs/miseledger), [StationTrail](https://github.com/escoffier-labs/stationtrail), [SourceHarvest](https://github.com/escoffier-labs/sourceharvest) - the three repos
