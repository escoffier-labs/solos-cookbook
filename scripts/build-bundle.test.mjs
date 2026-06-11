// scripts/build-bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const zip = path.join(ROOT, 'dist-book', 'cookbook-kitchen-bundle.zip');

test('bundle contains the setup checklist and template dirs', () => {
  const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf-8' });
  assert.match(list, /templates\/SETUP-CHECKLIST\.md/);
  assert.match(list, /templates\/bootstrap\//);
  assert.match(list, /templates\/hooks\//);
  assert.doesNotMatch(list, /node_modules/);
});
