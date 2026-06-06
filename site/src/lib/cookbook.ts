/**
 * Pure content helpers for the cookbook site.
 *
 * The guides in this repo are plain markdown with a loose convention
 * (H1 title, intro prose, optional "**Tested on:**" / "**Last updated:**"
 * lines) and no frontmatter. Everything the site needs is derived here so
 * the content files stay untouched.
 *
 * No Astro imports: this module is unit-tested directly with Vitest.
 */

export interface Category {
  dir: string;
  chapter: string;
  number: number;
}

/** Ordered chapter map. Order here is chapter order everywhere on the site.
 * Display names match the category README H1s so guide kickers and chapter
 * pages agree. */
export const CATEGORIES: Category[] = [
  { dir: 'ai-stack', chapter: 'AI agent stack', number: 1 },
  { dir: 'automation', chapter: 'Automation', number: 2 },
  { dir: 'infrastructure', chapter: 'Self-hosted infrastructure', number: 3 },
  { dir: 'security', chapter: 'Security', number: 4 },
  { dir: 'knowledge', chapter: 'Knowledge management', number: 5 },
  { dir: 'hardware', chapter: 'Hardware & host', number: 6 },
  { dir: 'tools', chapter: 'Tools', number: 7 },
  { dir: 'publishing', chapter: 'Publishing', number: 8 },
  { dir: 'philosophy', chapter: 'Philosophy', number: 9 },
  { dir: 'plans', chapter: 'Plans', number: 10 },
  { dir: 'skills', chapter: 'Skills', number: 11 },
];

export const GITHUB_BLOB = 'https://github.com/solomonneas/solos-cookbook/blob/main';

const CATEGORY_DIRS = new Set(CATEGORIES.map((c) => c.dir));

export function categoryFor(dir: string): Category | undefined {
  return CATEGORIES.find((c) => c.dir === dir);
}

export function toRoman(n: number): string {
  const table: [number, string][] = [
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [value, glyph] of table) {
    while (rest >= value) { out += glyph; rest -= value; }
  }
  return out;
}

export interface ParsedGuide {
  title: string;
  description: string;
  testedOn?: string;
  lastUpdated?: string;
  body: string;
}

/** Strip inline markdown (links, emphasis, code) down to plain text. */
function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 120 ? lastSpace : max).trimEnd()}…`;
}

const TESTED_ON = /^\*\*Tested on:\*\*\s*(.+)\s*$/;
const LAST_UPDATED = /^\*\*Last updated:\*\*\s*(.+)\s*$/;

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Minimal YAML frontmatter reader for the SKILL.md files under skills/
 * (the only files in the repo that carry frontmatter).
 * Handles scalar `key: value` pairs; list values are ignored.
 */
function readFrontmatter(raw: string): Frontmatter | null {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return null;
  const data: Record<string, string> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.+)\s*$/);
    if (m && m[1] && m[2]) {
      data[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const body = raw.slice(end + 4).replace(/^\n+/, '');
  return { data, body };
}

/** First prose block (paragraph or blockquote) after the H1, before metadata/headings. */
function extractDescription(lines: string[]): string {
  const block: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '') continue;
      if (trimmed.startsWith('#') || trimmed === '---') break;
      if (TESTED_ON.test(trimmed) || LAST_UPDATED.test(trimmed)) break;
      inBlock = true;
      block.push(trimmed.replace(/^>\s?/, ''));
    } else {
      if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---') break;
      if (TESTED_ON.test(trimmed) || LAST_UPDATED.test(trimmed)) break;
      block.push(trimmed.replace(/^>\s?/, ''));
    }
  }
  return truncate(plainText(block.join(' ')));
}

/**
 * Parse a guide file into derived frontmatter + a render-ready body.
 *
 * The H1, the metadata lines, and the `---` separator that follows them are
 * stripped from the body: the layout renders title and metadata itself.
 */
export function parseGuide(raw: string, opts: { dir: string; slug: string }): ParsedGuide {
  let source = raw;
  let title = '';
  let description = '';

  const fm = readFrontmatter(raw);
  if (fm) {
    source = fm.body;
    title = fm.data['name'] ?? '';
    description = fm.data['description'] ?? '';
  }

  const lines = source.split('\n');
  let h1Index = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('# ')) { h1Index = i; break; }
    if (line.trim() !== '') break; // prose before any H1: leave body alone
  }
  if (h1Index !== -1) {
    // Prefer the body H1 for display (frontmatter `name` is a slug).
    title = plainText((lines[h1Index] ?? '').slice(2)) || title;
  }
  title = title || opts.slug;

  const afterH1 = h1Index === -1 ? lines : lines.slice(h1Index + 1);

  const testedOn = source.match(new RegExp(TESTED_ON.source, 'm'))?.[1]?.trim();
  const lastUpdated = source.match(new RegExp(LAST_UPDATED.source, 'm'))?.[1]?.trim();

  if (!description) description = extractDescription(afterH1);

  // Body: drop H1, metadata lines, and the separator rule right after them.
  const bodyLines: string[] = [];
  let metaSeen = false;
  let separatorDropped = false;
  for (const line of afterH1) {
    const trimmed = line.trim();
    if (TESTED_ON.test(trimmed) || LAST_UPDATED.test(trimmed)) { metaSeen = true; continue; }
    if (metaSeen && !separatorDropped) {
      if (trimmed === '') continue;
      if (trimmed === '---') { separatorDropped = true; continue; }
      separatorDropped = true;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n').replace(/^\n+/, '');

  const result: ParsedGuide = { title, description, body };
  if (testedOn) result.testedOn = testedOn;
  if (lastUpdated) result.lastUpdated = lastUpdated;
  return result;
}

export interface ParsedReadme {
  title: string;
  intro: string;
  body: string;
}

/**
 * Parse a category README into a chapter intro. The `## Guides` checklist is
 * dropped (the chapter page renders cards instead); everything else stays.
 */
