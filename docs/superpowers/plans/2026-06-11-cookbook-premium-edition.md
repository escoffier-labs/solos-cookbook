# Cookbook Premium Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the free `solos-cookbook` (already live at escoffierlabs.dev/cookbook) into a gorgeous, premium, paid PDF edition plus a runnable "kitchen" bundle, sold one-time through Lemon Squeezy, without removing anything from the free site.

**Architecture:** Reuse the existing Astro content layer. A new static print route (`/book`) renders every chapter and guide, in canonical order, into one long semantic HTML document styled by a dedicated print stylesheet. `pagedjs-cli` paginates that HTML headlessly into a book-quality PDF (cover, TOC, running headers, page numbers, chapter breaks). Hero diagrams are hand-authored SVGs embedded at chapter openings. A separate build script zips the `templates/` tree plus a generated setup checklist into the bundle. Lemon Squeezy hosts the product and delivers both files. A buy section is added to the cookbook landing page. The free site is untouched.

**Tech Stack:** Astro 6.4 + Tailwind 4 (existing site), `pagedjs-cli` (PDF pagination), Node build scripts (ESM `.mjs`), Vitest (existing test runner), Creem (merchant-of-record checkout; Solomon has discounted access via shipper.club). Creem is rail-agnostic in this plan: swap for Lemon Squeezy/Polar by changing only the product URL and the Task 9 dashboard steps.

**Repo:** `~/repos/solos-cookbook`. All paths below are relative to that repo root unless noted. The Astro app lives in `site/`.

**Out of scope for v1 (recorded, do not build now):** EPUB edition (Task 10, deferred/optional), the enterprise/team edition, license-key gating (the PDF is ungated; Lemon Squeezy delivers the file on purchase).

---

## File structure

Created:
- `site/src/pages/book/index.astro` - the single-document print route (all chapters + guides in order).
- `site/src/styles/print.css` - `@page` rules, running headers, page numbers, chapter breaks, code/diagram print styling.
- `site/src/components/BookCover.astro` - title page + colophon/license front matter.
- `site/src/diagrams/*.svg` - hero diagrams (4 for v1).
- `site/scripts/build-pdf.mjs` - build site, run `pagedjs-cli` over `dist/book/index.html`, output `dist-book/cookbook.pdf`.
- `site/scripts/build-pdf.test.mjs` (or vitest spec) - structural assertions on the `/book` route.
- `scripts/build-bundle.mjs` - zip `templates/` + generated checklist into `dist-book/cookbook-kitchen-bundle.zip`.
- `scripts/build-bundle.test.mjs` - assert the zip contains expected entries.
- `templates/SETUP-CHECKLIST.md` - one-page "empty machine -> running stack" checklist (bundle front matter).
- `publishing/creem-product.md` - product copy, pricing, delivery config, and the Solomon-only account checklist.

Modified:
- `site/package.json` - add `pagedjs-cli` dev dep and `build:pdf` / `build:bundle` scripts.
- `site/src/pages/index.astro` - add the buy section (or a dedicated `/premium` page if the landing page is crowded; decide in Task 8).
- `README.md` - add a short "Premium edition" callout linking to the buy page.

---

## Task 1: Print route that renders the whole book in order

**Files:**
- Create: `site/src/pages/book/index.astro`
- Create: `site/src/styles/print.css` (minimal stub now; filled in Task 3)

- [ ] **Step 1: Create the print route**

This route imports all three collections, orders chapters by `number`, orders
guides within a chapter by `chapterNumber` then `slug` (matching the existing
guide route), and renders each guide's `<Content />` inline. No site nav, no
footer; this document becomes the PDF.

