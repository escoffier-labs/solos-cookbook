import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NAV_LINKS } from './site.ts';

const component = fileURLToPath(new URL('../components/SiteNav.astro', import.meta.url));

describe('mobile navigation', () => {
  it('keeps the complete navigation available below the desktop breakpoint', async () => {
    const source = await readFile(component, 'utf-8');
    expect(source).toContain('<details class="mobile-nav sm:hidden">');
    expect(source).toContain('{NAV_LINKS.map');
  });

  it('includes the edition in the shared navigation model', () => {
    expect(NAV_LINKS).toContainEqual({ label: 'Edition', href: '/cookbook/edition' });
  });
});
