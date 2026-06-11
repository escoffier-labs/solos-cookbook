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
