# Cookbook Premium Edition v2 (Richness Pass) Implementation Plan

**Goal:** Make the premium PDF read like a real, designed book: add a table of contents, chapter divider pages, a "Start here" orientation, an appendix + glossary, callout styling, a richer cover, and more diagrams. One layered edition (beginner front-to-back, pro jump-to-recipe). No second edition.

**Builds on:** `docs/superpowers/plans/2026-06-11-cookbook-premium-edition.md` (v1). Same branch `cookbook-premium-edition`. Same toolchain: Astro print route `site/src/pages/book/index.astro` + `site/src/styles/print.css` + `pagedjs-cli` (`npm run build && npm run build:pdf`).

**Final book order:** Cover -> Colophon -> Table of Contents -> Start Here -> Chapters (each with a divider page) -> Appendix (templates reference + setup checklist + glossary).

**The only new prose:** the "Start here" section (seed from repo `README.md`) and the glossary. Everything else is design (CSS), structure (the route), and new SVG diagrams.

---

## Task 1: Chapter/guide anchors, divider pages, and the Table of Contents

**Files:** `site/src/pages/book/index.astro`, `site/src/styles/print.css`

The backbone. Give every chapter and guide a stable `id`, render a full-page chapter divider, and build a real TOC with Paged.js page numbers.

- Add a slug-safe `id` to each `<section class="chapter" id={`ch-${chapter.data.category}`}>` and each `<article class="guide" id={`g-${entry.data.category}-${entry.data.slug}`}>`.
- Restructure each chapter so it opens with a `<header class="chapter-divider">` page block containing: a large chapter numeral (use the existing `toRoman(chapter.data.number)` from `site/src/lib/cookbook.ts`, or the arabic number), the chapter title, the chapter intro content, and the hero diagram (if one exists for that category). The divider is its own page (`break-after: page`). Guides then follow, each still starting on its own page.
- Build a `<nav class="toc">` placed after the front matter and before Start Here. It lists each chapter (linked to `#ch-...`) and, indented under it, each guide (linked to `#g-...`). Use `target-counter` for page numbers:
  ```css
  .toc { break-before: page; break-after: page; }
  .toc a { display: flex; justify-content: space-between; text-decoration: none; color: inherit; }
  .toc a::after { content: target-counter(attr(href url), page); color: #888; }
  ```
  (Paged.js resolves `target-counter(attr(href url), page)` to the printed page of the anchor. Verify the exact `attr()` form that works in the installed `pagedjs-cli`; if `attr(href url)` does not resolve, try `target-counter(attr(href), page)`.)
- Style the chapter divider in print.css: big numeral (Fraunces, light color or gold), generous top margin, the title below, intro as lead paragraph, diagram framed. Make it feel like a section opener.

**Verify:** `cd site && npm run build && npm run build:pdf`. Open the PDF: a TOC appears after the colophon with page numbers that match where chapters actually land; each chapter opens on a divider page; the master page count is sane. Report the TOC page range and spot-check 2 chapter page numbers against the TOC.

**Commit:** `feat(book): table of contents and chapter divider pages`

## Task 2: "Start here" orientation section + master diagram

**Files:** new `site/src/components/StartHere.astro`, new `site/src/diagrams/system-overview.svg`, `site/src/pages/book/index.astro`, `site/src/styles/print.css`

- Author `system-overview.svg` (same design system: ink/grey/hairline/panel + gold `#d4a017`, Inter font, ~430pt wide): a single "whole system at a glance" diagram showing the always-on memory owner at the center, the coding harnesses around it, the homelab/infra beneath, and the publishing/automation outputs. This is the orientation visual.
- Write `StartHere.astro`: a 3-5 page orientation. Seed the prose from the repo `README.md` sections ("What this is", "Who this is for", and the memory-owner explanation). Cover: the mental model (one canonical memory owner, many writer harnesses), what the stack is, and HOW TO READ THIS BOOK (new readers go front-to-back; experienced readers jump to any recipe via the TOC). Embed `system-overview.svg` near the top. Keep prose plain, no em dashes, no real hostnames/IPs.
- Mount `<StartHere />` in the book route AFTER the TOC and BEFORE the chapters loop.
- Style `.start-here` in print.css (lead paragraph treatment, the diagram framed, starts on its own page).