```astro
---
// site/src/pages/book/index.astro
import { getCollection, render } from 'astro:content';
import { CATEGORIES } from '../../lib/cookbook.ts';
import '../../styles/print.css';

const chapters = await getCollection('chapters');
const guides = await getCollection('guides');

const orderedChapters = [...chapters].sort((a, b) => a.data.number - b.data.number);

function guidesForChapter(category: string) {
  return [...guides]
    .filter((g) => g.data.category === category)
    .sort((a, b) => a.data.chapterNumber - b.data.chapterNumber || a.data.slug.localeCompare(b.data.slug));
}

// Pre-render every chapter intro + its guides.
const rendered = [];
for (const chapter of orderedChapters) {
  const chapterBody = await render(chapter);
  const chapterGuides = [];
  for (const g of guidesForChapter(chapter.data.category)) {
    chapterGuides.push({ entry: g, comp: await render(g) });
  }
  rendered.push({ chapter, chapterComp: chapterBody, guides: chapterGuides });
}
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Solomon's Guide to Cookin' with Gas</title>
  </head>
  <body>
    {rendered.map(({ chapter, chapterComp, guides }) => (
      <section class="chapter" data-chapter={chapter.data.title}>
        <h1 class="chapter-title">{chapter.data.title}</h1>
        <chapterComp.Content />
        {guides.map(({ entry, comp }) => (
          <article class="guide" data-guide={entry.data.title}>
            <h2 class="guide-title">{entry.data.title}</h2>
            <comp.Content />
          </article>
        ))}
      </section>
    ))}
  </body>
</html>
```

- [ ] **Step 2: Create a minimal print stylesheet stub**

```css
/* site/src/styles/print.css - filled out in Task 3 */
.chapter { break-before: page; }
.guide { break-before: page; }
```

- [ ] **Step 3: Build and verify the route exists with all content**

Run:
```bash
cd site && npm run build && ls dist/book/index.html
```
Expected: `dist/book/index.html` exists. Open it and confirm chapters render in
order with guides under each.

- [ ] **Step 4: Commit**

```bash
git add site/src/pages/book/index.astro site/src/styles/print.css
git commit -m "feat(book): single-document print route for the PDF edition"
```

## Task 2: Structural test for the print route

**Files:**
- Create: `site/scripts/book-structure.test.mjs`

- [ ] **Step 1: Write the failing test**

The test builds (or reads the already-built `dist/book/index.html`) and asserts
every guide and chapter title from the markdown appears in the rendered book.
This catches a guide silently dropping out of the PDF.

```js
// site/scripts/book-structure.test.mjs
import { test, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES } from '../src/lib/cookbook.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
let html = '';

beforeAll(async () => {
  html = await readFile(path.join(import.meta.dirname, '../dist/book/index.html'), 'utf-8');
});

test('book contains every guide markdown file as an article', async () => {
  let expected = 0;
  for (const { dir } of CATEGORIES) {
    if (dir === 'skills') continue; // skills load from subdirs; covered separately
    const files = await readdir(path.join(REPO_ROOT, dir)).catch(() => []);
    expected += files.filter((f) => f.endsWith('.md') && f !== 'README.md').length;
  }
  const articles = (html.match(/class="guide"/g) || []).length;
  expect(articles).toBeGreaterThanOrEqual(expected);
});

test('book renders all chapters', () => {
  const sections = (html.match(/class="chapter"/g) || []).length;
  expect(sections).toBe(CATEGORIES.length);
});
```

- [ ] **Step 2: Run it; it must build first**

Run:
```bash
cd site && npm run build && npx vitest run scripts/book-structure.test.mjs
```
Expected: PASS. If a guide count mismatches, fix the route in Task 1 before moving on.

- [ ] **Step 3: Commit**

```bash
git add site/scripts/book-structure.test.mjs
git commit -m "test(book): assert every guide and chapter lands in the print route"
```

## Task 3: Premium print styling (the "clean as fuck" pass)

**Files:**
- Modify: `site/src/styles/print.css`

This is the design centerpiece. Use the site's existing fonts (Fraunces for
display, Inter for body, JetBrains Mono for code) for visual continuity with the
free site. The goal is book-grade typography, not a webpage dumped to paper.

- [ ] **Step 1: Write the full print stylesheet**

