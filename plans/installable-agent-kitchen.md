# Solomon's Mise en Place Installable Agent Workspace Plan

> Goal-mode plan for turning this cookbook into an installable, public-safe starter kit for a harness-agnostic agent memory system, with OpenClaw as the reference implementation.

## Name

Do not name this `sskill`, `sbrain`, or `sstack`. The name should signal repeatable setup, working memory, and cookbook energy without sounding like another generic agent framework.

Working decision:

- **Project/package:** `solo-mise`
- **Repo name:** `solo-mise`
- **Public brand/display name:** Solomon's Mise en Place
- **Tagline:** Mise en place for agent memory.
- **Plain-language metaphor:** agent kitchen.
- **CLI:** `solo-mise`

Why this works:

- "Mise en place" means everything in its place before service, which maps directly to bootstrap files, memory routing, handoffs, safety rules, and publish guards.
- `solo-mise` keeps the repo and CLI short, while "Solomon's Mise en Place" gives the public brand the fuller cookbook identity.
- It is shorter and more package-friendly than `agent-mise-en-place`.
- `Agent Kitchen` remains useful in explanation, but "Solomon's Mise en Place" is stronger as the public brand.

Naming alternatives kept for reference:

| Name | Why it fits | Risk |
|------|-------------|------|
| **Agent Kitchen** | Ties directly to the cookbook. Implies tools, prep, recipes, and a working place where things get made. | Better as metaphor than package name. |
| **Solo Kitchen** | Keeps it personal and brandable without locking into S3. Easy to say: "install Solo Kitchen." | Could sound like a recipe app. |
| **Gasworks** | Matches "Cookin' with Gas" and feels like infrastructure. | Less obvious for memory/setup. |
| **Mise** | Conceptually perfect and short. | Too broad/generic alone. |
| **Agent Mise en Place** | Explicitly ties the concept to agents. | Too long and awkward as a CLI/package. |
| **Open Mise** | Signals a reusable, open setup without pretending to be OpenClaw itself. | Could imply official OpenClaw affiliation. |
| **Kitchen Pass** | A pass that gets an agent into the kitchen with the right rules and memory paths. | More playful, less obviously technical. |
| **Prep Station** | Clear cookbook metaphor for preparing an agent workspace. | Generic and less brandable. |
| **Solo Pantry** | Memory store metaphor. Good for cards, tools, reusable templates. | Sounds more like storage than an installer. |

Public line:

```text
Solomon's Mise en Place is the installable starter kit behind Solomon's Guide to Cookin' with Gas: a public-safe agent workspace, memory handoff flow, and bootstrap layout for OpenClaw, Hermes, Codex, Claude Code, and similar harnesses.
```

## What This Is

The cookbook is currently a set of standalone guides and templates. The installable version should become a reproducible starter kit that creates the same *shape* as the live setup without copying private state.

This new project must be more concise than `solos-cookbook`. The cookbook can stay broad, narrative, and cross-linked. The installable kit should be boring to clone, obvious to run, and small enough that a user understands the file tree in one screen.

The kit should install:

- sanitized bootstrap files for agent behavior, safety, tools, identity, and memory
- a canonical memory layout where one configured owner owns durable long-term knowledge
- a `.claude/memory-handoffs/` inbox shared by Claude Code, Codex, and any other side harness
- starter memory cards and routing rules
- content-guard publish gates so private infrastructure does not leak into public docs
- optional adapter fragments for OpenClaw first, Hermes next, and generic harnesses after that
- verification commands that prove the system is wired before the user trusts it

The kit should not install:

- private hostnames, IPs, account IDs, channel IDs, or personal details
- live auth profiles or OAuth tokens
- cron jobs that post publicly by default
- destructive endpoints, unsafe automation, or write-enabled integrations without explicit opt-in
- multiple competing canonical memory systems

## Design Principle

One memory owner remains the source of truth. In the live setup that owner is OpenClaw. In a Hermes setup it may be Hermes. In a lighter setup it may be a local repo-owned memory directory until the user wires an orchestrator.

