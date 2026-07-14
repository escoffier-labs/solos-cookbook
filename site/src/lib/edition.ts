const STRIPE_PAYMENT_LINK_HOST = 'buy.stripe.com';

export const EDITION = {
  name: '2026 Edition',
  price: '$39',
  updatesThrough: 'June 30, 2027',
} as const;

/** Return a launchable Stripe Payment Link, or null while checkout is not approved. */
export function checkoutLink(raw: string | undefined, ready: string | undefined): string | null {
  if (ready !== '1' || !raw || raw.includes('REPLACE_ME')) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== STRIPE_PAYMENT_LINK_HOST ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname === '/' ||
      url.pathname.startsWith('/test_')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The print route is an artifact build input, never a normal public page. */
export function shouldBuildBook(raw: string | undefined): boolean {
  return raw === '1';
}
