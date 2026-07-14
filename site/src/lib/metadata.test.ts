import { describe, expect, it } from 'vitest';
import { buildPageMetadata } from './metadata.ts';

const common = {
  title: 'Cron Patterns',
  description: 'Choose the right scheduler.',
  url: 'https://escoffierlabs.dev/cookbook/automation/cron-patterns',
  image: 'https://escoffierlabs.dev/cookbook/cookbook-hero.jpg',
  license: 'https://example.com/license',
};

describe('buildPageMetadata', () => {
  it('marks recipe pages as articles with their update date', () => {
    const metadata = buildPageMetadata({ ...common, kind: 'article', dateModified: '2026-07-13' });
    expect(metadata.openGraphType).toBe('article');
    expect(metadata.structuredData).toMatchObject({
      '@type': 'TechArticle',
      headline: 'Cron Patterns',
      dateModified: '2026-07-13',
      mainEntityOfPage: common.url,
    });
  });

  it('keeps index pages as WebSite metadata', () => {
    const metadata = buildPageMetadata({ ...common, kind: 'website' });
    expect(metadata.openGraphType).toBe('website');
    expect(metadata.structuredData).toMatchObject({ '@type': 'WebSite', name: 'Cron Patterns' });
  });
});
