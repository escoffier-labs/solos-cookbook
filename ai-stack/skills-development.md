# Skills Development

How to write custom OpenClaw skills, structure them for discoverability, and extend your agent's capabilities with reusable task-specific instructions.

**Tested on:** OpenClaw 2026.10.4 with 60+ workspace skills, Claude Code 2.1.302 with the Skillet plugin 0.6.0, Brigade 0.28.0
**Last updated:** 2026-10-17

---

## What Skills Are

Skills are reusable instruction sets that teach your agent how to handle specific tasks. Instead of explaining "how to do a security audit" every time you ask for one, you write a skill once and the agent loads it on demand.

A skill is a directory with a `SKILL.md` file and optional reference materials:

```
skills/
└── security-audit/
    ├── SKILL.md              # The instructions
    ├── references/
    │   ├── owasp-top10.md    # Reference material
    │   └── checklist.md      # Audit checklist
    └── scripts/
        └── scan.sh           # Helper scripts
```

When a task matches a skill's description, the agent reads the `SKILL.md` and follows its instructions. Skills aren't loaded by default. They're loaded on-demand to keep the context window clean.

## SKILL.md Structure

Every skill needs a `SKILL.md` with at minimum a description and instructions:

```markdown
---
name: security-audit
description: >
  Run security audits on codebases using static analysis, dependency scanning,
  and manual code review patterns. Use when asked to scan code for
  vulnerabilities, perform a security review, or audit a project.
---

# Security Audit

## When to Use
- User asks for a security review or audit
- User wants to check for vulnerabilities
- Before deploying code to production

## Steps
1. Check for hardcoded secrets (grep for API keys, passwords, tokens)
2. Run dependency vulnerability scan (npm audit, pip audit)
3. Review OWASP Top 10 patterns
4. Check file permissions and access controls
5. Report findings with severity ratings

## Output Format
- List findings by severity (Critical, High, Medium, Low)
- Include file path and line number for each finding
- Provide remediation steps for each issue
```

## Skill Types

### Personal Skills

Stored in your workspace, specific to your setup:

```
~/.openclaw/workspace/skills/
├── morning-briefing/
├── media-management/
├── deploy-checker/
└── network-audit/
```

These are loaded from your workspace and can reference your specific infrastructure, tools, and preferences.

### Project Skills

Stored in a project repository, shared with the team:

```
my-project/.openclaw/skills/
├── pr-review/
├── test-generator/
└── docs-writer/
```

These are scoped to the project and can reference project-specific patterns, architecture, and conventions.

### Community Skills

Published skills that others can use. The Open Agent Skills standard (agentskills.io) provides a cross-platform format.