Claude Code, Codex, browser agents, and other coding harnesses may keep local session context, but durable knowledge flows back through memory handoffs and is routed into the configured canonical memory owner.

That means the installer must create a contract, not an OpenClaw-only fork:

```text
Claude Code / Codex / other harness
        |
        v
<repo>/.claude/memory-handoffs/*.md
        |
        v
handoff ingester adapter
        |
        v
memory/cards/*.md, TOOLS.md, USER.md, rules/*.md, .learnings/*.md
```

The public wording should be: **harness-agnostic contract, OpenClaw-tested defaults.**

## Public Surface

The public package should have three entrypoints:

1. **Human install path**
   - command: `solo-mise init` or final branded equivalent
   - outcome: creates a public-safe workspace skeleton and explains what to configure next

2. **Agent install path**
   - file: `INSTALL_FOR_AGENTS.md`
   - outcome: any entering agent knows which files to read first and how to write durable findings

3. **OpenClaw integration path**
   - command: `solo-mise openclaw doctor`
   - outcome: checks that OpenClaw can see the workspace, memory directory, handoff inbox, content guard, and optional model lanes

Add a fourth entrypoint once the base contract is stable:

4. **Hermes integration path**
   - command: `solo-mise hermes doctor`
   - outcome: checks that Hermes can see the workspace, bootstrap files, handoff inbox, and configured memory owner

## Concise Repo Shape

Do not recreate the cookbook's many-category documentation tree. The installable project should have a flat, practical layout:

```text
solo-mise/
  README.md
  QUICKSTART.md
  pyproject.toml
  src/solo_mise/
  templates/
  policies/
  tests/
```

Keep top-level docs to:

- `README.md`: what this is, install command, 5-minute path
- `QUICKSTART.md`: step-by-step local install and verification
- `REFERENCE.md` only if the CLI grows enough to need it

Everything else should live as generated templates, not explanatory prose. Link back to `solos-cookbook` for deep explanations.

## Installer Shape

Start with a small Python CLI because the cookbook already depends on Python-era tooling through content-guard, and Python keeps the first version portable.

Proposed internal package layout:

```text
solo-mise/
  src/solo_mise/
    __init__.py
    cli.py
    init.py
    doctor.py
    scrub.py
    templates.py
  templates/
    workspace/
      AGENTS.md
      CLAUDE.md
      SOUL.md
      USER.md
      TOOLS.md
      MEMORY.md
      IDENTITY.md
      HEARTBEAT.md
      SAFETY_RULES.md
      INSTALL_FOR_AGENTS.md
    memory/
      cards/
        memory-architecture.md
        handoff-flow.md
        content-safety.md
    claude/
      memory-handoffs/
        TEMPLATE.md
    openclaw/
      model-aliases.openclaw.json
      ollama-memory-search.openclaw.json
      acp-escalation.openclaw.json
    hermes/
      workspace.harness.json
      memory-handoff.harness.json
      model-lanes.harness.json
    generic/
      memory-contract.md
      harness-adapter-checklist.md
    hooks/
      pre-push
    policies/
      public-repo.json
      public-content.json
  tests/
```

The cookbook repo can keep the plan, but the actual installable project should probably become its own concise repo once the CLI starts. That avoids inheriting the cookbook's intentionally broad file structure.

## Commands

Minimum useful CLI:

```bash
solo-mise init --target ~/.openclaw/workspace
solo-mise init --target . --profile repo
solo-mise doctor --target ~/.openclaw/workspace
solo-mise doctor --target . --harness generic
solo-mise scrub --target .
solo-mise handoff-template --target .
```

Later:

```bash
solo-mise openclaw-fragments --out ./openclaw-fragments
solo-mise hermes-fragments --out ./hermes-fragments
solo-mise install-hooks --repo .
solo-mise migrate-claude-memory --source ~/.claude/projects --target ~/.openclaw/workspace
```

Avoid command sprawl. If a command is not part of install, verify, scrub, or handoff, it belongs in the cookbook first and the CLI later.

