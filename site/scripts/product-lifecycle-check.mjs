#!/usr/bin/env node
/**
 * Block retired product names and links from reader-facing cookbook sources.
 *
 * The scrubber's inline allow marker keeps its historical spelling for
 * compatibility. That exact marker is the only exception.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const PUBLIC_ROOTS = [
  'ai-stack',
  'automation',
  'hardware',
  'infrastructure',
  'knowledge',
  'philosophy',
  'publishing',
  'security',
  'templates',
  'tools',
  'hooks',
  'site/src/components',
  'site/src/content',
  'site/src/diagrams',
  'site/src/pages',
];

const PUBLIC_FILES = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'SAFETY_RULES.md',
  'site/src/lib/site.ts',
];
const PUBLIC_EXTENSIONS = new Set(['.astro', '.json', '.md', '.sh', '.svg', '.ts']);

export const RETIRED_PRODUCTS = [
  { name: 'StationTrail', pattern: /\bstationtrail\b/i },
  { name: 'SourceHarvest', pattern: /\bsourceharvest\b/i },
  { name: 'code-search-mcp', pattern: /\bcode-search-mcp\b/i },
  { name: 'standalone content-guard', pattern: /\bcontent-guard\b/i },
  { name: 'private authorship process', pattern: /\bAI[- ]?attribution\b/i },
  { name: 'private authorship process', pattern: /\bCo-Authored-By\b/i },
  { name: 'verification bypass advice', pattern: /--no-verify\b/i },
];

function stripCompatibilityMarker(line, file) {
  let stripped = line
    .replace(/<!--\s*content-guard:\s*allow\s+[\w<>-]+\s*-->/gi, '')
    .replace(/content-guard:\s*allow\s+<rule-id>/gi, '');
  if (file === 'hooks/pre-push') {
    stripped = stripped
      .replace(/\bCONTENT_GUARD_(?:EXTRA_POLICY|POLICY)\b/g, '')
      .replace(/\.config\/content-guard\/internal\.json/g, '');
  }
  return stripped;
}

export function findRetiredProductRefs(text, file = '<input>') {
  const findings = [];
  for (const [index, originalLine] of text.split(/\r?\n/).entries()) {
    const line = stripCompatibilityMarker(originalLine, file);
    for (const product of RETIRED_PRODUCTS) {
      if (product.pattern.test(line)) {
        findings.push({ file, line: index + 1, product: product.name });
      }
    }
  }
  return findings;
}

async function walk(relativeRoot) {
  const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await walk(relativePath));
    if (entry.isFile() && PUBLIC_EXTENSIONS.has(path.extname(entry.name))) files.push(relativePath);
  }
  return files;
}

export async function scanPublicSources() {
  const files = [...PUBLIC_FILES];
  for (const root of PUBLIC_ROOTS) files.push(...await walk(root));

  const findings = [];
  for (const file of files.sort()) {
    const text = await readFile(path.join(REPO_ROOT, file), 'utf8');
    findings.push(...findRetiredProductRefs(text, file));
  }
  return findings;
}

async function main() {
  const findings = await scanPublicSources();
  if (findings.length === 0) {
    console.log('product-lifecycle-check: clean (no blocked public references).');
    return;
  }

  console.error(`product-lifecycle-check: BLOCKED. ${findings.length} retired product or private process reference(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.product}`);
  }
  console.error('\nUpdate the recipe to the maintained product or command before publishing.');
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
