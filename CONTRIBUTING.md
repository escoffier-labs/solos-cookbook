# Contributing to solostack

solostack is one engineer's opinionated stack. Contributions are welcome but the bar is specific: I have to be able to tell you ran the thing, broke the thing, and fixed the thing.

## What I will merge

- **Corrections.** Typos, broken links, factual errors, outdated commands.
- **Verification reports.** "I followed guide X on platform Y, here's what was different." Open an issue with the diff.
- **New guides** that match the per-guide format (see below) and cover something missing from the index.

## What I will not merge

- Theoretical guides without verification commands.
- Guides that don't include a Gotchas section.
- Anything that adds dependencies beyond plain markdown + the templates already in `templates/`.
- AI-generated boilerplate. If you used an LLM to draft a guide, run it yourself before submitting and document what you actually saw.

## Per-guide format

Every guide in this repo follows the same skeleton:

```markdown
# Guide Title

> One-line hook: what this is, who it's for, what it costs.

## What this is
2-3 sentences. The problem, the shape of the solution.

## Why this way
Tradeoffs vs the obvious alternatives. Why you settled here.

## Prerequisites
- Hardware/OS/services assumed
- Skills assumed (e.g., "comfortable with systemd")

## Before / After
What the system looked like before, what it looks like after.

## Implementation
Step-by-step. Code blocks. Real paths (scrubbed — see hostname rule).

## Verification
Commands the reader runs to confirm it works. Expected output.

## Gotchas
What broke. What surprised you. What docs got wrong.

## Templates
Links into `/templates/<area>/` for drop-in artifacts.

## Related
Cross-links to other solostack guides + external repos.
```

A reference implementation lives at [`automation/cron-patterns.md`](automation/cron-patterns.md). Match that depth.

## Hostname scrub rule

No personal infrastructure names, IPs, or domains in committed text. Use generic terms:

| Don't | Do |
|-------|-----|
| `solo@my-desktop` | `user@desktop` |
| `192.0.2.10` | `192.0.2.10` (RFC 5737 reserved) | <!-- content-guard: allow private-ipv4 -->
| `mybox.local` | `your-host.local` or `the host` |
| Real container names | `the LXC container`, `ct-100` |

Run `git grep` for your hostnames before opening a PR.

## Pre-push hook

This repo ships a tracked pre-push hook at `hooks/pre-push` that runs [content-guard](https://github.com/solomonneas/content-guard) over the working tree against `policies/public-repo.json`. It blocks pushes that contain RFC 1918 IPs, secrets, internal hostnames, etc.

To activate after cloning:

```bash
git config core.hooksPath hooks
```

Bypass only when you understand what you're doing: `git push --no-verify`.

If content-guard isn't on your machine, the hook will tell you where to put it (or override `CONTENT_GUARD_DIR`).

## Gotchas section is mandatory

If you got a guide all the way through and nothing surprised you, you almost certainly skipped something. Re-read the guide as if you'd never seen the system. Anything that requires "oh you also have to ..." is a Gotcha.

## License & attribution

By contributing, you agree your contributions are licensed under MIT (code/templates) and CC BY-NC-ND 4.0 (narrative), matching the repo's dual license. Significant contributions get attribution in the relevant guide's footer.
