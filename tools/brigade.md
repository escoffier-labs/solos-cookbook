# Brigade

> Install and operate the cookbook's agent workspace shape instead of copying it by hand: bootstrap files, per-writer memory handoffs, content guards, local work loops, agent dispatch, and security scans.

## What this is

[`brigade`](https://github.com/escoffier-labs/brigade) is the installable and operational version of the agent-kitchen pattern described in this cookbook. It creates a public-safe workspace skeleton for OpenClaw, Claude Code, Codex, Hermes, or a generic harness, then gives you commands to verify, ingest, scan, dogfood, and dispatch agent work from that workspace.

The cookbook explains why the files and workflows exist. Brigade puts them on disk, keeps local state under `.brigade/`, and gives you repeatable checks before you trust the setup.

## Why this way

Manual copying works once. It fails when the template changes, when Codex and Claude Code need different handoff inboxes, or when every repo needs the same publish gate. Brigade makes those decisions explicit:

| Need | Brigade behavior |
|------|------------------|
| Workspace bootstrap | Writes `AGENTS.md`, `MEMORY.md`, safety files, handoff templates, and starter cards |
| Handoff routing | Creates writer-specific inboxes such as `.claude/memory-handoffs/` and `.codex/memory-handoffs/` |
| Handoff administration | Checks multi-repo inbox source coverage with `brigade handoff doctor`, groups warnings, and imports repair work |
| Agent dispatch | Runs an orchestrator plus bounded worker roster through `brigade run`, with local artifacts and optional handoff |
| Daily dogfooding | Runs trusted repo review through `brigade dogfood` and `brigade work` with local artifacts |
| Scanner imports | Converts memory-care, chat-sweep, handoff, and security findings into reviewable `brigade work import` items |
| Publish safety | Installs content-guard policies and a pre-push hook shape |
| Security hygiene | Scans secrets, permissions, hooks, MCP config, supply-chain patterns, and instruction risks |
| Managed stations | Installs and health-checks optional companion tools such as `memory-doctor`, `bootstrap-doctor`, `content-guard`, and `tokenjuice` |

The alternative is a pile of local scripts that only work on one host. Brigade is still small enough to inspect, but structured enough to install repeatedly.

## Prerequisites

- Python 3.10+
- `pipx`
- At least one harness CLI you actually use, such as `codex` or `claude`
- Optional: `content-guard` for publish gates
- Optional: OpenClaw workspace if OpenClaw is your memory owner

## Before / After

**Before:** a repo has scattered rules, no standard handoff path, and no consistent way to tell whether local run artifacts or security reports are safely ignored.

**After:** the repo has a managed `.brigade/` config, configured harness inboxes, dogfood artifacts under `.brigade/runs/`, work-session state under `.brigade/work/`, and doctor commands that catch missing wiring.

## Implementation

Install the CLI:

```bash
pipx install brigade-cli
```

Initialize a full workspace:

```bash
brigade init --target ~/agent-kitchen --depth workspace --harnesses claude,codex,openclaw
brigade doctor --target ~/agent-kitchen
brigade status --target ~/agent-kitchen
```

Initialize managed companion tools only when you want Brigade to wire them for you:

```bash
brigade add memory   # memory-doctor + bootstrap-doctor
brigade add guard    # content-guard
brigade add tokens   # tokenjuice
```

Set up a multi-agent roster when you want Brigade to dispatch work through installed CLIs:

```bash
brigade roster init
brigade roster doctor
brigade run "review this repo and suggest the next implementation step" --read-only --show-plan
```

Initialize a single repo for local dogfooding:

```bash
cd ~/repos/my-project
brigade dogfood init --target .
brigade work bootstrap
brigade work doctor
```

Run the daily loop:

```bash
brigade work brief
brigade work run
brigade work run --queue-next
```

Inspect run artifacts and handoff coverage:

```bash
brigade runs latest --cwd .
brigade runs show .brigade/runs/<run-id>
brigade handoff doctor --target .
brigade handoff issues --target .
brigade handoff import-issues --target .
```

Route scanner output into the local work inbox instead of writing durable memory directly:

```bash
brigade work import memory-care --target .
brigade work import chat-sweep --target .
brigade work import triage --target .
brigade work import promote <import-id>
```

Use the security scanner before trusting an agent workspace:

```bash
brigade security init
brigade security fix
brigade security scan --target .
brigade security scan --target . --output-dir .brigade/security/latest
brigade security enrich --target .
brigade security review
brigade security scan --target . --import-findings
```

`--import-findings` routes findings into the local work import inbox instead of mutating durable memory directly. Review and promote them through the normal `brigade work import` flow.

## Verification

```bash
brigade doctor --target ~/agent-kitchen
brigade roster doctor
brigade work doctor
brigade dogfood status
brigade handoff doctor
brigade security scan --target . --policy public-repo
git status --short --ignored .brigade .codex .claude
```

Expected result: doctor checks pass, roster doctor either validates installed CLIs or reports clear missing tools, dogfood status reports configured artifact and handoff paths, handoff doctor shows covered inboxes or actionable warnings, the security scan either passes or writes reviewable findings, and local Brigade state is ignored by git except for intentional template files.

## Gotchas

**Use current Brigade names in new docs.** Brigade can still read pre-Brigade installs and deprecated aliases for migration, but cookbook examples should use `brigade`, `.brigade/`, and the `brigade-cli` package.

**Dogfood defaults are Codex-shaped.** New dogfood configs default handoffs to `.codex/memory-handoffs/` because the built-in dogfood roster is Codex-driven. Pass `--handoff-inbox` if your canonical memory owner ingests `.claude/memory-handoffs/` or another path.

**`brigade run --read-only` is strongest with Codex.** Brigade passes Codex's native read-only sandbox flag. Other adapters receive prompt-level read-only instructions, so use OS-level permissions or a disposable checkout when the repo is not trusted.

**Run artifacts are local state.** `.brigade/runs/`, `.brigade/work/`, `.brigade/security/`, and machine-local config should stay ignored. Commit templates and public policy files, not the evidence bundle from your own workstation.

**Security scan findings are not memory yet.** They become imports for review. Promote only findings that are durable, actionable, and scrubbed of sensitive detail.

**Cookbook templates are a readable subset.** The installable templates in `src/brigade/templates/` remain the source of truth for generated workspaces. When Brigade adds cards, handoff source examples, station wiring, or scanner contracts, sync the public cookbook templates deliberately instead of assuming they are already current.

## Templates

The long-form cookbook templates live under [`../templates/`](../templates/). Brigade's installable templates live in its repo under `src/brigade/templates/` and are the source of truth for generated workspaces.

## Related

- [`../knowledge/bootstrap-files.md`](../knowledge/bootstrap-files.md) - what each bootstrap file owns
- [`../knowledge/claude-code-memory-handoffs.md`](../knowledge/claude-code-memory-handoffs.md) - handoff format and ingestion rules
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - publish-boundary scrubbing
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - security model for agent workspaces
