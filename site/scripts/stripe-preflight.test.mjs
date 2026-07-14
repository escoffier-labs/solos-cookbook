import { describe, expect, it } from 'vitest';
import { validateEditionPaymentLink } from './stripe-preflight.mjs';

const valid = {
  active: true,
  livemode: true,
  url: 'https://buy.stripe.com/14A123abc',
  line_items: {
    data: [{
      quantity: 1,
      price: {
        active: true,
        currency: 'usd',
        unit_amount: 3900,
        type: 'one_time',
        recurring: null,
      },
    }],
  },
};

describe('validateEditionPaymentLink', () => {
  it('accepts the live one-time USD 39 edition product', () => {
    expect(validateEditionPaymentLink(valid, valid.url)).toEqual([]);
  });

  it('reports launch-blocking product mismatches', () => {
    const errors = validateEditionPaymentLink({
      ...valid,
      active: false,
      livemode: false,
      line_items: {
        data: [{
          quantity: 1,
          price: { ...valid.line_items.data[0].price, unit_amount: 4900, type: 'recurring', recurring: {} },
        }],
      },
    }, 'https://buy.stripe.com/different');

    expect(errors).toEqual(expect.arrayContaining([
      'Payment Link is not active.',
      'Payment Link is not in live mode.',
      'Payment Link URL does not match PUBLIC_STRIPE_PAYMENT_LINK.',
      'Price must be exactly USD 39.00.',
      'Price must be one-time, not recurring.',
    ]));
  });
});