## Profiles

Profiles keep the installer from pretending every user wants the full live setup.

| Profile | Installs | Use case |
|---------|----------|----------|
| `repo` | repo-local `AGENTS.md`, `CLAUDE.md`, `.claude/memory-handoffs/`, pre-push hook | A project wants the handoff flow and public leak guard. |
| `workspace` | full bootstrap file set, memory folders, starter cards, safety files | A user wants an OpenClaw-style home workspace. |
| `openclaw` | workspace profile plus OpenClaw config fragments and doctor checks | A user is actively running OpenClaw. |
| `hermes` | workspace profile plus Hermes adapter fragments and doctor checks | A user wants the same memory contract in Hermes. |
| `generic` | contract docs, templates, and no orchestrator-specific config | A user wants the file layout without committing to a harness. |
| `publisher` | content-guard policies, scrub commands, PR/publish gates | A user publishes blog posts, docs, or social drafts from agent output. |

Default should be `repo`, because it is the least invasive.

## Bootstrap File Contract

The installer should preserve the cookbook's existing file split:

| File | Job |
|------|-----|
| `AGENTS.md` | shared operating rules, safety rules, memory handoff rule |
| `CLAUDE.md` | Claude Code-specific bridge rules |
| `SOUL.md` | voice and interaction style |
| `USER.md` | stable user preferences only |
| `TOOLS.md` | commands, services, ports, scripts, operational runbooks |
| `MEMORY.md` | slim index pointing to memory cards, not a giant memory dump |
| `IDENTITY.md` | short agent role and identity |
| `HEARTBEAT.md` | recurring check-in rules |
| `SAFETY_RULES.md` | hard boundaries and publishing constraints |
| `INSTALL_FOR_AGENTS.md` | first-read entrypoint for new agents |

The generated `AGENTS.md` must include the core rule, with the memory owner filled from the selected harness:

```md
The configured memory owner is the canonical long-term memory owner. Side harnesses may keep local context, but durable knowledge must be written as a Memory Handoff in `.claude/memory-handoffs/`.
```

For the `openclaw` profile, render that as OpenClaw. For the `hermes` profile, render that as Hermes. For `generic`, render it as "this repo's memory directory until an orchestrator ingests it."

## Memory Handoff Contract

The installer should create:

```text
.claude/memory-handoffs/
  TEMPLATE.md
  processed/
memory/
  cards/
  handoff-inbox/
.learnings/
rules/
```

The handoff template should match the existing cookbook guide:

- `Type`
- `Title`
- `Summary`
- `Durable facts`
- `Evidence`
- `Recommended memory action`
- `Target card`
- `Suggested card content`
- `Target document`
- `Suggested document content`

The ingester should be conservative:

- auto-promote only safe card filenames with frontmatter
- append only to allowlisted non-card documents
- route ambiguous handoffs into `memory/handoff-inbox/`
- move processed files into `.claude/memory-handoffs/processed/`
- log every action

## OpenClaw Integration

The installable kit should not rewrite a user's `openclaw.json` on first run. It should generate fragments and doctor output first.

Useful fragments:

- model aliases for main, coder, and cron lanes
- ACP escalation wrapper shape for Claude Code
- local Ollama embedding lane for memory search
- browser-lane lock wrapper
- content-guard message plugin example

Doctor checks:

```bash
test -d "$WORKSPACE/.claude/memory-handoffs"
test -d "$WORKSPACE/memory/cards"
test -f "$WORKSPACE/AGENTS.md"
test -f "$WORKSPACE/MEMORY.md"
jq '.plugins.entries | keys' ~/.openclaw/openclaw.json
jq '.agents.defaults.model.primary' ~/.openclaw/openclaw.json
```

The doctor should report "manual action needed" instead of editing config when:

- OpenClaw is not installed
- the config file does not exist
- plugin allowlists would block required plugins
- auth profiles are missing
- content-guard is unavailable
- memory search points at a local embedding service that is not running

## Hermes Integration