export function parseCategoryReadme(raw: string): ParsedReadme {
  const lines = raw.split('\n');
  let title = '';
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (!title && line.startsWith('# ')) { title = plainText(line.slice(2)); continue; }
    if (/^##\s+Guides\s*$/i.test(line.trim()) || /^##\s+Included skills\s*$/i.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping && /^##\s+/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const body = kept.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  const intro = extractDescription(body.split('\n'));
  return { title, intro, body };
}

/**
 * Resolve a relative markdown link target to a site route or external URL.
 * Returns null when the href should be left untouched (external, anchor)
 * and flags unknown internal targets so the caller can warn.
 */
export function resolveMdLink(href: string, category: string): string | null {
  if (/^(https?:|mailto:|#)/i.test(href)) return null;

  const [rawPath = '', hash] = href.split('#');
  const anchor = hash ? `#${hash}` : '';

  // Resolve against the current category directory to a repo-absolute path.
  const segments = rawPath.startsWith('../')
    ? rawPath.replace(/^(\.\.\/)+/, '').split('/')
    : rawPath.startsWith('./')
      ? [category, ...rawPath.slice(2).split('/')]
      : rawPath.includes('/') && CATEGORY_DIRS.has(rawPath.split('/')[0] ?? '')
        ? rawPath.split('/')
        : rawPath.includes('/') && rawPath.split('/')[0] === 'templates'
          ? rawPath.split('/')
          : [category, ...rawPath.split('/')];

  const parts = segments.filter((s) => s !== '' && s !== '.');
  const first = parts[0] ?? '';
  const rest = parts.slice(1);

  // templates/ is not rendered on-site: deep links go to GitHub.
  if (first === 'templates') {
    if (rest.length === 0) return '/templates/';
    return `${GITHUB_BLOB}/${parts.join('/')}`;
  }

  if (!CATEGORY_DIRS.has(first)) {
    // Root-level files or unknown dirs: send to GitHub.
    if (rawPath.endsWith('/')) return `${GITHUB_BLOB}/${parts.join('/')}`;
    return parts.length ? `${GITHUB_BLOB}/${parts.join('/')}` : null;
  }

  if (rest.length === 0) return `/${first}/`;

  // skills/<name>/SKILL.md → /skills/<name>/
  if (first === 'skills' && rest.length === 2 && rest[1] === 'SKILL.md') {
    return `/skills/${rest[0]}/${anchor}`;
  }

  const file = rest.join('/');
  if (file === 'README.md') return `/${first}/${anchor}`;
  if (file.endsWith('.md') && rest.length === 1) {
    return `/${first}/${file.replace(/\.md$/, '')}/${anchor}`;
  }

  // Non-markdown or nested file inside a category: GitHub.
  return `${GITHUB_BLOB}/${parts.join('/')}`;
}

/**
 * Rewrite relative `.md` links in markdown source to site routes,
 * skipping fenced code blocks. Inline links only — the corpus uses
 * standard `[text](target)` syntax throughout.
 */
export function rewriteMdLinks(markdown: string, category: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.replace(/\]\(([^)\s]+)\)/g, (match, href: string) => {
      const resolved = resolveMdLink(href, category);
      return resolved ? `](${resolved})` : match;
    });
  });
  return out.join('\n');
}
