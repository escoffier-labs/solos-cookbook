import { describe, expect, it } from 'vitest';
import { parseGuide, parseCategoryReadme, resolveMdLink, rewriteMdLinks, toRoman, GITHUB_BLOB } from './cookbook.ts';

describe('parseGuide', () => {
  it('parses the standard shape: paragraph then metadata then separator', () => {
    const raw = [
      '# Multi-Model Orchestration',
      '',
      'How to run multiple AI models in one setup.',
      '',
      '**Tested on:** OpenAI Pro, local GPU',
      '**Last updated:** 2026-06-05',
      '',
      '---',
      '',
      '## Why it matters',
      'Body text.',
    ].join('\n');
    const g = parseGuide(raw, { dir: 'ai-stack', slug: 'multi-model-orchestration' });
    expect(g.title).toBe('Multi-Model Orchestration');
    expect(g.description).toBe('How to run multiple AI models in one setup.');
    expect(g.testedOn).toBe('OpenAI Pro, local GPU');
    expect(g.lastUpdated).toBe('2026-06-05');
    expect(g.body.startsWith('How to run multiple AI models')).toBe(true);
    expect(g.body).not.toContain('**Tested on:**');
    expect(g.body).not.toContain('**Last updated:**');
    expect(g.body).not.toMatch(/^---$/m);
    expect(g.body).toContain('## Why it matters');
  });

  it('handles a multi-paragraph opener with a warning blockquote', () => {
    const raw = [
      '# ACP Claude Code',
      '',
      'First paragraph intro.',
      '',
      'Second paragraph.',
      '',
      '> Warning: things change fast.',
      '',
      '**Tested on:** OpenClaw 2026.x',
      '**Last updated:** 2026-05-01',
      '',
      '---',
      '',
      'Body.',
    ].join('\n');
    const g = parseGuide(raw, { dir: 'ai-stack', slug: 'acp-claude-code' });
    expect(g.description).toBe('First paragraph intro.');
    expect(g.testedOn).toBe('OpenClaw 2026.x');
    expect(g.body).toContain('> Warning: things change fast.');
  });

  it('handles blockquote intro with no metadata lines', () => {
    const raw = [
      '# Cron Patterns',
      '',
      '> The canonical reference for scheduled agent work.',
      '',
      '## What this is',
      'Body.',
    ].join('\n');
    const g = parseGuide(raw, { dir: 'automation', slug: 'cron-patterns' });
    expect(g.title).toBe('Cron Patterns');
    expect(g.description).toBe('The canonical reference for scheduled agent work.');
    expect(g.testedOn).toBeUndefined();
    expect(g.lastUpdated).toBeUndefined();
    expect(g.body).toContain('> The canonical reference');
  });

  it('reads SKILL.md yaml frontmatter', () => {
    const raw = [
      '---',
      'name: frontend-design',
      'version: 1.0.0',
      'description: "Create distinctive frontend direction."',
      'tags:',
      '  - frontend',
      'category: design',
      '---',
      '',
      '# Frontend Design',
      '',
      'Do not ship default-looking UI.',
    ].join('\n');
    const g = parseGuide(raw, { dir: 'skills', slug: 'frontend-design' });
    expect(g.title).toBe('Frontend Design');
    expect(g.description).toBe('Create distinctive frontend direction.');
    expect(g.body).not.toContain('name: frontend-design');
    expect(g.body).toContain('Do not ship default-looking UI.');
  });

  it('handles only Last updated without Tested on', () => {
    const raw = '# T\n\nIntro.\n\n**Last updated:** 2026-01-01\n\n---\n\nBody.';
    const g = parseGuide(raw, { dir: 'tools', slug: 't' });
    expect(g.testedOn).toBeUndefined();
    expect(g.lastUpdated).toBe('2026-01-01');
  });

  it('strips markdown from descriptions and truncates long ones', () => {
    const long = `Some [linked](other.md) **bold** intro. ${'word '.repeat(60)}`;
    const g = parseGuide(`# T\n\n${long}\n\n## H\nBody.`, { dir: 'tools', slug: 't' });
    expect(g.description).toContain('Some linked bold intro.');
    expect(g.description.length).toBeLessThanOrEqual(201);
    expect(g.description.endsWith('…')).toBe(true);
  });
});