**Verify:** rebuild PDF; Start Here renders after the TOC, before chapter 1, with the overview diagram. `node site/scripts/scrub-check.mjs` clean (the route content is checked at site build via prebuild anyway). Report the pages it occupies.

**Commit:** `feat(book): start-here orientation section and system overview diagram`

## Task 3: Appendix (templates reference + setup checklist + glossary)

**Files:** new `site/src/components/Appendix.astro`, new `site/src/content/glossary.md` (or inline in the component), `site/src/pages/book/index.astro`, `site/src/styles/print.css`

- The Astro site already defines an `appendix` collection loading `templates/README.md`. Render it as the first appendix section.
- Add the setup checklist: read `templates/SETUP-CHECKLIST.md` content into the appendix (import via `?raw` and render, or add it to the appendix collection). It should appear as a clean reference page.
- Write a glossary: ~12-20 terms a newcomer needs (agent, harness, orchestrator, MCP, memory owner, handoff, bootstrap file, memory card, cron, self-hosted, homelab, etc.). Keep definitions one to two sentences, plain language, no em dashes. Author as `site/src/content/glossary.md` or inline in `Appendix.astro`.
- Build `Appendix.astro` to render: an "Appendix A: Templates reference", "Appendix B: Setup checklist", "Appendix C: Glossary", each starting on its own page with a styled appendix header.
- Mount `<Appendix />` AFTER the chapters loop (back matter).
- Add the appendix entries to the TOC from Task 1 (a "Appendix" group with its three sub-entries linked + page numbers).
- Style `.appendix` in print.css.

**Verify:** rebuild PDF; appendix appears at the end with the three sections, each paginated; TOC lists them with correct page numbers. Report the appendix page range.

**Commit:** `feat(book): appendix with templates reference, setup checklist, and glossary`

## Task 4: Design-richness pass (cover mark, callouts, two more diagrams, polish)

**Files:** `site/src/components/BookCover.astro`, `site/src/styles/print.css`, new `site/src/diagrams/automation-flow.svg`, new `site/src/diagrams/publishing-pipeline.svg`, `site/src/pages/book/index.astro`

Invoke the `frontend-design` skill. This is the "worth $39" visual pass.

- **Cover mark:** add a clean vector lobster mark in gold `#d4a017` to `BookCover.astro` (simple, elegant line/silhouette mark, NOT an emoji), plus a thin gold rule under the kicker. Improve vertical balance so the cover does not read as sparse.
- **Callout styling:** style markdown blockquotes and the guide meta (`Tested on:` / `Last updated:` lines) as intentional callout boxes with the gold accent and panel fills (`#f6f6f4`). The cookbook's "here is what broke" voice should look deliberate. If the guides express these as blockquotes or bold lines, target those; do not change the markdown source, only the print CSS.
- **Two more diagrams** (same design system): `automation-flow.svg` (cron jobs -> tasks -> outputs/notifications) for the `automation` chapter, and `publishing-pipeline.svg` (draft -> scrub -> schedule -> platforms) for the `publishing` chapter. Wire them into the `CHAPTER_DIAGRAMS` map so they render on those chapters' divider pages.
- **Polish:** tighten spacing, ensure code blocks never overflow the 6x9 trim, confirm chapter dividers and callouts have consistent rhythm.
- Run the scrub check and a forbidden-string grep on the new SVGs (no real hostnames, no private IPs; RFC 5737 only if any IP is shown).

**Verify:** rebuild PDF; cover has the mark, callouts look intentional, the two new chapter diagrams appear, no code overflow. Scrub-check clean.

**Commit:** `feat(book): cover mark, callout styling, and two more chapter diagrams`

## Task 5: Final verification

- `cd site && npm run build && npm run check` (0 errors) and `npx vitest run` (green).
- `node ../scripts/build-bundle.mjs` still works (bundle unaffected, but confirm).
- Rebuild the PDF; controller does a visual QA pass on rendered pages (cover, TOC, Start Here, a chapter divider, a callout page, the appendix/glossary).
- Confirm no real hostnames/IPs anywhere (`node site/scripts/scrub-check.mjs`).
- Update `docs/superpowers/plans/...` checkboxes; note final page count.