Hermes support should use the same file contract, not a second template universe. The Hermes adapter should answer only three questions:

1. Which files does Hermes load as bootstrap instructions?
2. Where should Hermes or side harnesses write memory handoffs?
3. What command or workflow ingests those handoffs into canonical memory?

Initial Hermes deliverable:

- `templates/hermes/workspace.harness.json` with placeholder paths
- `templates/hermes/memory-handoff.harness.json` describing the handoff inbox and routing targets
- `solo-mise hermes doctor` that validates the generated files exist
- docs that say "Hermes support follows the same contract; OpenClaw is just the tested reference path"

Do not add Hermes-specific behavior until verified against a real Hermes install. Keep the first version as adapter fragments plus doctor checks.

## Harness Contract

Every supported harness should map to the same abstract contract:

| Contract field | Meaning |
|----------------|---------|
| `bootstrap_files` | Files loaded into the agent's starting context |
| `memory_owner` | System responsible for canonical durable memory |
| `handoff_inbox` | Directory where side harnesses write handoff markdown |
| `routing_targets` | Allowed memory outputs: cards, tools, user prefs, rules, learnings |
| `doctor_checks` | Commands that prove the harness can see the expected files |
| `publish_gate` | Content-guard or equivalent scan before public output leaves the repo |

OpenClaw adapter maps this contract to OpenClaw workspace files and config fragments. Hermes adapter maps it to Hermes bootstrap/config paths. Generic adapter writes the contract as markdown plus templates for manual wiring.

## Content-Guard Requirements

Content safety is part of the product, not a later polish pass.

The installer should include:

- a tracked `hooks/pre-push` that runs content-guard against public repo policy
- public content policy for blog/social/docs surfaces
- repo policy that blocks private IPs, secrets, PII, and AI attribution trailers
- inline allow comment support for intentional examples
- `solo-mise scrub` wrapper that can run deterministic redaction before publish

Default blocked classes:

- private IP addresses and loopback endpoints
- internal hostnames and usernames
- local service URLs and sensitive ports
- secrets, tokens, API keys, OAuth material
- personal contact details and account IDs
- private business strategy or unreleased project identifiers
- AI attribution in commits or public release text

Verification gate:

```bash
PYTHONPATH="$HOME/repos/content-guard/src" \
  python3 -m content_guard scan . \
  --policy "$HOME/repos/content-guard/policies/public-repo.json"
```

No guide, template, or generated public artifact should be considered ready until this passes.

## Sanitization Boundary

The live OpenClaw setup can be used as source material for architecture, but never as copy-paste material.

Allowed to publish:

- file roles and directory structure
- generic model lane names
- generic examples of memory cards and handoffs
- placeholder OpenClaw config fragments
- verification commands with placeholder paths
- public repo URLs

Must scrub or avoid:

- hostnames, local usernames, private domains, IP addresses
- exact service ports unless they are generic examples with allow comments
- channel IDs, phone numbers, email addresses, OAuth profile paths with private user context
- private project names not already public
- job, school, family, finance, and personal workflow details
- token values, env var values, browser profile paths containing account identity

## Relationship To Existing Cookbook

Existing docs already cover the architecture:

- `knowledge/bootstrap-files.md`
- `knowledge/memory-architecture.md`
- `knowledge/memory-token-optimization.md`
- `knowledge/claude-code-memory-handoffs.md`
- `ai-stack/multi-model-orchestration.md`
- `ai-stack/acp-claude-code.md`
- `ai-stack/skills-development.md`
- `publishing/publish-time-scrubbing.md`
- `automation/hooks.md`

The installable kit should not duplicate those guides. It should turn them into a repeatable path:

1. install skeleton
2. configure local details
3. run doctor
4. write first handoff
5. run ingest
6. run content-guard
7. commit only sanitized templates

The cookbook can stay OpenClaw-heavy because it documents the live system. The installable project should say "OpenClaw-focused and Hermes-compatible" until Hermes support is verified, then "harness-agnostic with OpenClaw and Hermes adapters."

## Milestones