describe('parseCategoryReadme', () => {
  it('extracts title and intro and drops the Guides checklist', () => {
    const raw = [
      '# Security',
      '',
      'Defense in depth across host, agents, and network.',
      '',
      '## Guides',
      '',
      '- [x] [`a.md`](a.md) - thing a',
      '- [x] [`b.md`](b.md) - thing b',
      '',
      '## Extra section',
      'Kept prose.',
    ].join('\n');
    const r = parseCategoryReadme(raw);
    expect(r.title).toBe('Security');
    expect(r.intro).toBe('Defense in depth across host, agents, and network.');
    expect(r.body).not.toContain('a.md');
    expect(r.body).toContain('## Extra section');
    expect(r.body).toContain('Kept prose.');
  });
});

describe('resolveMdLink', () => {
  it('leaves external links and anchors alone', () => {
    expect(resolveMdLink('https://example.com/x.md', 'security')).toBeNull();
    expect(resolveMdLink('#section', 'security')).toBeNull();
    expect(resolveMdLink('mailto:a@example.com', 'security')).toBeNull();
  });

  it('resolves same-directory links', () => {
    expect(resolveMdLink('linux-hardening.md', 'security')).toBe('/cookbook/security/linux-hardening/');
    expect(resolveMdLink('./linux-hardening.md', 'security')).toBe('/cookbook/security/linux-hardening/');
  });

  it('keeps anchors on rewritten links', () => {
    expect(resolveMdLink('linux-hardening.md#ufw', 'security')).toBe('/cookbook/security/linux-hardening/#ufw');
  });

  it('resolves cross-category links', () => {
    expect(resolveMdLink('../infrastructure/upgrade-hygiene.md', 'security')).toBe('/cookbook/infrastructure/upgrade-hygiene/');
  });

  it('resolves category README and dir links to chapter pages', () => {
    expect(resolveMdLink('../automation/README.md', 'security')).toBe('/cookbook/automation/');
    expect(resolveMdLink('../automation/', 'security')).toBe('/cookbook/automation/');
  });

  it('routes skills SKILL.md links to skill pages', () => {
    expect(resolveMdLink('../skills/content-scrubber/SKILL.md', 'publishing')).toBe('/cookbook/skills/content-scrubber/');
  });

  it('sends templates deep links to GitHub and the dir to /templates/', () => {
    expect(resolveMdLink('../templates/cron/job.sh', 'automation')).toBe(`${GITHUB_BLOB}/templates/cron/job.sh`);
    expect(resolveMdLink('../templates/', 'automation')).toBe('/cookbook/templates/');
  });

  it('sends unknown root files to GitHub', () => {
    expect(resolveMdLink('../LICENSE', 'templates')).toBe(`${GITHUB_BLOB}/LICENSE`);
  });
});

describe('rewriteMdLinks', () => {
  it('rewrites links outside code fences only', () => {
    const md = [
      'See [guide](other-guide.md) for more.',
      '```bash',
      'echo "[not a link](fake.md)"',
      '```',
      'And [cross](../tools/brigade.md).',
    ].join('\n');
    const out = rewriteMdLinks(md, 'security');
    expect(out).toContain('[guide](/cookbook/security/other-guide/)');
    expect(out).toContain('[not a link](fake.md)');
    expect(out).toContain('[cross](/cookbook/tools/brigade/)');
  });
});

describe('toRoman', () => {
  it('converts chapter numbers', () => {
    expect(toRoman(1)).toBe('I');
    expect(toRoman(4)).toBe('IV');
    expect(toRoman(9)).toBe('IX');
    expect(toRoman(11)).toBe('XI');
  });
});
