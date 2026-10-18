# Skillet

> The skills rack: installable agent skills for auditing, improving, and shipping repos. The flagship is line-check, a repo audit that ends in an impact-sorted improvement backlog instead of a wall of findings.

_Current as of skillet 0.6.0 (the latest tag, 2026-07-11) plus main as of 2026-10-17._

## What this is

[`skillet`](https://github.com/escoffier-labs/skillet) is a public collection of agent skills extracted from the workflows in this cookbook. Where [Brigade](brigade.md) gives your agent kitchen its shape (memory, handoffs, guards), skillet gives the cooks their techniques: repeatable procedures any SKILL.md-capable harness can load on demand.

The tagged release, v0.6.0, ships 32 skills. Main is ahead of the tag: eight skills (marked **new** below) were added after it and are listed under Unreleased in the CHANGELOG, for 40 on main as of 2026-10-17. So "how many skills" has two answers, and which one you get depends on whether you install the tag or track main. Any SKILL.md-capable harness loads them on demand, organized by job:

| Family | Skills |
|--------|--------|
| Design and build | `mise` (idea to approved spec), `recipe` (spec to plan), `demi`, `taste` (test-first), `fire` (execute a plan task by task), `stations` (fan out parallel work), `worktree` |
| Debug and verify | `refire` (root-cause before any fix), `check` (prove it works before claiming it), `graphtrail` (structural code queries), `thermometer` (performance baselines), **new** `trim` (test value bar: gate every new test, audit junk tests, run a subsystem cleanup campaign) |
| Review and ship | `pass` (the pre-PR gate), `review`, `sendback`, `release-cut`, `expedite` |
| Audit and direction | `line-check` (the flagship repo audit), `bug-hunt`, `security-sweep`, `stocktake` (dependency and runtime inventory), `special`, **new** `latent-premises` (review a diff for assumptions nothing guarantees: input, contract, environment, ordering, cardinality), **new** `retry-safety` (check whether re-running a side-effecting diff is safe: writes, migrations, queues, payments) |
| Simplify | `reduce` |
| Writing and publishing | `grill`, `plate`, `publish-readiness`, `reel-check`, `garnish` (site metadata and indexing) |
| Answers and research | **new** `brief` (lead with the judgment at a decision point so the reader can evaluate it), **new** `research-brief` (sourced, dated, evidence-backed findings with a claim register and a citation-support pass) |
| Orchestration and tooling | **new** `fleet-conductor` (conduct a large backlog or multi-repo campaign across worker lanes with bounded ownership, draft-PR gates, and evidence-based landing), **new** `stagiaire` (dispatch another vendor's CLI as a one-shot worker for a second opinion or bulk work), **new** `t3-code` (configure and troubleshoot T3 Code projects, environments, updates, and remote access) |
| Memory | `memory-handoff`, `brigade-handoffs` |
| Pressure and meta | `pressure-test`, `skillify`, `using-skillet` |

`stagiaire` and `fleet-conductor` expect a Brigade roster with authenticated seats. The others run without one.

`line-check` is still the flagship: it audits a repo across seven stations (docs, agent-readiness, tests/CI, hygiene, structure, release hygiene, TODO mining), scores each 0-5, and delivers a backlog sorted by impact relative to effort. It composes with `bug-hunt` and `security-sweep` on a shared report contract, and the two newer review lenses, `latent-premises` and `retry-safety`, use the same format, so the audit trio is now a five-skill roster. `latent-premises` and `retry-safety` are read-only. Applying their fixes belongs to `expedite`.

## Why this way

Three design calls worth stealing:

**One report contract across the audit roster.** line-check, bug-hunt, security-sweep, latent-premises, and retry-safety share a severity scale, finding schema, and backlog format. Run them weeks apart and the findings still compose into one prioritized list. The contract lives in [`docs/audit-report-format.md`](https://github.com/escoffier-labs/skillet/blob/main/docs/audit-report-format.md) and each skill inlines the short version so it works standalone.

**Backlogs, not findings.** The deliverable of an audit is the ordered list of what to do next. A finding without a concrete fix, an effort estimate, and a checkable location does not make the report. Cheap high-impact items float to the top regardless of severity.

**Verification before reporting.** bug-hunt's verifiers are prompted to refute, not confirm. Findings that survive get a concrete trigger, findings that do not die silently. Plausible-but-wrong findings are the failure mode of agent auditing, and redundant generation does not fix it. Adversarial review does.

## How it pairs with Brigade

line-check's agent-readiness station checks the things Brigade manages: are `AGENTS.md`/`CLAUDE.md` present and accurate, is the handoff wiring healthy (`brigade handoff doctor`), are memory cards fresh (`brigade memory care scan`). The memory-handoff skill writes handoffs that pass `brigade handoff lint`. None of the skills require Brigade. They detect it and use it when present.

## Install

Claude Code:

```
/plugin marketplace add escoffier-labs/skillet
/plugin install skillet@skillet
```

Any `npx skills`-compatible harness, or Brigade's skills station:

```bash
npx skills add escoffier-labs/skillet --list   # see every skill without installing
npx skills add escoffier-labs/skillet
brigade add skills
```

OpenClaw or any other SKILL.md-compatible harness, by copying a skill directory:

```bash
git clone https://github.com/escoffier-labs/skillet
cp -r skillet/skillet/skills/line-check <your-skills-dir>/
```

A clone tracks main, so it carries the unreleased skills. To get exactly the tagged set, check out the tag first (`git checkout v0.6.0`). I have not confirmed which of tag or main the Claude Code marketplace install serves. Its `plugin.json` still reads 0.6.0 on main, so check the skill list it shows instead of trusting the version string.

## Verification

Confirm that every skill in the checkout you are using is a discoverable `SKILL.md`, and count against the release you meant to install rather than a number from this guide:

```bash
git clone https://github.com/escoffier-labs/skillet
cd skillet

# every skill directory has a SKILL.md (prints nothing when healthy)
for d in skillet/skills/*/; do test -f "$d/SKILL.md" || echo "missing: $d"; done

# count on main: 40 or more (40 on 2026-10-17)
ls skillet/skills/*/SKILL.md | wc -l

# count on the tagged release
git tag --sort=-v:refname | head -3      # v0.6.0 was the latest tag
git checkout -q v0.6.0
ls skillet/skills/*/SKILL.md | wc -l
# 32

# the unreleased skills should be absent on the tag and present on main
ls skillet/skills | grep -E '^(brief|fleet-conductor|latent-premises|research-brief|retry-safety|stagiaire|t3-code|trim)$'
# (no output on v0.6.0)
git checkout -q main
```

On the tag, `ls skillet/skills` lists these 32:

```
brigade-handoffs  bug-hunt  check  demi  expedite  fire  garnish
graphtrail  grill  line-check  memory-handoff  mise  pass  plate
pressure-test  publish-readiness  recipe  reduce  reel-check  refire
release-cut  review  security-sweep  sendback  skillify  special
stations  stocktake  taste  thermometer  using-skillet  worktree
```

On main, add `brief`, `fleet-conductor`, `latent-premises`, `research-brief`, `retry-safety`, `stagiaire`, `t3-code`, and `trim`. If a future tag moves the count, trust `git tag` and the CHANGELOG over this guide.

In Claude Code, after the marketplace install, run `/plugin` and confirm `skillet` appears in the installed list. Its skills then show up as `skillet:line-check` and friends. Compare that list with the count for the ref you installed.

## Gotchas

- The first draft of memory-handoff documented a base format that failed `brigade handoff lint`: lint hard-requires the routing sections (`Recommended memory action` and friends) and YAML frontmatter inside suggested card content. The skill now documents the lintable format up front. Lesson: if a skill tells the agent to run a validator, the skill's own template has to pass that validator.
- A vanilla agent asked to "audit this repo" produced genuinely good findings but no scorecard, no effort estimates, no prioritization, and it never ran the brigade health checks sitting right there in the repo. The skill's value is not making the model smarter. It is making the output composable and the procedure complete.
- Counts drift between the tag and main. This guide's verification block once hard-coded `32`, which passed on the v0.6.0 tag and failed on a fresh clone of main after eight skills landed. A count check is only meaningful against a named ref, so the block above checks out the tag before comparing.
- Skills that fetch or ingest outside content (grill, plate, publish-readiness, research-brief, review, and others) now carry an `## Untrusted content` section that treats fetched text as data, not instructions. If you write your own skills from `skillify` or the cookbook's skeleton, add the same section. Skillet's lint enforces it for its own.
- Naming collisions matter for public skills: the pressure-test skill was nearly called "expo" until the React Native collision surfaced. Search the name before you ship it.
