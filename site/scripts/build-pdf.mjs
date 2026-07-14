// site/scripts/build-pdf.mjs
//
// Renders the built single-document book (dist/book/index.html) to a paginated
// PDF with Paged.js and writes it to ../dist-book/cookbook.pdf.
//
// Two environment-specific wrinkles are handled here:
//
//  1. The book's CSS and fonts are referenced with absolute paths under the
//     site base (/cookbook/_astro/...). Loading the file over file:// makes
//     those resolve to the filesystem root and 404, which makes Paged.js reject
//     with a ProgressEvent. We serve dist/ over a local HTTP server so the base
//     path resolves and point the renderer at the URL.
//
//  2. Headless Chromium cannot launch under the default sandbox on this host,
//     and pagedjs-cli's own browser launch hit puppeteer's default 180s
//     protocolTimeout on Page.navigate for this large document. We launch the
//     browser ourselves with --no-sandbox and a generous protocolTimeout, then
//     hand the endpoint to pagedjs-cli's Printer so we keep its pagination and
//     PDF post-processing (outline, trim boxes, metadata).

import { mkdirSync, existsSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import Printer from 'pagedjs-cli';

const SITE = path.resolve(import.meta.dirname, '..');
const DIST = path.join(SITE, 'dist');
const BASE = '/cookbook'; // must match `base` in astro.config.mjs
const input = path.join(DIST, 'book', 'index.html');
const outDir = path.join(SITE, '..', 'dist-book');
const output = path.join(outDir, 'cookbook.pdf');

if (!existsSync(input)) {
  console.error('Build the print route first: npm run build:book');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length);
  let filePath = path.join(DIST, pathname);
  try {
    if (statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    res.statusCode = 404; res.end('Not found'); return;
  }
  // Prevent path traversal outside dist.
  if (!filePath.startsWith(DIST)) { res.statusCode = 403; res.end('Forbidden'); return; }
  try {
    statSync(filePath);
  } catch {
    res.statusCode = 404; res.end('Not found'); return;
  }
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}${BASE}/book/`;

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
  const printer = new Printer({
    browserEndpoint: browser.wsEndpoint(),
    timeout: 0,
  });
  printer.on('page', (page) => {
    if (page.position === 0) process.stdout.write('Rendering pages');
    process.stdout.write('.');
  });
  printer.on('rendered', () => process.stdout.write('\n'));

  // outlineTags drives the PDF bookmark outline; the CLI defaults to these.
  const pdf = await printer.pdf({ url }, { outlineTags: ['h1', 'h2', 'h3'] });
  writeFileSync(output, pdf);
  console.log('PDF written:', output);
} finally {
  await browser.close();
  server.close();
}
