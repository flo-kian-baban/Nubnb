# Nubnb — standing rulings

These are settled. Do not re-litigate them; do not re-raise the accepted state.

## What the product is

**Nubnb is not a booking platform.** It presents properties, shows
availability, and renters contact Nubnb. There is no reservation, no payment,
no checkout. Do not build toward one unless asked.

## Price

- **`priceInfo.nightly` is the price.** It is what renters see and what every
  surface must show.
- **Prices are set by admins.** No code computes, adjusts, derives, or
  "corrects" a price. Ever.

## Property documents

- **Existing property documents are never corrected by code.** Admins edit
  them by hand.
- **No backfills.** Not for missing fields, not for inconsistent ones, not as
  a "one-off".
- **Delisted listings stay listed.** That is intended, not a bug.

## Cost posture

- **Nubnb runs at $0 at current traffic**, and draws as little as possible
  from Vercel — that allowance is shared with other projects. Prefer Firebase
  Storage and static/CDN paths over anything metered by Vercel.
- The Vercel plan is **Pro**. Firebase is on **Blaze**.

## Performance

- **Performance is measured on production at https://www.nubnb.ca**, never a
  local build. A local Lighthouse run is a smoke test, not a result.

## Working agreement

- **Nothing is committed or deployed without Kian's review.** End work with a
  diff summary and stop.
- **Commits carry no attribution trailer.** No `Co-Authored-By`, no
  "Generated with" line.

## Before any write

- **Run `scripts/export-firestore.mjs` before any write.** No exceptions.
- **Test data is named `__TEST__ …` and deleted afterwards** — including
  every Storage object it created.
- **Deletions go by document ID, through the production admin API.** Never
  delete by prefix, pattern, or glob.

## Verification

- **Verification means raw output.** Paste what the tool printed.
- **Check contents, not counts.** A count of 44 proves nothing about what is
  in the 44.
- **Never claim a path works from reading the code.** Exercise it.

## Accepted state — do not re-raise

- 14 delisted listings.
- Empty house rules on older properties.
- `priceInfo.weekly` / `priceInfo.monthly` stored but unused.
- 3 divergent prices.
- Rate limiting disabled, pending Upstash.