### Milestone 1: Plan And Name

- choose working package name
- define package/repo location
- decide whether this lives inside `solos-cookbook` first or starts as a separate repo
- write public positioning paragraph
- enforce the concise repo rule: one README, one quickstart, one CLI, one template tree

Exit criteria:

- one chosen name
- one package location
- one short README pitch
- file tree fits in one terminal screen

### Milestone 2: Static Template Pack

- copy existing public-safe templates into an installable template tree
- add memory handoff template
- add starter memory cards
- add content-guard hook and policies
- add generated `INSTALL_FOR_AGENTS.md`

Exit criteria:

- `solo-mise init --dry-run --target /tmp/solo-mise-test` prints the files it would create
- no private details in generated files

### Milestone 3: CLI Init And Doctor

- implement `init`
- implement `doctor`
- implement `scrub`
- add overwrite protection and `--force`
- add profile selection

Exit criteria:

- clean install into a temp directory
- `doctor` passes against the temp directory
- tests cover overwrite refusal and profile selection

### Milestone 4: Handoff Ingester

- add conservative parser
- add auto-promote rules
- add append-only routing for `TOOLS.md`, `USER.md`, `rules/*.md`, and `.learnings/*.md`
- add processed archive
- add dry-run mode

Exit criteria:

- sample handoff becomes a card
- sample tool note appends to `TOOLS.md`
- invalid target routes to review inbox

### Milestone 5: OpenClaw Fragments

- generate config fragments instead of mutating live config
- add doctor checks for plugin entries, model aliases, memory search, and handoff paths
- document manual merge flow

Exit criteria:

- users can inspect a JSON fragment before applying it
- doctor reports actionable checks without exposing local secrets

### Milestone 6: Public Release Gate

- run content-guard across the repo
- run deterministic scrubber on generated docs
- add CI job for content-guard
- add release checklist

Exit criteria:

- content-guard passes on all tracked files
- README has install commands
- package can be installed from GitHub

## Implementation Risks

| Risk | Mitigation |
|------|------------|
| Accidentally publishing private setup details | Treat live files as reference only. Run content-guard before every commit and release. |
| Creating a second memory source of truth | Make OpenClaw canonical in every generated `AGENTS.md` and `CLAUDE.md`. |
| Overwriting user bootstrap files | Default to no overwrite. Require `--force` or write `.new` files. |
| OpenClaw config schema drift | Generate fragments and doctor checks first. Avoid automatic mutation until the schema is stable. |
| Hermes support becomes speculative | Ship a generic contract first. Mark Hermes adapter experimental until verified against a real install. |
| Users install unsafe automation blindly | Keep cron, posting, and destructive integrations opt-in. |
| Name confusion with OpenClaw | Make the package a cookbook-derived starter kit, not an official OpenClaw distribution. |

## Open Questions

- Repo/package name is currently `solo-mise`; public brand is currently Solomon's Mise en Place. Validate package/repo availability before release.
- Should the installable package live in this repo first, or in a new repo once the CLI starts?
- Should the first release target OpenClaw only, or also generate Codex and Claude Code user-level files?
- What exact Hermes files and commands should the adapter validate?
- Should content-guard be vendored as an optional dependency, required dependency, or external tool check?
- Should the handoff ingester be included in the package or kept as an OpenClaw-side script?

## First Build Slice

The smallest useful implementation is:

1. standalone `solo-mise/` Python CLI, or temporary `packages/solo-mise/` only until extraction
2. `solo-mise init --target /tmp/test --profile repo`
3. generated `AGENTS.md`, `CLAUDE.md`, `.claude/memory-handoffs/TEMPLATE.md`, `hooks/pre-push`
4. `solo-mise doctor --target /tmp/test`
5. content-guard scan against generated output

That proves the product loop without touching a user's live OpenClaw config.

The first public release should feel like:

```bash
pipx install git+https://github.com/solomonneas/solo-mise
solo-mise init
solo-mise doctor
```

If a new user has to read the whole cookbook before running those commands, the installable project has failed.
