// scripts/build-bundle.test.mjs
//
// Verifies the premium kitchen-bundle. This is part of the paid-artifact
// pipeline, NOT the public-site gate, so it runs in its own CI job
// (.github/workflows/ci.yml `bundle`) and not under `npm --prefix site test`.
// Run it directly with: node --test scripts/build-bundle.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const zip = path.join(ROOT, 'dist-book', 'cookbook-kitchen-bundle.zip');

before(() => {
  // Build the bundle first so the test is self-contained on a clean checkout.
  execFileSync('node', ['scripts/build-bundle.mjs'], { cwd: ROOT, stdio: 'inherit' });
});

test('bundle contains the setup checklist and template dirs, and no node_modules', () => {
  const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf-8' });
  assert.match(list, /templates\/SETUP-CHECKLIST\.md/);
  assert.match(list, /templates\/bootstrap\//);
  assert.match(list, /templates\/hooks\//);
  assert.doesNotMatch(list, /node_modules/);
});
