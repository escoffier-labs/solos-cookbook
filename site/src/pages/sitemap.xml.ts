import { getCollection } from 'astro:content';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sitePath } from '../lib/site.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function gitLastMod(repoRoot: string, file: string): string | undefined {
  try {
    const out = execSync(`git log -1 --format=%cs -- ${JSON.stringify(file)}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ISO_DATE.test(out) ? out.slice(0, 10) : undefined;
  } catch {
    return undefined;
  }
}

export async function GET({ site }: { site?: URL }) {
  const base = site ?? new URL('https://escoffierlabs.dev');
  const guides = await getCollection('guides');
  const chapters = await getCollection('chapters');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const guideLastmod = new Map<string, string>();
  for (const g of guides) {
    const key = `/${g.data.category}/${g.data.slug}/`;
    const stamped = g.data.lastUpdated?.slice(0, 10);
    if (stamped && ISO_DATE.test(stamped)) {
      guideLastmod.set(key, stamped);
      continue;
    }
    const gitDate = gitLastMod(repoRoot, `${g.data.category}/${g.data.slug}.md`);
    if (gitDate) guideLastmod.set(key, gitDate);
  }
  const paths = [
    '/',
    '/recipes',
    '/about',
    '/templates',
    ...chapters.map((c) => `/${c.data.category}/`),
    ...guides.map((g) => `/${g.data.category}/${g.data.slug}/`),
  ];
  const urls = paths
    .sort()
    .map((path) => {
      const loc = new URL(sitePath(path), base).toString();
      const lastmod = guideLastmod.get(path);
      return [
        '  <url>',
        `    <loc>${loc}</loc>`,
        ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
        '    <changefreq>weekly</changefreq>',
        '  </url>',
      ].join('\n');
    })
    .join('\n');

  return new Response(
    ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', urls, '</urlset>'].join('\n'),
    {
      headers: {
        'Content-Type': 'application/xml',
      },
    },
  );
}
