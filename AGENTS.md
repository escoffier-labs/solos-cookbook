# Repository Guidance

## Definition of Done
Before reporting any change complete, run from the repo root and confirm it passes:
```bash
./scripts/verify
```
It runs, in order: `npm --prefix site run check:content` (scrub gate),
`npm --prefix site test` (vitest), `npm --prefix site run check` (astro type
check), and `npm --prefix site run build` (full build, prebuild reruns the
scrub gate).

Report actual results. If any command fails, report the failure output verbatim
and do not claim success. Node >= 22.12.0 is required (`site/package.json` engines).

## Hard Prohibitions
- This repo is PUBLIC. Never commit private hostnames, LAN or RFC 1918 IPs,
  real container, VM, or user names, home-network domains, or personal context.
  Use generic stand-ins and RFC 5737 example IPs (table in `CONTRIBUTING.md`).
- Scrub gates are the publishing boundary. If a gate blocks, rewrite the content
  around the trigger words. Never weaken the scrub list, never use `--no-verify`.
- Pushing to `main` publishes the site on Vercel. Push only when the user
  explicitly asks.
- Never weaken, skip, or delete a failing check or test. If blocked, report
  the exact blocker and stop.

## Project Shape
- Public cookbook of markdown guides for running a long-lived agent stack
  (OpenClaw or Hermes as memory owner, Codex CLI / Claude Code / OpenCode as
  writer harnesses). Guides live in category directories at the repo root:
  `ai-stack/`, `automation/`, `infrastructure/`, `security/`, `knowledge/`,
  `hardware/`, `tools/`, `publishing/`, `philosophy/`, `plans/`, `skills/`,
  plus drop-in artifacts in `templates/`.
- `site/` is an Astro 6 site rendering those root directories
  (`site/src/content.config.ts`). Vercel deploys via `vercel.json`
  (`npm --prefix site run build`, output `site/dist`). Old host
  `cookbook.solomonneas.dev` redirects to `escoffierlabs.dev/cookbook`.
- Dual license: MIT for code and templates, CC BY-NC-ND 4.0 for narrative
  content (`LICENSE`, `CONTENT-LICENSE`).

## Guide Rules
- Adding or editing a guide: follow the fixed skeleton in `CONTRIBUTING.md`
  (hook line, What this is, Why this way, Prerequisites, Before/After,
  Implementation, Verification, Gotchas, Templates, Related). Gotchas is
  mandatory. Reference: `automation/cron-patterns.md`.
- Writing guide content: document only what was actually deployed and verified.
  No theoretical guides, no commands you did not run. Every guide needs
  runnable Verification commands with expected output.
- Adding or removing a guide: update the README badge counts (guide count,
  updated date) in the same change.
- Guide content is plain markdown plus existing `templates/` artifacts only.
  Site dependencies are separate and live in `site/package.json`.

## Scrub Gates
- Two layers, keep both passing:
  - `site/scripts/scrub-check.mjs` runs as `prebuild`, so `astro build` fails
    locally and on Vercel on private-looking content. It scans all root guide
    directories plus `README.md` and `CONTRIBUTING.md`.
  - Tracked pre-push hook `hooks/pre-push` runs content-guard from
    `~/repos/content-guard` against its `policies/public-repo.json`. Activate
    once with `git config core.hooksPath hooks`.
- True false positive (example IPs, hostname tables): add inline
  `<!-- content-guard: allow <rule-id> -->` on that line. Prefer rewording.
- Writing about scrubbing triggers the scrubber. Expect allow tags in scrub
  documentation; `CONTRIBUTING.md` itself carries one.

## Structure Gotchas
- Markdown source of truth is the repo root, not `site/src`. Renaming a root
  category directory: update both `CATEGORIES` in `site/src/lib/cookbook.ts` and
  `SCAN_DIRS` in `site/scripts/scrub-check.mjs`, or the loader and gate break.
- Adding redirects: canonical cookbook URLs have no trailing slash. Match the
  existing normalization pattern in `vercel.json`.
- `/memory/` and `.brigade/` are gitignored local brigade state. Never commit
  them or depend on them for repo content.

## Memory Handoff
At the end of any substantial task, write a handoff note to
`.claude/memory-handoffs/` using that directory's `TEMPLATE.md`. Record durable
discoveries, gotchas, and decisions. Do not wait to be reminded.
