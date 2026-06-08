import { getCollection } from 'astro:content';
import { sitePath } from '../lib/site.ts';

export async function GET({ site }: { site?: URL }) {
  const base = site ?? new URL('https://escoffierlabs.dev');
  const guides = await getCollection('guides');
  const chapters = await getCollection('chapters');
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
      return [
        '  <url>',
        `    <loc>${loc}</loc>`,
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
