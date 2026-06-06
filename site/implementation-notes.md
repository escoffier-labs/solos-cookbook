# cookbook.solomonneas.dev - implementation notes

Decisions and deviations made while building the site, beyond what the plan specified.

## Architecture decisions

- **Link rewriting at parse time, not rehype.** The plan called for a rehype plugin keyed off the VFile source path. Loader-rendered entries (`renderMarkdown`) don't reliably expose a source path to rehype, so links are rewritten on the raw markdown in `rewriteMdLinks()` (fence-aware, line-based) before the loader stores the body. Pure function, fully unit-tested, zero plumbing risk.
- **Custom content-layer loaders** (`cookbook-guides`, `cookbook-chapters`, `cookbook-appendix`) read `../<category>/*.md` directly. Frontmatter is derived: title from H1 (preferred over SKILL.md `name`, which is a slug), description from the first prose block (paragraph or blockquote), `testedOn`/`lastUpdated` from the `**...**` convention lines. Those metadata lines plus the trailing `---` separator are stripped from the rendered body; the layout renders them as the styled "recipe yield" block instead.
- **templates/ is an appendix, not a chapter.** Its README renders at `/templates`; deep links into `templates/**` go to GitHub blob URLs since the artifacts aren't rendered on-site.
- **Chapter display names mirror the category README H1s** (e.g. "AI agent stack", "Self-hosted infrastructure") so guide kickers and chapter tiles agree. If a README H1 changes, update `CATEGORIES` in `src/lib/cookbook.ts`.
- **plans/ has no README.** The chapters loader synthesizes an empty chapter rather than failing.

## Dependency pins

- **`overrides.vite: ^7.3.2` in package.json is required.** vitest 4.x allows vite 8; npm hoists it, and `@tailwindcss/vite` 4.3.0 crashes against vite 8's rolldown resolve plugin ("Missing field `tsconfigPaths`"). Astro itself wants `vite@^7.3.2`. Remove the override only after tailwind's vite plugin supports vite 8.
- **astro pinned exact at 6.4.2** (brigade-site's known-good version at the time of writing). Bump deliberately, with a build check.

## Scrub gate

- `scripts/scrub-check.mjs` runs as `prebuild` and scans the published content surface (all category dirs + templates + root README/CONTRIBUTING). Rules: private hostnames, RFC 1918 IPs (RFC 5737 doc ranges allowed), API-key shapes, emails (example/noreply allowed), credential material.
- The `credential` rule skips placeholder values (`REDACTED`, `your...`, `<...>`, `$VAR`, backtick, etc.) because the infrastructure guides deliberately teach with `password=yourpassword` style examples.
- Honors the repo's existing inline escape hatch: `<!-- content-guard: allow <rule-id> -->` on the offending line or the line above. Rule id `private-ipv4` matches the tag already present in CONTRIBUTING.md.

## Verification status (2026-06-05)

- 27/27 vitest unit tests green, `astro check` 0 errors, `npm run build` 73 pages.
- dist/ greps clean: no surviving internal `.md` hrefs, no private hostnames, no RFC 1918 IPs; every internal href maps to a built page.
- Visual spot-checks (dark + light): homepage chapter grid, guide page with meta block + mise-en-place TOC, skill page.

## Deploy (manual, one-time)

- Vercel project with **Root Directory = `site`**, same account as brigade-site.
- Add domain `cookbook.solomonneas.dev` (CNAME to Vercel per project settings).
- The Vercel Analytics 404 in local preview is expected; it resolves on the Vercel deployment.