Browse community skills at [ClawHub](https://clawhub.ai) or find them on GitHub. A skill you write for one harness is a plain `SKILL.md` directory, so it travels: the next section covers how mine reach each harness.

## Writing Effective Skills

### Be Specific About When to Activate

The `description` field is what determines whether the skill gets loaded. Make it specific:

**Bad:**
```yaml
description: Help with code
```

**Good:**
```yaml
description: >
  Run security audits on codebases using static analysis, dependency scanning,
  and manual code review patterns. Use when asked to scan code for
  vulnerabilities, perform a security review, audit a project, or check
  for security issues.
```

Include trigger phrases that a user might actually say. The agent matches incoming requests against skill descriptions to decide which to load.

### Use References for Large Context

Don't stuff everything into SKILL.md. Use reference files for data that the agent can load on demand:

```markdown
# In SKILL.md
For OWASP Top 10 patterns, read `references/owasp-top10.md`.
For the audit checklist, read `references/checklist.md`.
```

This keeps the initial skill load small. The agent reads reference files only when needed.

### Include Verification Steps

Every skill should tell the agent how to verify its work:

```markdown
## Verification
After completing the audit:
1. Confirm all findings have file paths and line numbers
2. Verify remediation steps are actionable (not just "fix this")
3. Check that severity ratings are consistent
4. Run the scan again to confirm no false negatives from first pass
```

### Provide Scripts When Helpful

For skills that involve running tools, include helper scripts:

```bash
# scripts/dep-scan.sh
#!/bin/bash
echo "=== npm audit ==="
npm audit --json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    vulns = data.get('vulnerabilities', {})
    for name, info in vulns.items():
        sev = info.get('severity', 'unknown')
        print(f'{sev:10s} {name}')
except:
    print('No npm audit data')
"

echo ""
echo "=== pip audit ==="
pip audit --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for vuln in data.get('vulnerabilities', []):
        print(f\"{vuln['id']:15s} {vuln['name']} {vuln['installed_version']}\")
except:
    print('No pip audit data')
"
```

Reference scripts from SKILL.md:

```markdown
## Dependency Scanning
Run the dependency scan script:
\`\`\`bash
bash scripts/dep-scan.sh
\`\`\`
```

## Real-World Skill Examples

### Weather Skill (Simple)

```
skills/weather/
└── SKILL.md
```

```markdown
---
name: weather
description: >
  Get current weather and forecasts via wttr.in or Open-Meteo.
  Use when user asks about weather, temperature, or forecasts.
---

# Weather

## Steps
1. Determine the location (ask if not specified)
2. Fetch weather from wttr.in:
   ```bash
   curl -s "wttr.in/CityName?format=j1"
   ```
3. Report current conditions and forecast

## Notes
- No API key needed
- wttr.in supports city names, airport codes, and coordinates
```

### Code Review Skill (Complex)

```
skills/pr-review/
├── SKILL.md
└── references/
    └── review-checklist.md
```

```markdown
---
name: pr-review
description: >
  Review pull requests for code quality, security issues, and best practices.
  Use when asked to review a PR, check code changes, or audit a diff.
---

# PR Review

## Steps
1. Fetch the PR diff:
   ```bash
   gh pr diff <number>
   ```
2. Read the full diff
3. Check against review-checklist.md
4. Report findings organized by:
   - Critical (security, data loss, breaking changes)
   - Major (logic errors, missing error handling)
   - Minor (style, naming, documentation)
   - Suggestions (improvements, not blocking)

## Rules
- Never approve without reading every changed line
- Security findings are always Critical
- Missing tests for new logic are Major
- Style issues are Minor unless they affect readability
```

## Skill Discovery

OpenClaw scans skill descriptions to match incoming requests. The matching process:

1. User sends a message
2. Agent scans all available skill descriptions
3. If exactly one skill clearly applies, loads its SKILL.md
4. If multiple could apply, picks the most specific one
5. If none apply, proceeds without loading a skill

### Optimizing Discovery

- Use specific, unique trigger phrases in descriptions
- Avoid overlapping descriptions between skills
- Include negative examples ("NOT for: simple one-liner fixes")
- Test by asking your agent tasks that should and shouldn't trigger the skill

## How Skills Are Distributed

The same `SKILL.md` has to work in more than one harness, so I stopped copying skill folders by hand. Two mechanisms now do the distribution.

### Skillet: a plugin of shared skills

[Skillet](../tools/skillet.md) is a public collection of SKILL.md-format skills (the repo audit, planning, review, and handoff skills I use daily). In Claude Code it installs as a plugin, so the skills arrive namespaced (`skillet:line-check`, `skillet:check`) and update when the plugin does:

```
/plugin marketplace add escoffier-labs/skillet
/plugin install skillet@skillet
```

Check what is installed and at what version:

```bash
claude plugin list
```

Expected: a `skillet@skillet` entry with `Status: enabled` (mine reports version 0.6.0 at user scope). For OpenClaw or any other SKILL.md-capable harness, copy the individual skill folder from a clone into that harness's skills directory.

### `brigade skills`: one reviewed registry, many harnesses

For skills I author myself, [Brigade](../tools/brigade.md) keeps a reviewed registry and projects it into each harness's own skills directory, so I edit one source and the copies cannot silently drift. The commands (all present in Brigade 0.28.0, run `brigade skills --help` for the full list):

| Command | What it does |
|---------|--------------|
| `brigade skills search <query>` | Search the local registry |
| `brigade skills lint <skill>` | Lint a registry skill or a skill directory before you trust it |
| `brigade skills install <skill> --target <harness\|all>` | Install one reviewed skill into a harness (`--force` to overwrite) |
| `brigade skills sync --target <harness\|all> [--write]` | Reconcile the registry against installed copies. Without `--write` it only reports |
| `brigade skills fleet status` | Count installed copies as current, stale, missing, unsupported, unknown, or external |
| `brigade skills compatibility <skill>` | Show how a skill maps across harness adapters |
| `brigade skills diff` / `history` / `rollback` | Compare against the bundled template or registry, list install history, restore the last snapshot |
| `brigade skills inbox ...` | Review agent-proposed skill packs (`add`, `list`, `show`, `diff`, `accept`, `reject`) before they enter the registry |
| `brigade skills pack ...` | Build, import, and inspect portable skill packs |

Harness targets come from adapters. `brigade skills adapters list` shows the built-in set (Codex, Claude, OpenCode, Antigravity, Cursor, Copilot, Goose, and others), each with the directory it writes to, such as `.claude/skills/<skill_id>` or `.codex/skills/<skill_id>`.

The review step is the reason I use this instead of a symlink farm. `sync` is a dry run until you add `--write`, `--trust` sets the minimum registry trust level that may be installed, and `inbox` gives agent-proposed skills a human gate. That mirrors OpenClaw's own Skill Workshop queue (see [self-improving agents](self-improving-agents.md)).

### OpenClaw's own skill sources

OpenClaw loads skills from the agent workspace and from bundled and node-provided sources, and its CLI can install more:

```bash
openclaw skills list --agent main      # every skill, with status and source
openclaw skills check --agent main     # ready, visible, disabled, missing requirements
openclaw skills install <skill-ref>    # ClawHub ref, git:<repo>, or a local directory
openclaw skills update                 # update ClawHub-installed skills
```

Bundled skills you will never use should be turned off rather than left in the prompt. Each one is an entry under `skills.entries`:

```json
{
  "skills": {
    "entries": {
      "<bundled-skill-name>": { "enabled": false }
    }
  }
}
```

I disable several dozen bundled skills this way, which keeps the skill list in the system prompt short.

## Managing Skills

### Install a Community Skill

Prefer the installer, which can apply the configured install policy before the skill lands:

```bash
openclaw skills install <skill-ref>
```

or, for a one-off, clone it into the workspace skills directory and read it before you rely on it:

```bash
cd ~/.openclaw/workspace/skills/
git clone https://github.com/someone/cool-skill.git
```

A third-party skill is executable instructions. Read its `SKILL.md` and scripts before enabling it.

### List Your Skills

```bash
ls -d ~/.openclaw/workspace/skills/*/SKILL.md | while read f; do
  DIR=$(dirname "$f")
  NAME=$(basename "$DIR")
  DESC=$(grep -A3 "description:" "$f" | head -4 | tail -3 | tr -d '\n' | sed 's/^[ ]*//')
  printf "%-25s %s\n" "$NAME" "${DESC:0:80}"
done
```

### Audit Skill Quality

For each skill, check:
- Does the description clearly state when to use it?
- Does SKILL.md have concrete steps (not vague guidance)?
- Are reference files used for large context (not stuffed into SKILL.md)?
- Are there verification steps?
- Has it been tested with real requests?

## Verification

Confirm every skill in the workspace is structurally loadable - a `SKILL.md` exists and carries the `description:` field discovery depends on:

```bash
for d in $HOME/.openclaw/workspace/skills/*/; do
  n=$(basename "$d")
  if [ -f "${d}SKILL.md" ] && grep -q "description:" "${d}SKILL.md"; then
    echo "ok      $n"
  else
    echo "MISSING $n"
  fi
done
```

Expected: `ok` for every skill directory. Any `MISSING` line is a skill the agent can never discover.

Then confirm OpenClaw agrees:

```bash
openclaw skills check --agent main
```

Expected: a summary with `Missing requirements: 0` and the eligible count close to the total minus the skills you deliberately disabled.

For distribution, confirm the Skillet plugin is installed and the registry copies are current:

```bash
claude plugin list | grep -A3 skillet
brigade skills fleet status
```

Expected: `skillet@skillet` enabled. `fleet status` prints a count line such as `checked=954 current=944 stale=0 missing=0 unsupported=0 unknown=7 external=3`, then lists each `unknown` or `external` copy. `stale` and `missing` should be 0. Run it from the workspace that owns the registry, because it checks the current directory (elsewhere it reports `checked=0`).

Then test discovery live: send the agent a message containing one of the skill's trigger phrases and confirm it loads that skill (the response should follow the skill's steps, not generic behavior). Follow with a message that should *not* trigger it and confirm it doesn't.