```css
/* site/src/styles/print.css */
@import '@fontsource-variable/fraunces';
@import '@fontsource/inter';
@import '@fontsource-variable/jetbrains-mono';

@page {
  size: 6in 9in;            /* trade-book trim */
  margin: 0.75in 0.7in 0.85in;
  @bottom-center { content: counter(page); font-family: 'Inter'; font-size: 9pt; color: #555; }
  @top-center { content: string(chaptertitle); font-family: 'Inter'; font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
}
@page :first { @top-center { content: none; } @bottom-center { content: none; } }

html { font-family: 'Inter', system-ui, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; }
body { margin: 0; }

.chapter { break-before: page; }
.chapter-title {
  string-set: chaptertitle content();
  font-family: 'Fraunces Variable', serif;
  font-size: 30pt; font-weight: 600; line-height: 1.1;
  margin: 1.2in 0 0.4in; break-after: avoid;
}
.guide { break-before: page; }
.guide-title { font-family: 'Fraunces Variable', serif; font-size: 18pt; font-weight: 600; margin: 0 0 0.25in; break-after: avoid; }

h3, h4 { font-family: 'Inter'; font-weight: 700; break-after: avoid; }
p, li { orphans: 3; widows: 3; }

pre {
  font-family: 'JetBrains Mono Variable', monospace; font-size: 8.5pt;
  background: #f6f6f4; border: 1px solid #e5e5e0; border-radius: 4px;
  padding: 8pt 10pt; white-space: pre-wrap; word-break: break-word; break-inside: avoid;
}
code { font-family: 'JetBrains Mono Variable', monospace; font-size: 9pt; }
a { color: inherit; text-decoration: none; }
img, svg { max-width: 100%; break-inside: avoid; }
blockquote { border-left: 3px solid #d4a017; margin: 0 0 0 0.1in; padding-left: 0.2in; color: #444; font-style: italic; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; break-inside: avoid; }
th, td { border: 1px solid #ddd; padding: 4pt 6pt; text-align: left; }
```

- [ ] **Step 2: Rebuild and eyeball**

Run:
```bash
cd site && npm run build
```
Open `dist/book/index.html` in a browser's print preview (Ctrl+P) to sanity-check
typography. Final pagination is verified in Task 4 (Paged.js differs slightly from browser print).

- [ ] **Step 3: Commit**

```bash
git add site/src/styles/print.css
git commit -m "style(book): book-grade print typography (Fraunces/Inter/JetBrains)"
```

## Task 4: PDF build script with pagedjs-cli

**Files:**
- Modify: `site/package.json` (add dep + script)
- Create: `site/scripts/build-pdf.mjs`

- [ ] **Step 1: Add pagedjs-cli and scripts**

Run:
```bash
cd site && npm install -D pagedjs-cli
```
Then add to `site/package.json` `scripts`:
```json
"build:pdf": "node scripts/build-pdf.mjs"
```

- [ ] **Step 2: Write the build script**

```js
// site/scripts/build-pdf.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const SITE = path.resolve(import.meta.dirname, '..');
const input = path.join(SITE, 'dist', 'book', 'index.html');
const outDir = path.join(SITE, '..', 'dist-book');
const output = path.join(outDir, 'cookbook.pdf');

if (!existsSync(input)) {
  console.error('Build the site first: npm run build'); process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// pagedjs-cli applies Paged.js headlessly and writes a paginated PDF.
execFileSync('npx', ['pagedjs-cli', input, '-o', output], { cwd: SITE, stdio: 'inherit' });
console.log('PDF written:', output);
```

- [ ] **Step 3: Build the site, then the PDF**

Run:
```bash
cd site && npm run build && npm run build:pdf
ls -la ../dist-book/cookbook.pdf
```
Expected: `dist-book/cookbook.pdf` exists and is non-trivial in size.

- [ ] **Step 4: Verify page count and structure**

Run (pdfinfo from poppler-utils; install with `sudo apt install -y poppler-utils` if missing):
```bash
pdfinfo ../dist-book/cookbook.pdf | grep Pages
```
Expected: Pages is a sensible book length (dozens to low hundreds). Open the PDF
and confirm: chapters start on new pages, running headers show the chapter
title, page numbers render, code blocks do not overflow the trim.

- [ ] **Step 5: Add dist-book to gitignore and commit**

```bash
grep -qxF 'dist-book/' ../.gitignore || echo 'dist-book/' >> ../.gitignore
git add site/package.json site/package-lock.json site/scripts/build-pdf.mjs ../.gitignore
git commit -m "feat(book): pagedjs-cli PDF build pipeline"
```

## Task 5: Cover, title page, and front matter

**Files:**
- Create: `site/src/components/BookCover.astro`
- Modify: `site/src/pages/book/index.astro` (mount the cover before chapters)
- Modify: `site/src/styles/print.css` (cover styles)

- [ ] **Step 1: Build the cover component**

