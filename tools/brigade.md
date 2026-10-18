# Brigade

> Install and operate the cookbook's agent workspace shape instead of copying it by hand: bootstrap files, per-writer memory handoffs, content guards, MCP sync, local work loops, operator checks, research receipts, and security scans.

_Current as of brigade 0.28.0, 2026-10-17. PyPI's newest `brigade-cli` was 0.27.0 on that date (`pip index versions brigade-cli`), and `brigade update --dry-run` resolved 0.27.0, so a plain `pipx install brigade-cli` gets you one release behind what I run. Command names below were checked against `--help` on 0.28.0._

## What this is

[`brigade`](https://github.com/escoffier-labs/brigade) is the installable and operational version of the agent-kitchen pattern described in this cookbook. It creates a public-safe repo or workspace skeleton for Codex CLI, Claude Code, OpenCode, Hermes, OpenClaw, and the other file-backed harnesses listed below, then gives you commands to verify, ingest, scan, dogfood, dispatch, research, and operate agent work from that workspace.

The cookbook explains why the files and workflows exist. Brigade puts them on disk, keeps local state under `.brigade/`, and gives you repeatable checks before you trust the setup. It is the operator-system layer: the tagline "run your agent brigade" is literal, since Brigade plans work across the CLIs you already have, dispatches workers, and synthesizes the result.

## Why this way

Manual copying works once. It fails when the template changes, when Codex and Claude Code need different handoff inboxes, or when every repo needs the same publish gate. Brigade makes those decisions explicit:

| Need | Brigade behavior |
|------|------------------|
| Workspace bootstrap | Writes `AGENTS.md`, `MEMORY.md`, safety files, handoff templates, starter cards, and built-in work-loop skills |
| Handoff routing | Creates writer-specific inboxes such as `.claude/memory-handoffs/` and `.codex/memory-handoffs/` |
| Handoff administration | Checks multi-repo inbox source coverage with `brigade handoff doctor`, groups warnings, and imports repair work |
| Agent dispatch | Runs an orchestrator plus bounded worker roster through `brigade run`, with local artifacts and optional handoff |
| Daily dogfooding | Runs trusted-repo review through `brigade dogfood` and `brigade work` with local artifacts |
| Agent-facing daily loop | `brigade daily` ranks candidate actions and runs exactly one safe, bounded step with approvals |
| Long unattended runs | A phase execution ledger and AFK sessions make multi-phase work auditable and catch silent compression |
| Operator surfaces | `brigade operator`, `brigade center`, `brigade repos`, `brigade context`, `brigade learn`, `brigade friction`, `brigade research`, and `brigade projects` turn local evidence into reviewable reports and action queues |
| Portable tooling | `brigade tools` registers skills, slash commands, scripts, and MCP servers and projects them into each harness's config |
| Canonical MCP catalog | `brigade mcp` keeps one `.brigade/mcp.json` catalog and merges it into each tool's native MCP config, dry-run unless `--write` |
| Verified learning | `brigade outcome` scores learned cards and skills by real verify-run results, so promotion and rollback are evidence-backed, not vibes |
| Reviewed runbooks | `brigade runbook` plans, runs, resumes, and closes out reviewed runbooks with receipts |
| Scanner imports | Converts memory-care, chat-sweep, handoff, and security findings into reviewable `brigade work import` items |
| Publish safety | Provides embedded guard policies, a pre-push hook shape, and a local `brigade release` publish gate |
| Security hygiene | Scans secrets, permissions, hooks, MCP config, supply-chain patterns, and instruction risks |
| Managed stations | Selects a repo profile of core, skills, memory, guard, security, tokens, evidence, and search, with optional pantry, notifications, and MCP sync stations |
| Multi-machine coordination | `brigade fleet` runs an optional hub that tracks runs, repo claims, and a work queue across machines |
| Code graph and evidence | `brigade code` answers "what breaks if I change this" before an edit. `brigade evidence` searches the receipt ledger for what already happened |
| Scheduled care | `brigade care install` writes the scheduler entries for recurring runbooks, opt-in and removable |

The alternative is a pile of local scripts that only work on the first workstation they were written on. Brigade is still small enough to inspect, but structured enough to install repeatedly. The whole system is local-first and read-mostly: by default it does not push, tag, publish, mutate remotes, run restic, or edit canonical memory, and it installs nothing that runs in the background. A few commands do change the machine, and each one is an explicit, named opt-in:

| Command | What it changes |
|---------|-----------------|
| `brigade care install` | Writes scheduler entries (systemd user units on Linux, launchd on macOS, Task Scheduler on Windows). `--dry-run` prints the plan first. `brigade care status` and `brigade care uninstall` inspect and remove only Brigade-managed entries |
| `brigade fleet serve` | Runs the fleet hub as a long-lived HTTP service on the host you choose |
| `brigade center serve` | Serves the local operator dashboard |
| `brigade update` | Replaces the installed Brigade with a release from a stable or beta channel. `--dry-run` reports what it would install |

Everything else stays foreground and reviewable.

## Prerequisites

- Python 3.10+
- `pipx`
- At least one harness CLI you actually use, such as `codex` or `claude`
- Optional: `ollama` for local worker lanes in a roster
- Optional: OpenClaw workspace if OpenClaw is your memory owner

## Before / After

**Before:** a repo has scattered rules, no standard handoff path, and no consistent way to tell whether local run artifacts or security reports are safely ignored.

**After:** the repo has a managed `.brigade/` config, configured harness inboxes, dogfood artifacts under `.brigade/runs/`, work-session state under `.brigade/work/`, and doctor commands that catch missing wiring.

## Implementation

Install the CLI:

```bash
pipx install brigade-cli
```

Use the quickstart when you want a repo or workspace wired end to end:

```bash
brigade operator quickstart --target ./my-repo --harnesses codex
brigade operator doctor --target ./my-repo --profile local-operator
```

For an OpenClaw or Hermes workspace, use workspace depth and name the owner:

```bash
brigade operator quickstart --target ~/agent-workspace \
  --depth workspace \
  --harnesses openclaw,hermes \
  --owner openclaw
```

Use `--dry-run` first to preview the write plan. `brigade operator quickstart` wraps `brigade init`: it installs the template files, writes operator config, scaffolds MCP and dogfood/work-loop state, runs harness checks, and reports readiness. Use `brigade init` directly when you only want the template files or the interactive harness picker.

Install depths are `repo` (minimal project footprint) and `workspace` (full home with `MEMORY.md`, `TOOLS.md`, `USER.md`, rules, and workspace cards). Pass `--full` on repo-depth installs when you want the whole kit: workflow rules, inactive pre-push hook, `INSTALL_FOR_AGENTS.md`, and the default tool packs. Pass `--harnesses none` for a generic install with no harness-specific files.

Initialize managed companion tools only when you want Brigade to wire them for you:

```bash
brigade add skills         # built-in brigade-work and ultra-work-scout skills
brigade add memory          # embedded memory maintenance + optional bootstrap-doctor
brigade add guard           # embedded policy scanner and publish gate
brigade add tokens          # token-glace output compaction
brigade add pantry          # agentpantry session-auth sync
brigade add notifications   # agent-notify operator notifications
brigade add evidence        # miseledger evidence ledger and source/session crawlers
brigade add search          # GraphTrail + code-search-api with its bundled MCP bridge
brigade add mcp             # canonical MCP catalog sync station
```

Use `brigade profiles list` to see built-in bundles and `brigade stations list` to see which stations the repo profile selects before installing sidecars. Fresh repo installs select core, skills, memory, guard, security, tokens, evidence, and search up front. External tools still install only when you run `brigade add <station>` with the station's install step.

Check a sidecar's declared surfaces before installing it:

```bash
brigade stations verify ../graphtrail
brigade stations verify ../graphtrail/station.json --json
brigade stations verify ../graphtrail --check-managed
```

`stations verify` never runs the manifest's install command. On POSIX it runs declared read-only commands, bounded support probes, or manifest-local skill-roster verification from the sidecar directory. It replaces `HOME` and the XDG paths with temporary directories but inherits the rest of the environment, so this is process containment, not an OS sandbox. Each probe has a finite timeout and a 64 KiB combined-output ceiling. Use `--check-managed` when coordinated fleet checks should fail on drift from Brigade's managed catalog.

The main station health commands are also available directly:

```bash
brigade memory status
brigade search doctor
brigade tokens doctor
brigade evidence doctor
brigade pantry doctor
```

The evidence station is a local-first audit trail: `miseledger` imports session and source records into a SQLite FTS archive and emits evidence bundles over CLI, loopback HTTP, and MCP. The Go stations install with `go install github.com/escoffier-labs/<name>/cmd/<name>@latest` when their station manifest asks for it.

### Dispatch a brigade

Set up a multi-agent roster when you want Brigade to dispatch work through installed CLIs. One rostered model plans the work, Brigade runs the assigned workers through their own CLIs, then the orchestrator synthesizes the answer. Brigade makes one initial planning call. If that plan does not parse, it makes one parse-correction call. If the accepted plan still misses route coverage, it may make one coverage-correction call. The orchestrator makes one synthesis call after the worker calls.

```bash
brigade roster init
brigade roster doctor
brigade run "review this repo and suggest the next implementation step" --read-only --show-plan
brigade run "plan the migration" --dry-run     # print planned assignments, stop before dispatch
brigade run "review this repo" --handoff        # write a Memory Handoff for a successful run
brigade run "review this repo" --wait=300       # wait up to five minutes for the target lock
```

A roster is a list of named seats. A seat binds one agent CLI to a model and a role (planner, builder, reviewer, researcher), and Brigade decides what to dispatch from the roster you wrote, not from a built-in default. Keep the real roster private to your machine. The generic shape is all this guide needs. Direct roster adapters include `claude`, `codex`, `opencode`, `antigravity`, `pi`, `cursor`, `aider`, `goose`, `continue`, `copilot`, `qwen`, `kimi`, `adal`, `openhands`, `grok`, `amp`, and `crush`. Local Ollama seats use `ollama:<model>`. A `codex-cloud:<env-id>` seat submits a task to Codex Cloud and returns its summary and diff without applying it. Brigade shells out to authenticated tools and keeps no provider keys.

Brigade derives a deterministic route from the task, changed paths, and an optional template hint. Inspect it before a run or correct one bad heuristic without disabling the router:

```bash
brigade route "rewrite the quickstart" --template docs
brigade route "change the login flow" --route-signal +auth-surface --json
brigade run "prepare the release" --approve-ship --show-plan
```

`--route-signal +name` forces a signal and `--route-signal ~name` suppresses one. Forced signals still pull dependent checks. A requested ship stage stays held until `--approve-ship` is present. Use `--no-route` only when you intend to bypass route composition and plan-coverage checking.

Cursor workers can opt into the reviewed ACP transport with `transport = "acpx"` and `transport_version = "0.12.0"`. ACP seats are worker-only, so keep the orchestrator on a direct adapter.

#### `brigade run` flags worth knowing

| Flag | Use |
|------|-----|
| `--worker <seat>` | Skip planning and synthesis and hand the whole task to one seat. This is the cheap path for a second opinion or a bounded slice |
| `--model <model>` | Override that seat's model for one run, subject to hub policy when a fleet hub is configured |
| `--detach` | Start the run in a detached child process and return once run metadata is written |
| `--worktree` | Run agents in a detached git worktree and write `changes.patch` to the run artifacts instead of editing your checkout |
| `--scheduler dag` | Schedule workers from a ready queue of router dependencies instead of fixed integer-stage waves (`waves` is the default) |
| `--wait[=SECONDS]` | Queue behind an active run lock in arrival order. A bare `--wait` has no ceiling, `--wait=0` fails fast |
| `--no-code-graph`, `--no-evidence` | Drop the code graph or evidence context Brigade otherwise attaches to prompts |
| `--no-fleet-claim` | Skip the hub repo claim and rely on the local run lock (escape hatch for a claim left by a crashed run) |

Examples:

```bash
brigade run "summarize the failing test" --worker <seat> --read-only
brigade run "refactor the parser" --worktree --detach
brigade run "migrate the config loader" --scheduler dag --show-plan
```

For self-contained repository issues you would rather hand to a hosted agent, `brigade run cloud launch` submits a Cursor Cloud or Jules session from a private prompt file (`--provider cursor-cloud|jules`, plus `--repo`, `--label`, and `--prompt-file`). The prompt text is never stored in the registry or passed as an argv value, `--auto-create-pr` is opt-in, and `brigade run cloud status` and `brigade run cloud doctor --provider <name>` check the result without submitting anything. `brigade run-cloud` still works as a deprecated alias.

After enough runs, `brigade model scorecard` aggregates run artifacts into a read-only per-(CLI, model) table, which is the evidence for changing which seat gets which job.

### Plan-first and cross-review loop

Brigade fits the current stack best as the local plan, receipt, and review layer around the harnesses you already use. For work bigger than a one-line fix, start with an explicit task and plan artifact:

```bash
brigade work task add "Review the auth refactor" --type review --acceptance "Find correctness, security, and test gaps"
brigade work task plan <task-id>
brigade work run <task-id>
brigade work verify run --target . --command "pytest -q" --capture brigade-work
brigade work acceptance
```

For second-opinion code review, keep the lanes separate:

1. Codex builds or produces the first review in its normal repo harness.
2. Brigade records the task, plan, run receipt, and acceptance criteria.
3. OpenClaw sends the diff or review prompt to Claude Code through the tmux relay, using `--permission-mode plan`.
4. Codex reviews Claude's findings, applies only validated fixes, and runs tests.
5. Brigade closeout records what was accepted, rejected, verified, and handed off.

Use [`../ai-stack/claude-code-tmux-relay.md`](../ai-stack/claude-code-tmux-relay.md) for the Claude lane. The tmux relay is the recoverable option when you want an attachable session and visible permission prompts. For a simple scripted review, a headless `claude --print` call works too: run it as one flat pass and pass the `Task` and `Agent` tools through `--disallowedTools` so it cannot fan out on its own. Or let a Claude seat do it with `brigade run --worker`.

### Daily dogfooding

Initialize a single repo for local dogfooding, then run the loop:

```bash
cd ~/repos/my-project
brigade dogfood init --target .
brigade work bootstrap
brigade work doctor
brigade work brief
brigade work run
brigade work verify run --target . --command "pytest -q" --capture brigade-work
brigade work closeout
```

The work loop is more than `run`: a task ledger (`brigade work task add` with types, priorities, acceptance criteria, templates, and `--from-issue`), an import inbox, a scanner registry plus `brigade work sweep`, code-review producers (`brigade work review`), explicit verification and closeout (`brigade work verify` / `brigade work closeout` / `brigade work acceptance`), phase records (`brigade work phases`), and backup-health summaries (`brigade work backup`).

Inspect run artifacts and handoff coverage:

```bash
brigade runs latest --cwd .
brigade runs show .brigade/runs/<run-id>
brigade handoff doctor --target .
brigade handoff issues --target .
brigade handoff import-issues --target .
```

### Agent-facing daily driver

`brigade daily` wraps work, operator center, repo fleet, scanners, handoffs, memory, security, tools, context, learning, and release evidence into one bounded daily workflow for an autonomous agent:

```bash
brigade daily status --json     # current operating state + next recommended command
brigade daily plan --json       # rank candidate actions, choose exactly one
brigade daily review --json      # preview the selected action, adapter, risk, blockers
brigade daily run --json         # execute at most one safe local step
brigade daily closeout --json    # mark reviewed/deferred/blocked, optional handoff draft
```

`daily run` refuses approval-required actions unless an explicit approval is passed. When an action needs sign-off it opens a local approval request (`brigade daily approvals ...`) instead of losing plan context. Recovery commands (`resume`, `repair`, `unblock`) handle blocked, failed, or stale runs.

For long unattended work, the phase execution ledger (`brigade work phases`) tracks a declared range as one local record, and AFK sessions add checkpoints, recovery notes, risk and progress rollups, a wrapper-safe resume `protocol`, a self-`audit`, and a final completion `gate`. That evidence flows into release readiness so stale or unreported AFK work blocks publish review visibly.

### Operator surfaces

These groups turn local evidence into reviewable reports and queues without executing the suggested commands:

```bash
brigade center status                 # operator center: status, reviews, reports, readiness
brigade center readiness plan          # one ready-or-blocked view across every subsystem
brigade operator adopt plan            # inventory a homegrown setup before adoption
brigade operator checkup               # run every read-only first-run doctor at once
brigade repos scan                     # repo fleet: safe metadata only, reports, release trains
brigade tools doctor                   # portable tool catalog: skills, commands, scripts, MCP
brigade friction scan                  # mine local notes and handoffs for workflow friction
brigade research run "question"        # create a cited local research report
brigade chat sweep ingest discord-export   # normalize chat exports into memory sweeps
brigade context plan                   # build/sync context packs from safe summaries
brigade memory care scan               # find stale, oversized, orphaned, undersourced cards
brigade learn plan                     # learning candidates with replay
brigade learn import-learnings         # parse .learnings/ ERR/LRN/FEAT logs into reviewable work imports
brigade learn skill-candidates         # recurrence detection over learnings; promotion is proposed, never auto-applied
brigade projects audit                 # project audit/readiness receipts
```

`brigade repos` runs local-only: it never clones, pulls, pushes, tags, or publishes. `brigade tools` projection writes and call execution are always explicit and gated by a local policy and runtime. `brigade chat` rejects raw message bodies by default and keeps only safe summaries.

Route scanner output into the local work inbox instead of writing durable memory directly:

```bash
brigade work import memory-care --target .
brigade work import chat-sweep --target .
brigade work import triage --target .
brigade work import promote <import-id>
```

### Canonical MCP config, receipts, outcomes, and runbooks

`brigade mcp` is the dedicated MCP surface: keep one canonical catalog and project it into each harness's native config instead of hand-editing four config files. Writes are gated, so it fits the same local-first boundary as everything else.

```bash
brigade mcp init                  # scaffold .brigade/mcp.json + the ownership sidecar
brigade mcp add <name> ...        # add or update a server in the canonical catalog
brigade mcp plan                  # show what a sync would change (read-only)
brigade mcp sync                  # dry-run merge into each tool's config
brigade mcp sync --write          # actually write the harness configs
brigade mcp doctor                # validate the catalog and report gaps
```

Verify receipt digests before relying on old run evidence. Signing is optional and uses a local key:

```bash
brigade receipts verify --target .
brigade receipts keygen --target .
brigade receipts export miseledger --target . --new-only --import
```

The export uses the receipt digest as its content identity when present. Legacy receipts fall back to the receipt file's SHA-256, then a canonical JSON digest if the file cannot be hashed. `--new-only` tracks that resulting raw hash, so repeated imports deduplicate instead of copying the same run again.

`brigade outcome` is the verified-learning ledger: it scores learned cards and skills by what actually passed verification, so promotion and rollback rest on evidence rather than a one-time guess.

```bash
brigade work verify run --target . --command "pytest -q" --capture <skill-or-card>
brigade outcome capture <artifact>   # optional separate capture, defaults to latest verify run
brigade outcome score                # verified scores for learned cards and skills
brigade outcome rank                 # rank learned skills, most-proven first
brigade outcome rank --by-capability # rank for the current harness, model family, platform, and Python
brigade outcome explain <artifact>   # show the per-signal trail behind a score
brigade outcome reconcile            # apply verified promote/rollback decisions (dry-run by default)
```

New records carry the artifact's content fingerprint and a coarse runtime-context fingerprint. Editing a skill bundle or a transitively linked card moves earlier fingerprinted records into the stale cohort and excludes them from the current score. Pre-fingerprint records remain included. `--by-capability` uses the current runtime cohort without changing the default promotion ratchet.

`brigade runbook` runs reviewed runbooks with receipts (`plan`, `run`, `resume`, `closeout`), so a multi-step local procedure is auditable the same way `brigade work` and `brigade release` are.

### Fleet coordination

When more than one machine or session runs agents against the same repos, `brigade fleet` adds a small shared hub so they stop colliding. It is optional. Without a hub, every command above keeps working locally.

```bash
brigade fleet serve --host <private-interface>   # run the hub (--host is required, port defaults to 3774)
brigade node --machine                           # show or initialize this machine's node identity
brigade fleet nodes add <node-id>                # enroll a node (admin token); the node token prints once
brigade fleet status                             # latest run state per node
brigade fleet claims                             # active repo claims; a live claim is ownership
brigade fleet flush                              # re-send locally spooled events after a hub outage
```

The pieces:

- **Hub.** One host runs `fleet serve` with an admin bearer token (`--token-file` or `BRIGADE_FLEET_TOKEN`). It binds only the interface you name, never all interfaces by default. Put it on a private network such as a tailnet or loopback behind a proxy, not the open internet.
- **Nodes.** Each machine gets its own token from `fleet nodes add`, using the node id `brigade node --machine` prints on that machine. The hub stores only a hash, and `nodes revoke` followed by `nodes add` rotates it. Writes need a node token, so the admin token is for enrollment, not for everyday publishing.
- **Claims.** `brigade run` takes a repo claim on the hub before it dispatches, so two orchestrators do not edit one checkout. Check `brigade fleet claims` before starting multi-repo work, and treat a live claim as someone else's work. `brigade fleet claims --release <target>` clears a claim left by a crashed run, and only when this node holds it and the run is verifiably dead.
- **Work and burn queue.** `brigade fleet work` manages Worklore items on the hub: `list`, `show`, `create`, `transition`, and `attempt` for the ledger, and `burn` and `next` to read the burn queue. `next` shows the first eligible item with a dry-run route and never reserves it.

If the hub is unreachable, events spool locally and `fleet flush` sends them later. Do not copy a node token between machines or edit spool files by hand.

### Code graph and evidence before you edit

Two read-only commands answer questions an agent otherwise guesses at.

```bash
brigade code sync                      # index or refresh the repo's code graph
brigade code impact <symbol>           # blast radius of changing a symbol
brigade code callers <symbol>          # who calls it
brigade code affected <file> [<file>]  # tests statically attributed to changed files
```

Run `sync` first when the graph may be stale. `impact` and `callers` accept `--depth` and `--json`. `brigade code affected $(git diff --name-only)` gives a starting list of tests for a diff. The graph is static, so a missing edge is not proof of no impact: treat an error or missing coverage as a skipped check. `brigade run` attaches this context to worker prompts unless you pass `--no-code-graph`.

For questions about history, the evidence ledger beats memory:

```bash
brigade evidence search "<query>"   # search receipts and imported sources
brigade evidence show <id>          # read one item and its provenance
```

Cite the evidence id in whatever you write afterward. If a search returns nothing, say there is no Brigade evidence rather than reconstructing the story. The ledger needs the evidence station (`brigade add evidence`). `brigade evidence doctor` reports its health.

### Claude hooks that enforce the work loop

`brigade work hooks` installs managed Claude Code hooks that route a session through the work loop instead of relying on the agent to remember it:

```bash
brigade work hooks install --scope project   # writes into the repo's .claude/settings.json
brigade work hooks install --scope user      # writes into ~/.claude, covering every repo
brigade work hooks status --scope user
brigade work hooks update --scope user
brigade work hooks uninstall --scope user
```

The managed set covers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, and `SessionEnd`. In my sessions that shows up as a work brief injected at the start, raw test runs steered toward `brigade work verify run`, and a handoff reminder before the session ends. With `--scope user`, passing `--target` pins the hooks to one wired workspace. Omit it for multi-repo mode. Because user scope touches your global Claude settings, run `status` first and read what it will add.

### Guard commands for anything going public

The embedded content guard scans text against a policy before it leaves your machine:

```bash
brigade guard scan draft.md --policy <policy.json>        # scan one file or stdin
brigade guard pr-prepare pr-body.md --strict              # build a guarded PR body bundle
brigade guard publish-check --pr-body pr-body.md --all-tracked
brigade guard publish-check --commit-range origin/main..HEAD
```

`scan` is the building block. `pr-prepare` writes a sanitized PR body and a report into a drafts directory inside the target and, with `--strict`, exits nonzero when blocked findings remain. `publish-check` runs the combined pre-publication pass: PR body, tracked files with `--all-tracked`, and commit messages with `--commit-range` or `--all-commits`. `--advisory-only` reports would-fail checks but always exits zero, so use it for a first look and drop it for a gate. `brigade guard pr` is the lighter advisory variant that writes `<target>.public.md` and a JSON report. See [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) for how this fits a publish pipeline.

### Scheduled care

`brigade care install --dry-run --target .` prints the scheduler entries for a small set of recurring runbooks (a daily care pass, a handoff ingest sweep, weekly outcome review, and similar) without writing anything. Without `--dry-run` it writes the units, and `brigade care status` reports whether they are enabled. Read the dry-run plan first, and review the schedules (`--schedule JOB_ID=VALUE` overrides one) before enabling. `brigade care status` shows what is installed and the latest receipt per runbook, and `brigade care uninstall` removes only Brigade-managed entries. Hand-edited managed blocks are reported as a conflict unless you pass `--adopt`.

### Operator dashboard

`brigade center serve --target . --host 127.0.0.1 --port <port> --token <token>` serves the local operator dashboard. Keep it on loopback or a private network and pass a bearer token. `--allowed-host` restricts the Host header. The read-only `brigade center status` and `brigade center report build` give the same material without a server.

### Security scanning

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

### Release readiness

`brigade release` is the local publish gate. It reviews work closeout, verification, code review, scanner state, security health, handoff health, guard results, install smoke receipts, git state, and docs/changelog/roadmap touch warnings, then builds candidate bundles with a manual-only publish plan:

```bash
brigade release doctor                  # local publish checks, including the embedded guard
brigade release run                     # write a release-readiness receipt
brigade release candidate build         # build a local candidate bundle
brigade release candidate audit <id>     # check for stale evidence, missing refs, privacy issues
```

It never pushes, tags, creates releases, comments remotely, or mutates remotes. Run `brigade guard publish-check` (above) on the same range before you do any of those yourself.

## Verification

```bash
brigade operator doctor --target ./my-repo --profile local-operator
brigade doctor --target ./my-repo
brigade roster doctor
brigade work doctor
brigade dogfood status
brigade handoff doctor
brigade receipts verify --target .
brigade security scan --target . --policy public-repo
git status --short --ignored .brigade .codex .claude
```

Then the 0.28 surfaces, all read-only:

```bash
brigade --version                          # brigade 0.28.0 (or whatever you installed)
brigade update --dry-run                   # reports the release it would install, writes nothing
brigade code doctor                        # code graph engine health; verdict: NEEDS-MIGRATION on a fresh repo until the first `brigade code sync`
brigade care status --target .             # status: missing / units: 0 until you run `care install`
brigade work hooks status --scope user     # "claude hooks: not installed" until you install them
brigade guard scan README.md --json        # a JSON report with "blocked": false on a clean file
brigade fleet status                       # only meaningful once a hub and node token are configured
```

Expected result for the first block: doctor checks pass, roster doctor either validates installed CLIs or reports clear missing tools, dogfood status reports configured artifact and handoff paths, handoff doctor shows covered inboxes or actionable warnings, receipt verification reports valid or clearly marked legacy artifacts, the security scan either passes or writes reviewable findings, and local Brigade state is ignored by git except for intentional template files.

## Gotchas

**Local-first is the default, and the exceptions are named.** Earlier versions of this guide said Brigade never installs cron or starts daemons. That stopped being true: `brigade care install` writes scheduler entries, `brigade fleet serve` and `brigade center serve` run services, and `brigade update` replaces the installed release. Each is an explicit command you run, none happens as a side effect of another command, and `care uninstall` removes only what Brigade wrote. Pushing, tagging, publishing, and editing canonical memory still require you to act.

**Scanners and sweeps are foreground unless you schedule them.** `brigade work sweep` runs when you run it. For unattended runs, either use `brigade care install` for the recipes it covers or wire your own systemd timer or agent cron (see [`../automation/cron-patterns.md`](../automation/cron-patterns.md)). Do not do both for the same job.

**A fleet claim is ownership.** `brigade run` takes a hub claim on the repo, and a second run against it will wait or fail. If a crashed run left a claim behind, release it with `brigade fleet claims --release`. `--no-fleet-claim` skips the claim and leaves only the local lock, so use it knowingly.

**The code graph is static.** `brigade code impact` and `affected` follow call edges the indexer resolved. Dynamic dispatch, reflection, and generated code can hide a caller, and a stale graph misses new files. `sync` before you trust an answer, and treat an error as a skipped check, not an empty result.

**User-scope hooks apply everywhere.** `brigade work hooks install --scope user` changes `~/.claude` for every repo on that machine, including ones that are not Brigade-wired. Start with `--scope project` on one repo, read `status`, and widen when it behaves.

**PyPI can trail the build you read about.** The release on PyPI was 0.27.0 when this guide was written, while 0.28.0 was installed. Check `brigade --version` and `brigade update --dry-run` before assuming a flag exists, and read `--help` for your version.

**Use current Brigade names in new docs.** Brigade can still read pre-Brigade installs and deprecated aliases for migration, but cookbook examples should use `brigade`, `.brigade/`, and the `brigade-cli` package.

**Dogfood defaults are Codex-shaped.** New dogfood configs default handoffs to `.codex/memory-handoffs/` because the built-in dogfood roster is Codex-driven. Pass `--handoff-inbox` if your canonical memory owner ingests `.claude/memory-handoffs/` or another path. Trusted-workspace runs also default to Codex's `danger-full-access` so shell inspection works. Pass `--native-read-only-sandbox` when the host supports the tighter setting.

**`brigade run --read-only` is adapter-specific.** Some adapters use a native sandbox, plan mode, or a restricted tool list. Others receive a prompt instruction or no enforceable local restriction. Brigade warns when an assigned seat has soft or absent enforcement. Use the warning, `brigade roster doctor`, and the adapter's own isolation controls before running against an untrusted checkout.

**Direct Cursor plan mode has model-specific output gaps.** Composer and Grok models can finish a read-only direct run without returning findings as assistant text. Use the reviewed ACP transport and its pinned `transport_version` for those Cursor worker seats.

**Run artifacts are local state.** `.brigade/runs/`, `.brigade/work/`, `.brigade/security/`, and machine-local config should stay ignored. Commit templates and public policy files, not the evidence bundle from your own workstation.

**Security scan findings are not memory yet.** They become imports for review. Promote only findings that are durable, actionable, and scrubbed of sensitive detail.

**Issue-backed tasks do not poll GitHub.** `--from-issue` snapshots issue metadata once. Brigade never syncs, mutates, or refreshes issues in the background, and never stores issue body text.

**Cookbook templates are a readable subset.** The installable templates in `src/brigade/templates/` remain the source of truth for generated workspaces. When Brigade adds cards, handoff source examples, station wiring, or scanner contracts, sync the public cookbook templates deliberately instead of assuming they are already current.

## Templates

The long-form cookbook templates live under [`../templates/`](../templates/). Brigade's installable templates live in its repo under `src/brigade/templates/` and are the source of truth for generated workspaces.

## Related

- [`../knowledge/bootstrap-files.md`](../knowledge/bootstrap-files.md) - what each bootstrap file owns
- [`../knowledge/claude-code-memory-handoffs.md`](../knowledge/claude-code-memory-handoffs.md) - handoff format and ingestion rules
- [`../ai-stack/multi-model-orchestration.md`](../ai-stack/multi-model-orchestration.md) - designing the roster Brigade dispatches
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - publish-boundary scrubbing
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - security model for agent workspaces
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - scheduling sweeps and daily runs unattended
