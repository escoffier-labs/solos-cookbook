// scripts/build-bundle.mjs
//
// Premium kitchen-bundle builder (paid artifact). This is the premium-edition
// pipeline, separate from the public-site `scripts/verify` gate. It is verified
// by its own CI job (.github/workflows/ci.yml `bundle`) via build-bundle.test.mjs,
// not by `npm --prefix site test`. Needs the `zip` binary. Output is gitignored.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const outDir = path.join(ROOT, 'dist-book');
const output = path.join(outDir, 'cookbook-kitchen-bundle.zip');
mkdirSync(outDir, { recursive: true });

// zip appends to an existing archive, so remove any stale bundle first.
rmSync(output, { force: true });

// Zip the templates tree (includes SETUP-CHECKLIST.md). Exclude any stray node_modules.
execFileSync('zip', ['-r', output, 'templates', '-x', '*/node_modules/*'], { cwd: ROOT, stdio: 'inherit' });
console.log('Bundle written:', output);
