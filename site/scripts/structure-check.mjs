#!/usr/bin/env node
/**
 * Structure lint for the guide skeleton.
 *
 * CONTRIBUTING.md declares Verification and Gotchas mandatory for every
 * guide; this enforces it so heading drift fails the gate instead of
 * accumulating silently. Category README indexes are exempt, as are the
 * essay/design directories (philosophy, plans, skills, templates).
 *
 * Usage: node scripts/structure-check.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Directories whose .md files are guides bound to the CONTRIBUTING skeleton.
const GUIDE_DIRS = [
  'ai-stack', 'automation', 'infrastructure', 'security',
  'knowledge', 'hardware', 'tools', 'publishing',
];

// Required top-level headings per guide.
const REQUIRED_HEADINGS = ['## Verification', '## Gotchas'];

/** Strip fenced code blocks so example markdown inside ``` fences can't
 *  satisfy (or fake) a required heading. */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

const failures = [];
let scanned = 0;

for (const dir of GUIDE_DIRS) {
  const entries = await readdir(path.join(REPO_ROOT, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;
    const rel = path.join(dir, entry.name);
    const text = stripFences(await readFile(path.join(REPO_ROOT, rel), 'utf-8'));
    scanned += 1;
    for (const heading of REQUIRED_HEADINGS) {
      const re = new RegExp(`^${heading}\\s*$`, 'm');
      if (!re.test(text)) failures.push({ file: rel, heading });
    }
  }
}

if (failures.length > 0) {
  console.error(`structure-check: BLOCKED. ${failures.length} missing required heading(s):\n`);
  for (const f of failures) console.error(`  ${f.file}: missing "${f.heading}"`);
  console.error('\nEvery guide needs the canonical skeleton headings (see CONTRIBUTING.md).');
  process.exit(1);
}

console.log(`structure-check: clean (${scanned} guides checked).`);
