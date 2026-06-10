#!/usr/bin/env node
/**
 * Link check for the published content surface.
 *
 * Default mode checks internal (relative) markdown links only and is
 * build-blocking: every link must resolve to a real file or directory in
 * the repo. External URLs are skipped by default so flaky third-party
 * sites can never break the gate.
 *
 * `--external` probes unique http(s) URLs as well. Run it in a
 * non-blocking CI lane (continue-on-error / scheduled job), never in the
 * blocking verify path.
 *
 * Usage:
 *   node scripts/link-check.mjs              # internal links, blocking
 *   node scripts/link-check.mjs --external   # external probe, for CI lanes
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Same surface the scrub gate covers: everything the site renders or links into.
const SCAN_DIRS = [
  'ai-stack', 'automation', 'infrastructure', 'security', 'knowledge',
  'hardware', 'tools', 'publishing', 'philosophy', 'plans', 'skills', 'templates',
];
const SCAN_ROOT_FILES = ['README.md', 'CONTRIBUTING.md'];

// Files whose relative links are intentional placeholders for a deployed
// workspace, not paths in this repo.
const INTERNAL_EXEMPT = new Set([
  'templates/bootstrap/MEMORY.md',
]);

// External URLs known to reject anonymous probes (auth walls, bot
// detection) but verified by hand. Substring match against the URL.
const EXTERNAL_ALLOWLIST = [];

const CHECK_EXTERNAL = process.argv.includes('--external');

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Strip fenced code blocks and inline code spans so shell/JSON examples
 *  containing bracket-paren sequences don't register as links. */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function extractLinks(text) {
  const links = [];
  // Inline links and images: [text](target) / ![alt](target "title")
  const re = /!?\[[^\]]*\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g;
  let m;
  for (const line of stripCode(text).split('\n')) {
    while ((m = re.exec(line)) !== null) links.push(m[1]);
    re.lastIndex = 0;
  }
  return links;
}

const mdFiles = [];
for (const dir of SCAN_DIRS) {
  for await (const file of walk(path.join(REPO_ROOT, dir))) {
    if (file.endsWith('.md')) mdFiles.push(file);
  }
}
for (const name of SCAN_ROOT_FILES) mdFiles.push(path.join(REPO_ROOT, name));

const internalFailures = [];
const externalUrls = new Map(); // url -> first "file" seen

for (const file of mdFiles) {
  const rel = path.relative(REPO_ROOT, file);
  const text = await readFile(file, 'utf-8');
  for (const raw of extractLinks(text)) {
    if (raw.startsWith('#') || raw.startsWith('mailto:')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        if (!externalUrls.has(raw)) externalUrls.set(raw, rel);
      }
      continue; // other schemes are out of scope
    }
    if (INTERNAL_EXEMPT.has(rel)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (target === '') continue; // pure fragment
    const resolved = target.startsWith('/')
      ? path.join(REPO_ROOT, target)
      : path.resolve(path.dirname(file), decodeURIComponent(target));
    try {
      await stat(resolved);
    } catch {
      internalFailures.push({ file: rel, link: raw });
    }
  }
}

if (internalFailures.length > 0) {
  console.error(`link-check: BLOCKED. ${internalFailures.length} broken internal link(s):\n`);
  for (const f of internalFailures) console.error(`  ${f.file}: ${f.link}`);
  process.exit(1);
}
console.log(`link-check: internal links clean (${mdFiles.length} files scanned).`);

if (CHECK_EXTERNAL) {
  const failures = [];
  let checked = 0;
  for (const [url, file] of externalUrls) {
    if (EXTERNAL_ALLOWLIST.some((s) => url.includes(s))) continue;
    checked += 1;
    let ok = false;
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
          headers: { 'user-agent': 'solos-cookbook-link-check' },
        });
        // Treat "we got an answer that isn't 404/410" as alive; bot
        // walls return 403/429 and are not link rot.
        if (res.status !== 404 && res.status !== 410) { ok = true; break; }
      } catch {
        // try next method, network errors on HEAD are common
      }
    }
    if (!ok) failures.push({ url, file });
  }
  if (failures.length > 0) {
    console.error(`link-check: ${failures.length} dead external link(s) of ${checked} checked:\n`);
    for (const f of failures) console.error(`  ${f.file}: ${f.url}`);
    process.exit(1);
  }
  console.log(`link-check: external links clean (${checked} unique URLs checked).`);
}