Front matter pages: (1) full-bleed title page with the book title, subtitle, the
lobster mark, and "Premium Edition / <date>"; (2) colophon with copyright, the
"this is the paid edition of the free cookbook at escoffierlabs.dev/cookbook"
line, and the CC-BY-NC-ND-does-not-apply-to-this-edition notice (this edition is
all-rights-reserved; the free site stays CC-licensed).

```astro
---
// site/src/components/BookCover.astro
const today = new Date().toISOString().slice(0, 10);
---
<section class="cover">
  <p class="cover-kicker">Escoffier Labs</p>
  <h1 class="cover-title">Solomon's Guide to<br/>Cookin' with Gas</h1>
  <p class="cover-sub">How one engineer runs a 24/7 multi-agent AI stack on bare metal.</p>
  <p class="cover-edition">Premium Edition - {today}</p>
</section>
<section class="colophon">
  <p>Copyright (c) 2026 Solomon Neas. All rights reserved.</p>
  <p>This Premium Edition is a typeset compilation of the cookbook published free
     at <strong>escoffierlabs.dev/cookbook</strong>. The free web edition is
     licensed CC BY-NC-ND 4.0; this compiled edition is not. Please do not
     redistribute it.</p>
  <p>Tools referenced here are open source under their own licenses (see the
     repository at github.com/escoffier-labs/solos-cookbook).</p>
</section>
```

- [ ] **Step 2: Mount the cover at the top of the book body**

In `site/src/pages/book/index.astro`, import and place `<BookCover />` as the
first child of `<body>`, before the chapters `map`.

```astro
import BookCover from '../../components/BookCover.astro';
// ...
<body>
  <BookCover />
  {rendered.map(/* ... unchanged ... */)}
</body>
```

- [ ] **Step 3: Add cover styles to print.css**

```css
.cover { break-after: page; height: 8in; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover-kicker { font-family: 'Inter'; text-transform: uppercase; letter-spacing: 0.2em; font-size: 9pt; color: #d4a017; }
.cover-title { font-family: 'Fraunces Variable', serif; font-size: 40pt; font-weight: 600; line-height: 1.05; margin: 0.3in 0; }
.cover-sub { font-size: 12pt; color: #444; max-width: 4in; margin: 0 auto; }
.cover-edition { margin-top: 0.6in; font-family: 'Inter'; font-size: 10pt; color: #888; }
.colophon { break-after: page; font-size: 9pt; color: #555; padding-top: 2in; }
```

- [ ] **Step 4: Rebuild PDF and verify front matter**

Run:
```bash
cd site && npm run build && npm run build:pdf
```
Open the PDF: page 1 is the title page (no header/number), page 2 the colophon,
chapters follow. Confirm with `pdfinfo`.

- [ ] **Step 5: Commit**

```bash
git add site/src/components/BookCover.astro site/src/pages/book/index.astro site/src/styles/print.css
git commit -m "feat(book): cover, title page, and colophon front matter"
```

## Task 6: Four hero diagrams

**Files:**
- Create: `site/src/diagrams/memory-ownership.svg`
- Create: `site/src/diagrams/multi-harness-handoff.svg`
- Create: `site/src/diagrams/stack-topology.svg`
- Create: `site/src/diagrams/security-tiers.svg`
- Modify: the four chapter `README.md` files to embed each diagram, OR embed via the print route at chapter open (decide in Step 1)

This is creative work; use the `frontend-design` skill for visual quality. Keep
diagrams monochrome-plus-one-accent (the cookbook gold `#d4a017`) so they print
clean and match the cover. Hand-author SVG or use the Excalidraw MCP and export
to SVG, then optimize.

- [ ] **Step 1: Decide embed mechanism**

Preferred: embed at chapter open in the print route only (keeps the free site
markdown clean and avoids changing 60 published files). In `book/index.astro`,
map a `category -> diagram import` table and render the SVG right after
`<h1 class="chapter-title">`. This keeps diagrams exclusive to the paid PDF,
which adds to the premium hook.

- [ ] **Step 2: Author the four diagrams**

