// site/scripts/book-structure.test.mjs
import { test, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES } from '../src/lib/cookbook.ts';
import { shouldBuildBook } from '../src/lib/edition.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const BOOK_HTML = path.join(import.meta.dirname, '../dist/book/index.html');
const PACKAGE_JSON = path.join(import.meta.dirname, '../package.json');
// The book is produced by `npm run build:pdf`, a manual step that is not part
// of the CI verify gate. Skip these structural checks when it has not been built.
const bookBuilt = shouldBuildBook(process.env.BUILD_BOOK) && existsSync(BOOK_HTML);
let html = '';

beforeAll(async () => {
  if (bookBuilt) html = await readFile(BOOK_HTML, 'utf-8');
});

test('book build preserves the content scrub gate and runs structural checks', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON, 'utf-8'));
  expect(packageJson.scripts['build:book']).toBe('BUILD_BOOK=1 npm run build');
  expect(packageJson.scripts['build:pdf']).toContain('BUILD_BOOK=1 vitest run scripts/book-structure.test.mjs');
});

test.skipIf(!bookBuilt)('book contains every guide markdown file as an article', async () => {
  let expected = 0;
  for (const { dir } of CATEGORIES) {
    const files = await readdir(path.join(REPO_ROOT, dir)).catch(() => []);
    expected += files.filter((f) => f.endsWith('.md') && f !== 'README.md').length;
  }
  const articles = (html.match(/class="guide"/g) || []).length;
  expect(expected).toBe(61);
  expect(articles).toBe(61);
});

test.skipIf(!bookBuilt)('book renders all chapters', () => {
  const sections = (html.match(/class="chapter"/g) || []).length;
  expect(sections).toBe(CATEGORIES.length);
});
