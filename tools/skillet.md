# Skillet

> The skills rack: installable agent skills for auditing, improving, and shipping repos. The flagship is line-check, a repo audit that ends in a leverage-sorted improvement backlog instead of a wall of findings.

_Current as of skillet 0.6.0, 2026-07-13._

## What this is

[`skillet`](https://github.com/escoffier-labs/skillet) is a public collection of agent skills extracted from the workflows in this cookbook. Where [Brigade](brigade.md) gives your agent kitchen its shape (memory, handoffs, guards), skillet gives the cooks their techniques: repeatable procedures any SKILL.md-capable harness can load on demand.

Thirty-two skills ship in 0.6.0, organized by job. Any SKILL.md-capable harness loads them on demand:

| Family | Skills |
|--------|--------|
| Design and build | `mise` (idea to approved spec), `recipe` (spec to plan), `demi`, `taste` (test-first), `fire` (execute a plan task by task), `stations` (fan out parallel work), `worktree` |
| Debug and verify | `refire` (root-cause before any fix), `check` (prove it works before claiming it), `graphtrail` (structural code queries), `thermometer` (performance baselines) |
| Review and ship | `pass` (the pre-PR gate), `review`, `sendback`, `release-cut`, `expedite` |
| Audit and direction | `line-check` (the flagship repo audit), `bug-hunt`, `security-sweep`, `stocktake` (dependency and runtime inventory), `special` |
| Simplify | `reduce` |
| Writing and publishing | `grill`, `plate`, `publish-readiness`, `reel-check`, `garnish` (site metadata and indexing) |
| Memory | `memory-handoff`, `brigade-handoffs` |
| Pressure and meta | `pressure-test`, `skillify`, `using-skillet` |

`line-check` is still the flagship: it audits a repo across seven stations (docs, agent-readiness, tests/CI, hygiene, structure, release hygiene, TODO mining), scores each 0-5, and delivers a backlog sorted by impact relative to effort. It composes with `bug-hunt` and `security-sweep` (the audit trio) on a shared report contract.

## Why this way

Three design calls worth stealing:

**One report contract across the audit trio.** line-check, bug-hunt, and security-sweep share a severity scale, finding schema, and backlog format. Run them weeks apart and the findings still compose into one prioritized list. The contract lives in [`docs/audit-report-format.md`](https://github.com/escoffier-labs/skillet/blob/main/docs/audit-report-format.md) and each skill inlines the short version so it works standalone.

**Backlogs, not findings.** The deliverable of an audit is the ordered list of what to do next. A finding without a concrete fix, an effort estimate, and a checkable location does not make the report. Cheap high-impact items float to the top regardless of severity.

**Verification before reporting.** bug-hunt's verifiers are prompted to refute, not confirm; findings that survive get a concrete trigger, findings that do not die silently. Plausible-but-wrong findings are the failure mode of agent auditing, and redundant generation does not fix it; adversarial review does.

## How it pairs with Brigade

line-check's agent-readiness station checks the things Brigade manages: are `AGENTS.md`/`CLAUDE.md` present and accurate, is the handoff wiring healthy (`brigade handoff doctor`), are memory cards fresh (`brigade memory care scan`). The memory-handoff skill writes handoffs that pass `brigade handoff lint`. None of the skills require Brigade; they detect it and use it when present.

## Install

Claude Code:

```
/plugin marketplace add escoffier-labs/skillet
/plugin install skillet@skillet
```

OpenClaw or any SKILL.md-compatible harness:

```bash
git clone https://github.com/escoffier-labs/skillet
cp -r skillet/skillet/skills/line-check <your-skills-dir>/
```

## Verification

Confirm the clone ships every skill as a discoverable `SKILL.md`:

```bash
git clone https://github.com/escoffier-labs/skillet
ls skillet/skillet/skills/*/SKILL.md | wc -l
# 32

ls skillet/skillet/skills
# brigade-handoffs  bug-hunt  check  demi  expedite  fire  garnish
# graphtrail  grill  line-check  memory-handoff  mise  pass  plate
# pressure-test  publish-readiness  recipe  reduce  reel-check  refire
# release-cut  review  security-sweep  sendback  skillify  special
# stations  stocktake  taste  thermometer  using-skillet  worktree
```

In Claude Code, after the marketplace install, run `/plugin` and confirm `skillet` appears in the installed list; its skills then show up as `skillet:line-check` and friends.

## Gotchas

- The first draft of memory-handoff documented a base format that failed `brigade handoff lint`: lint hard-requires the routing sections (`Recommended memory action` and friends) and YAML frontmatter inside suggested card content. The skill now documents the lintable format up front. Lesson: if a skill tells the agent to run a validator, the skill's own template has to pass that validator.
- A vanilla agent asked to "audit this repo" produced genuinely good findings but no scorecard, no effort estimates, no prioritization, and it never ran the brigade health checks sitting right there in the repo. The skill's value is not making the model smarter; it is making the output composable and the procedure complete.
- Naming collisions matter for public skills: the pressure-test skill was nearly called "expo" until the React Native collision surfaced. Search the name before you ship it.