Exact subjects (one per major chapter):
  1. `memory-ownership.svg` (ai-stack): one canonical memory owner, many coding
     harnesses writing back. Boxes: OpenClaw/Hermes (owner) <- Codex CLI / Claude
     Code / OpenCode (writers); arrows = handoffs into MEMORY.md/cards.
  2. `multi-harness-handoff.svg` (knowledge): the handoff lifecycle - session
     discovers knowledge -> writes handoff -> ingester -> cards + MEMORY.md.
  3. `stack-topology.svg` (infrastructure): bare-metal host + homelab; gateway,
     local APIs, NAS, Proxmox/Hyper-V, mounts. No real hostnames or IPs (use
     generic labels; see scrub rules).
  4. `security-tiers.svg` (security): read / safe-write / destructive tool tiers
     and the gating between them (the MCP write-gating story).

- [ ] **Step 3: Embed and render**

Wire the diagram table in `book/index.astro`, rebuild, regenerate the PDF, and
confirm each diagram prints sharp (SVG is vector; should be crisp) and fits the trim.

```bash
cd site && npm run build && npm run build:pdf
```

- [ ] **Step 4: Scrub check the diagrams**

The diagrams contain infra detail. Run the existing scrub check and a visual pass
for hostnames/IPs (Solomon's rule: no real hostnames, RFC 5737 IPs only).
```bash
cd site && node scripts/scrub-check.mjs
```
Expected: pass. Manually confirm no real workstation or server names, and no
RFC 1918 IPs are baked into the SVGs.

- [ ] **Step 5: Commit**

```bash
git add site/src/diagrams site/src/pages/book/index.astro
git commit -m "feat(book): four hero diagrams embedded at chapter openings"
```

## Task 7: The runnable "kitchen" bundle

**Files:**
- Create: `templates/SETUP-CHECKLIST.md`
- Create: `scripts/build-bundle.mjs`
- Create: `scripts/build-bundle.test.mjs`

- [ ] **Step 1: Write the setup checklist**

A one-page "empty machine -> running stack" checklist that orders the templates:
host prep -> bootstrap files -> hooks -> cron -> security scrubbers -> n8n. Keep
it terse and link each step to the matching guide slug on the free site. No
secrets, no real hostnames.

- [ ] **Step 2: Write the bundle build script**

```js
// scripts/build-bundle.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const outDir = path.join(ROOT, 'dist-book');
const output = path.join(outDir, 'cookbook-kitchen-bundle.zip');
mkdirSync(outDir, { recursive: true });

// Zip the templates tree + the checklist. -x excludes any stray node_modules.
execFileSync('zip', ['-r', output, 'templates', '-x', '*/node_modules/*'], { cwd: ROOT, stdio: 'inherit' });
console.log('Bundle written:', output);
```

- [ ] **Step 3: Write the failing test**

```js
// scripts/build-bundle.test.mjs
import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const zip = path.join(ROOT, 'dist-book', 'cookbook-kitchen-bundle.zip');

test('bundle contains the setup checklist and template dirs', () => {
  const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf-8' });
  expect(list).toContain('templates/SETUP-CHECKLIST.md');
  expect(list).toContain('templates/bootstrap/');
  expect(list).toContain('templates/hooks/');
  expect(list).not.toMatch(/node_modules/);
});
```

- [ ] **Step 4: Build the bundle, then run the test**

Run (vitest here is the repo-root runner; if none exists, run the assertions via `node --test` instead - confirm which the repo uses):
```bash
node scripts/build-bundle.mjs && npx vitest run scripts/build-bundle.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/SETUP-CHECKLIST.md scripts/build-bundle.mjs scripts/build-bundle.test.mjs
git commit -m "feat(bundle): runnable kitchen bundle build + structural test"
```

## Task 8: Buy section on the cookbook landing page

**Files:**
- Modify: `site/src/pages/index.astro` (add a "Premium edition" section)
- Modify: `README.md` (short callout)

- [ ] **Step 1: Add the buy section to index.astro**

Add a visually strong section near the top of the landing page: a few of the
hero diagrams as the visual proof, a 3-bullet value list (typeset PDF + EPUB
later, exclusive diagrams, runnable bundle), the price, and a single primary
button linking to the Creem product URL. Use a placeholder
`https://CREEM_PRODUCT_URL` constant until Task 9 produces the real URL,
then replace it.

Match the existing site components and Tailwind tokens (reuse `RecipeCard`-style
framing). Keep copy honest: "All recipes are free to read. This is the typeset,
designed edition with exclusive diagrams and the whole kitchen as a runnable
bundle."

- [ ] **Step 2: Add a README callout**

One short paragraph under the existing Brigade callout linking to the buy page.
Keep the free-first framing.

- [ ] **Step 3: Build and verify**

Run:
```bash
cd site && npm run build && npm run check
```
Expected: build passes, section renders on the index page, button href is the
(placeholder for now) product URL.

- [ ] **Step 4: Plate the new marketing copy**

The buy section and README callout are public prose. Run them through the
content rules before they ship (no em dashes, no real hostnames). Use
skillet:plate or at minimum:
```bash
cd site && node scripts/scrub-check.mjs
```

- [ ] **Step 5: Commit**

```bash
git add site/src/pages/index.astro README.md
git commit -m "feat(site): premium edition buy section and README callout"
```

## Task 9: Creem product (Solomon-driven, with prepped assets)

**Files:**
- Create: `publishing/creem-product.md` (the copy + checklist; the actual setup happens in the Creem dashboard)

Account creation, store setup, tax/payout details, and connecting a bank are
Solomon-only actions (credentials). The agent prepares everything that can be
prepared and hands off a tight checklist. Creem is the chosen rail (discounted
access via shipper.club); the steps below are rail-agnostic enough to apply to
Lemon Squeezy/Polar if Solomon switches.

- [ ] **Step 1: Write the product page copy and config doc**

`publishing/creem-product.md` contains: product name, the ~$39 price, the
product description (reuse the buy-section copy), the two delivery files
(`cookbook.pdf`, `cookbook-kitchen-bundle.zip`), the thank-you text, and the
refund policy line. Include the exact "free updates" promise wording.

- [ ] **Step 2: Solomon - create the store and product**

Checklist (Solomon does these in the Creem dashboard):
  - [ ] Create/confirm Creem account, apply the shipper.club discount, set store name "Escoffier Labs".
  - [ ] Complete tax/payout onboarding (merchant-of-record handles VAT/sales-tax remittance). Note the non-EU payout fee ($7 or 1%); batch payouts monthly.
  - [ ] New digital product, paste copy from `publishing/creem-product.md`.
  - [ ] Upload `dist-book/cookbook.pdf` and `dist-book/cookbook-kitchen-bundle.zip` as the delivered files.
  - [ ] Set price $39 (one-time), enable the hosted checkout. License keys not needed (files are ungated).
  - [ ] Publish, copy the product/checkout URL.

- [ ] **Step 3: Wire the real URL into the site**

Replace `https://CREEM_PRODUCT_URL` in `site/src/pages/index.astro` and the
README with the published URL.

```bash
cd site && npm run build && npm run check
```

- [ ] **Step 4: End-to-end test purchase**

Solomon runs Creem's test mode (or a real $39 purchase he refunds) and confirms
both files download. This is the only true "does it work" test for the checkout.

- [ ] **Step 5: Commit**

```bash
git add publishing/creem-product.md site/src/pages/index.astro README.md
git commit -m "feat(launch): Creem product copy and live checkout URL"
```

## Task 10 (deferred / optional): EPUB edition

Not required for launch. When wanted: generate an EPUB from the same per-guide
markdown with `pandoc` (one combined markdown -> `pandoc -o cookbook.epub` with a
metadata block and the cover image), add it as a third delivery file on the
Lemon Squeezy product, and update the buy-section copy to mention EPUB. EPUB has
far less design control than the PDF, so the PDF remains the flagship artifact.

---

## Launch gate (run before announcing)

- [ ] `cd site && npm run build && npm run build:pdf && npm run check` all green.
- [ ] `node scripts/build-bundle.mjs` produces the zip; bundle test passes.
- [ ] Open the final PDF end to end: cover, colophon, running headers, page
      numbers, all chapters, all four diagrams, no overflowing code blocks, no
      real hostnames/IPs anywhere. (A clickable TOC page is a nice-to-have, not a
      launch blocker; the PDF outline from headings suffices for v1.)
- [ ] Test purchase delivers both files.
- [ ] Publish-readiness pass on the buy copy and README (skillet:publish-readiness).
- [ ] First distribution action queued (Iron 4): a writeup or post that ends in
      the buy link. Building the product is not done until it has a way to be found.
