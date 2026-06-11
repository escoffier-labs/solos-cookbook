import { defineCollection, z } from 'astro:content';
import type { Loader, LoaderContext } from 'astro/loaders';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATEGORIES, parseGuide, parseCategoryReadme, rewriteMdLinks } from './lib/cookbook.ts';

/** Repo root (the markdown lives in the parent of site/). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function loadEntry(
  ctx: LoaderContext,
  id: string,
  data: Record<string, unknown>,
  rawBody: string,
  category: string,
) {
  const body = rewriteMdLinks(rawBody, category);
  const parsed = await ctx.parseData({ id, data });
  const digest = ctx.generateDigest(body + JSON.stringify(data));
  const rendered = await ctx.renderMarkdown(body);
  ctx.store.set({ id, data: parsed, body, digest, rendered });
}

const guidesLoader: Loader = {
  name: 'cookbook-guides',
  load: async (ctx) => {
    ctx.store.clear();
    for (const { dir, chapter, number } of CATEGORIES) {
      const dirPath = path.join(REPO_ROOT, dir);
      if (dir === 'skills') {
        // skills/<name>/SKILL.md, each with real YAML frontmatter.
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
          const raw = await readFile(path.join(dirPath, entry.name, 'SKILL.md'), 'utf-8');
          const slug = entry.name;
          const parsed = parseGuide(raw, { dir, slug });
          await loadEntry(ctx, `${dir}/${slug}`, {
            title: parsed.title,
            description: parsed.description,
            category: dir,
            slug,
            chapter,
            chapterNumber: number,
            testedOn: parsed.testedOn,
            lastUpdated: parsed.lastUpdated,
          }, parsed.body, dir);
        }
        continue;
      }
      const files = (await readdir(dirPath))
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort();
      for (const file of files) {
        const raw = await readFile(path.join(dirPath, file), 'utf-8');
        const slug = file.replace(/\.md$/, '');
        const parsed = parseGuide(raw, { dir, slug });
        await loadEntry(ctx, `${dir}/${slug}`, {
          title: parsed.title,
          description: parsed.description,
          category: dir,
          slug,
          chapter,
          chapterNumber: number,
          testedOn: parsed.testedOn,
          lastUpdated: parsed.lastUpdated,
        }, parsed.body, dir);
      }
    }
  },
};

const chaptersLoader: Loader = {
  name: 'cookbook-chapters',
  load: async (ctx) => {
    ctx.store.clear();
    for (const { dir, chapter, number } of CATEGORIES) {
      // Not every category ships a README (plans/ doesn't); synthesize an empty chapter.
      const raw = await readFile(path.join(REPO_ROOT, dir, 'README.md'), 'utf-8').catch(() => `# ${chapter}\n`);
      const parsed = parseCategoryReadme(raw);
      await loadEntry(ctx, dir, {
        title: parsed.title || chapter,
        category: dir,
        intro: parsed.intro,
        number,
      }, parsed.body, dir);
    }
  },
};

const appendixLoader: Loader = {
  name: 'cookbook-appendix',
  load: async (ctx) => {
    ctx.store.clear();
    const raw = await readFile(path.join(REPO_ROOT, 'templates', 'README.md'), 'utf-8');
    const parsed = parseCategoryReadme(raw);
    await loadEntry(ctx, 'templates', {
      title: parsed.title || 'Templates',
      intro: parsed.intro,
    }, parsed.body, 'templates');
  },
};

const checklistLoader: Loader = {
  name: 'cookbook-checklist',
  load: async (ctx) => {
    ctx.store.clear();
    const raw = await readFile(path.join(REPO_ROOT, 'templates', 'SETUP-CHECKLIST.md'), 'utf-8');
    const parsed = parseCategoryReadme(raw);
    await loadEntry(ctx, 'setup-checklist', {
      title: parsed.title || 'Setup Checklist',
    }, parsed.body, 'templates');
  },
};

const glossaryLoader: Loader = {
  name: 'cookbook-glossary',
  load: async (ctx) => {
    ctx.store.clear();
    const raw = await readFile(path.join(REPO_ROOT, 'site', 'src', 'content', 'glossary.md'), 'utf-8');
    const parsed = parseCategoryReadme(raw);
    await loadEntry(ctx, 'glossary', {
      title: parsed.title || 'Glossary',
    }, parsed.body, 'templates');
  },
};

const guides = defineCollection({
  loader: guidesLoader,
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    slug: z.string(),
    chapter: z.string(),
    chapterNumber: z.number(),
    testedOn: z.string().optional(),
    lastUpdated: z.string().optional(),
  }),
});

const chapters = defineCollection({
  loader: chaptersLoader,
  schema: z.object({
    title: z.string(),
    category: z.string(),
    intro: z.string(),
    number: z.number(),
  }),
});

const appendix = defineCollection({
  loader: appendixLoader,
  schema: z.object({
    title: z.string(),
    intro: z.string(),
  }),
});

const checklist = defineCollection({
  loader: checklistLoader,
  schema: z.object({
    title: z.string(),
  }),
});

const glossary = defineCollection({
  loader: glossaryLoader,
  schema: z.object({
    title: z.string(),
  }),
});

export const collections = { guides, chapters, appendix, checklist, glossary };