## Gotchas

1. **Skills are loaded on-demand, not preloaded.** The skill list (names and descriptions) is in the system prompt, but SKILL.md content is only loaded when triggered. This means skill descriptions affect prompt cache size, but skill content doesn't.

2. **Don't load more than one skill per request.** If multiple skills could apply, pick the most specific one. Loading multiple skills bloats context unnecessarily.

3. **Relative paths in skills resolve against the skill directory.** If SKILL.md references `references/checklist.md`, the agent should resolve it relative to the skill's parent directory, not the workspace root.

4. **Skills don't persist between sessions.** A skill loaded in one turn isn't automatically loaded in the next. Each request re-evaluates which skill applies.

5. **Large SKILL.md files hurt.** Keep SKILL.md concise (instructions and flow). Move data, checklists, and reference material to `references/` subdirectory. The agent can load those on demand.

6. **Test with edge cases.** A skill that works for the happy path ("run a security audit on this repo") might fail on edge cases ("audit just this one file" or "what security issues should I worry about"). Test both the triggers and the instructions.

7. **`apiKeyRef` is NOT a valid key in `skills.entries`.** Only `auth-profiles.json` entries accept `keyRef`. If a model (or a coder subagent) hallucinates `apiKeyRef` into your skills config, the gateway fails validation on startup with a generic schema error and crash-loops. If skills suddenly broke, diff recent edits to `skills.entries` against the schema before looking elsewhere.

8. **Skill discovery key is the YAML `description` field.** It's what the model sees when deciding whether to load. Vague descriptions = vague triggering. Include explicit trigger phrases, and when a skill is NOT the right choice, say so inline ("NOT for: simple one-liner fixes"). The inline exclusions measurably reduce false-positive loads.
