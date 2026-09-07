import { describe, expect, it } from 'vitest';
import { shouldBuildBook } from './print.ts';

describe('shouldBuildBook', () => {
  it('only exposes the print document during an explicit book build', () => {
    expect(shouldBuildBook('1')).toBe(true);
    expect(shouldBuildBook(undefined)).toBe(false);
    expect(shouldBuildBook('0')).toBe(false);
    expect(shouldBuildBook('true')).toBe(false);
  });
});
