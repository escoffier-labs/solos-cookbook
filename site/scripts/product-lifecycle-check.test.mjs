import { describe, expect, it } from 'vitest';
import { findRetiredProductRefs } from './product-lifecycle-check.mjs';

describe('product lifecycle check', () => {
  it.each([
    'install stationtrail',
    'run sourceharvest version',
    'add code-search-mcp',
    'content-guard scan draft.md',
    'add an AI-attribution trailer',
    'Co-Authored-By: example',
    'git push --no-verify',
  ])('blocks retired product copy: %s', (text) => {
    expect(findRetiredProductRefs(text, 'guide.md')).toHaveLength(1);
  });

  it('allows the current compatibility marker', () => {
    const text = '<!-- content-guard: allow private-ipv4 -->';
    expect(findRetiredProductRefs(text, 'guide.md')).toEqual([]);
  });

  it('allows legacy policy variables only in the live compatibility hook', () => {
    const text = 'CONTENT_GUARD_POLICY=~/.config/content-guard/internal.json';
    expect(findRetiredProductRefs(text, 'hooks/pre-push')).toEqual([]);
    expect(findRetiredProductRefs(text, 'guide.md')).not.toEqual([]);
  });
});
