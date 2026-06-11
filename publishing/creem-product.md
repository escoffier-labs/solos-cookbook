# Creem product setup: Cookbook Premium Edition

Everything you need to stand up the paid product in Creem. The agent prepared
the copy; the dashboard steps are yours (account, payout, upload, publish).

## Product

- **Name:** Solomon's Guide to Cookin' with Gas, Premium Edition
- **Price:** $39 USD, one-time. Free updates.
- **Type:** Digital product, two files delivered on purchase.
- **Store:** Escoffier Labs

## Delivery files (build them first)

From the repo root, on the `cookbook-premium-edition` branch:

```bash
cd site && npm run build && npm run build:pdf   # -> dist-book/cookbook.pdf
cd .. && node scripts/build-bundle.mjs          # -> dist-book/cookbook-kitchen-bundle.zip
```

Upload both to the Creem product:
- `dist-book/cookbook.pdf` (the typeset book, ~24 MB, 823 pages)
- `dist-book/cookbook-kitchen-bundle.zip` (templates + setup checklist)

No license keys needed: the files are ungated, Creem just delivers them on purchase.

## Product description (paste into Creem)

> The whole kitchen, plated.
>
> Every recipe in this cookbook is free to read at escoffierlabs.dev/cookbook.
> This is the edition you buy because you want the artifact: the full guide,
> typeset and designed for offline reading, plus the parts that are not on the web.
>
> What you get:
> - The typeset PDF. 823 pages, cover to colophon, designed to actually read.
> - Exclusive hero diagrams that open each chapter. They are not on the website.
> - The runnable kitchen bundle: every template, config, and a one-page setup
>   checklist that takes you from an empty machine to a running stack.
>
> One-time purchase. Free updates for the life of the edition. You are buying the
> designed artifact and the bundle, not access to the knowledge, which stays free.

## Thank-you text (paste into Creem post-purchase message)

> Thank you. Your two downloads are below: the Premium Edition PDF and the kitchen
> bundle. Updates to this edition are free, you will get them at this same link.
> Questions or a problem with a download? Reply to your receipt email.

## Refund policy line

> Digital product. If a download is broken or not what was described, email within
> 14 days for a full refund.

## Free-updates promise wording (use consistently)

> Free updates for the life of this edition.

## Solomon dashboard checklist

- [ ] Create/confirm the Creem account; apply the shipper.club discount.
- [ ] Set store name "Escoffier Labs".
- [ ] Complete tax/payout onboarding (Creem is merchant of record; it remits VAT and sales tax). Note the non-EU payout fee ($7 or 1%, whichever is higher). Batch payouts monthly so the flat fee is negligible.
- [ ] New digital product. Paste the description, thank-you text, and refund line above.
- [ ] Upload `cookbook.pdf` and `cookbook-kitchen-bundle.zip` as the delivered files.
- [ ] Set price $39, one-time. Enable the hosted checkout.
- [ ] Publish. Copy the product/checkout URL.
- [ ] Hand the URL back: it replaces `https://CREEM_PRODUCT_URL` in
      `site/src/pages/index.astro` and the repo `README.md`.
- [ ] Run a test purchase (Creem test mode, or a real $39 you refund) and confirm
      BOTH files download.

## After the URL is live

The agent (or you) swaps the placeholder, rebuilds, and ships the buy section:

```bash
cd site && npm run build && npm run check
```
