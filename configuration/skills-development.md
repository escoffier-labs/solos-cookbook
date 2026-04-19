# Skills Development

How to write custom OpenClaw skills, structure them for discoverability, and extend your agent's capabilities with reusable task-specific instructions.

**Tested on:** OpenClaw 2026.4.x with 20+ custom skills across security, content, and development
**Last updated:** 2026-04-19

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

Browse community skills at [ClawHub](https://clawhub.ai) or find them on GitHub.

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

## Managing Skills

### Install a Community Skill

```bash
# Clone or download to your skills directory
cd ~/.openclaw/workspace/skills/
git clone https://github.com/someone/cool-skill.git
```

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

## Gotchas

1. **Skills are loaded on-demand, not preloaded.** The skill list (names and descriptions) is in the system prompt, but SKILL.md content is only loaded when triggered. This means skill descriptions affect prompt cache size, but skill content doesn't.

2. **Don't load more than one skill per request.** If multiple skills could apply, pick the most specific one. Loading multiple skills bloats context unnecessarily.

3. **Relative paths in skills resolve against the skill directory.** If SKILL.md references `references/checklist.md`, the agent should resolve it relative to the skill's parent directory, not the workspace root.

4. **Skills don't persist between sessions.** A skill loaded in one turn isn't automatically loaded in the next. Each request re-evaluates which skill applies.

5. **Large SKILL.md files hurt.** Keep SKILL.md concise (instructions and flow). Move data, checklists, and reference material to `references/` subdirectory. The agent can load those on demand.

6. **Test with edge cases.** A skill that works for the happy path ("run a security audit on this repo") might fail on edge cases ("audit just this one file" or "what security issues should I worry about"). Test both the triggers and the instructions.

7. **`apiKeyRef` is NOT a valid key in `skills.entries`.** Only `auth-profiles.json` entries accept `keyRef`. If a model (or a coder subagent) hallucinates `apiKeyRef` into your skills config, the gateway fails validation on startup with a generic schema error and crash-loops. If skills suddenly broke, diff recent edits to `skills.entries` against the schema before looking elsewhere.

8. **Skill discovery key is the YAML `description` field.** It's what the model sees when deciding whether to load. Vague descriptions = vague triggering. Include explicit trigger phrases, and when a skill is NOT the right choice, say so inline ("NOT for: simple one-liner fixes"). The inline exclusions measurably reduce false-positive loads.
