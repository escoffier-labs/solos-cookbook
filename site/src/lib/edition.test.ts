import { describe, expect, it } from 'vitest';
import { checkoutLink, shouldBuildBook } from './edition.ts';

describe('checkoutLink', () => {
  it('accepts a configured Stripe Payment Link', () => {
    expect(checkoutLink('https://buy.stripe.com/14A123abc', '1')).toBe('https://buy.stripe.com/14A123abc');
  });

  it('keeps checkout disabled for missing, placeholder, or non-Stripe URLs', () => {
    expect(checkoutLink('https://buy.stripe.com/14A123abc', undefined)).toBeNull();
    expect(checkoutLink(undefined, '1')).toBeNull();
    expect(checkoutLink('https://buy.stripe.com/REPLACE_ME', '1')).toBeNull();
    expect(checkoutLink('https://buy.stripe.com/test_123', '1')).toBeNull();
    expect(checkoutLink('https://example.com/checkout', '1')).toBeNull();
    expect(checkoutLink('http://buy.stripe.com/test_123', '1')).toBeNull();
    expect(checkoutLink('https://buy.stripe.com:444/test_123', '1')).toBeNull();
    const credentialedUrl = new URL('https://buy.stripe.com/test_123');
    credentialedUrl.username = 'name';
    credentialedUrl.password = 'pass';
    expect(checkoutLink(credentialedUrl.toString(), '1')).toBeNull();
    expect(checkoutLink('https://buy.stripe.com/', '1')).toBeNull();
  });
});

describe('shouldBuildBook', () => {
  it('only exposes the print document during an explicit book build', () => {
    expect(shouldBuildBook('1')).toBe(true);
    expect(shouldBuildBook(undefined)).toBe(false);
    expect(shouldBuildBook('0')).toBe(false);
    expect(shouldBuildBook('true')).toBe(false);
  });
});
