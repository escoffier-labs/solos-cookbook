#!/usr/bin/env node
/**
 * Build-blocking scrub gate for the published content surface.
 * Runs as `prebuild`, so `astro build` (locally and on Vercel) fails
 * before emitting dist/ if anything private-looking lands in a guide.
 *
 * Usage: node scripts/scrub-check.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scan } from './scrub-core.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Everything the site renders or links into, plus the repo-level docs.
const SCAN_DIRS = [
  'ai-stack', 'automation', 'infrastructure', 'security', 'knowledge',
  'hardware', 'tools', 'publishing', 'philosophy', 'plans', 'skills', 'templates',
];
const SCAN_ROOT_FILES = ['README.md', 'CONTRIBUTING.md'];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  for await (const file of walk(path.join(REPO_ROOT, dir))) {
    const text = await readFile(file, 'utf-8');
    violations.push(...scan(text, path.relative(REPO_ROOT, file)));
  }
}
for (const name of SCAN_ROOT_FILES) {
  const text = await readFile(path.join(REPO_ROOT, name), 'utf-8');
  violations.push(...scan(text, name));
}

if (violations.length > 0) {
  console.error(`scrub-check: BLOCKED. ${violations.length} violation(s) in published content:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.rule}: ${v.snippet}`);
  }
  console.error('\nFix the leak, or for a legitimate doc example add an inline tag:');
  console.error('  <!-- content-guard: allow <rule-id> -->');
  process.exit(1);
}

console.log('scrub-check: clean.');
