import { pathToFileURL } from 'node:url';

const EXPECTED_CURRENCY = 'usd';
const EXPECTED_UNIT_AMOUNT = 3900;

export function validateEditionPaymentLink(paymentLink, expectedUrl) {
  const errors = [];
  if (paymentLink.active !== true) errors.push('Payment Link is not active.');
  if (paymentLink.livemode !== true) errors.push('Payment Link is not in live mode.');
  if (paymentLink.url !== expectedUrl) errors.push('Payment Link URL does not match PUBLIC_STRIPE_PAYMENT_LINK.');

  const items = paymentLink.line_items?.data ?? [];
  if (items.length !== 1 || items[0]?.quantity !== 1) {
    errors.push('Payment Link must contain exactly one edition item with quantity 1.');
    return errors;
  }

  const price = items[0].price ?? {};
  if (price.active !== true) errors.push('Price is not active.');
  if (price.currency !== EXPECTED_CURRENCY || price.unit_amount !== EXPECTED_UNIT_AMOUNT) {
    errors.push('Price must be exactly USD 39.00.');
  }
  if (price.type !== 'one_time' || price.recurring) {
    errors.push('Price must be one-time, not recurring.');
  }
  return errors;
}

async function main() {
  const secret = process.env.STRIPE_SECRET_KEY;
  const paymentLinkId = process.env.STRIPE_PAYMENT_LINK_ID;
  const expectedUrl = process.env.PUBLIC_STRIPE_PAYMENT_LINK;
  if (!secret || !paymentLinkId || !expectedUrl) {
    throw new Error('Set STRIPE_SECRET_KEY, STRIPE_PAYMENT_LINK_ID, and PUBLIC_STRIPE_PAYMENT_LINK.');
  }

  const query = new URLSearchParams([['expand[]', 'line_items']]);
  const response = await fetch(`https://api.stripe.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}?${query}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) throw new Error(`Stripe returned HTTP ${response.status}.`);

  const errors = validateEditionPaymentLink(await response.json(), expectedUrl);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Stripe preflight passed: active, one-time, USD 39.00.');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
