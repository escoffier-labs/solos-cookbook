# Skillet

> The skills rack: installable agent skills for auditing, improving, and shipping repos. The flagship is line-check, a repo audit that ends in a leverage-sorted improvement backlog instead of a wall of findings.

_Current as of skillet 0.1.0, 2026-06-10._

## What this is

[`skillet`](https://github.com/escoffier-labs/skillet) is a public collection of agent skills extracted from the workflows in this cookbook. Where [Brigade](brigade.md) gives your agent kitchen its shape (memory, handoffs, guards), skillet gives the cooks their techniques: repeatable procedures any SKILL.md-capable harness can load on demand.

Eight skills ship in 0.1.0:

| Skill | What it does |
|-------|--------------|
| `line-check` | The flagship. Audits a repo across seven stations (docs, agent-readiness, tests/CI, hygiene, structure, release hygiene, TODO mining), scores each 0-5, and delivers a backlog sorted by impact relative to effort |
| `bug-hunt` | Correctness sweep across five lenses; every candidate bug must survive an adversarial refutation attempt before it reaches the report |
| `security-sweep` | Defensive audit: secrets in tree and history, dependency CVEs, injection surfaces, authn/authz, accidental exposure |
| `pressure-test` | Interrogates a plan one question at a time until decisions are explicit; sous mode self-answers from evidence with an auditable Q&A transcript when you go AFK |
| `publish-readiness` | The private-to-public gate: tree and history leak scans plus the full filter-repo rewrite recipe when something already leaked |
| `release-cut` | Changelog roll-up, semver bump, tag, GitHub release, drafted announcement; releases on request, never per feature |
| `memory-handoff` | Ends a session by writing durable knowledge into a brigade-lintable handoff |
| `skillify` | Turns a script or repeated workflow into a new skill, with a fresh-agent test before it counts as done |

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

Confirm the clone has all eight skills and every skill ships its `SKILL.md`:

```bash
git clone https://github.com/escoffier-labs/skillet
ls skillet/skillet/skills
# bug-hunt  line-check  memory-handoff  pressure-test
# publish-readiness  release-cut  security-sweep  skillify

ls skillet/skillet/skills/*/SKILL.md | wc -l
# 8
```

In Claude Code, after the marketplace install, run `/plugin` and confirm `skillet` appears in the installed list; its skills then show up as `skillet:line-check` and friends.

## Gotchas

- The first draft of memory-handoff documented a base format that failed `brigade handoff lint`: lint hard-requires the routing sections (`Recommended memory action` and friends) and YAML frontmatter inside suggested card content. The skill now documents the lintable format up front. Lesson: if a skill tells the agent to run a validator, the skill's own template has to pass that validator.
- A vanilla agent asked to "audit this repo" produced genuinely good findings but no scorecard, no effort estimates, no prioritization, and it never ran the brigade health checks sitting right there in the repo. The skill's value is not making the model smarter; it is making the output composable and the procedure complete.
- Naming collisions matter for public skills: the pressure-test skill was nearly called "expo" until the React Native collision surfaced. Search the name before you ship it.
