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
- **Never use production credentials to log into the production admin
  panel.** Verify against a local build reading production data; Kian
  performs any check that genuinely requires a live admin session.

## Accepted state — do not re-raise

- 14 delisted listings.
- Empty house rules on older properties.
- `priceInfo.weekly` / `priceInfo.monthly` stored but unused.
- 3 divergent prices.
- Rate limiting disabled, pending Upstash.

## Ruled out — do not propose again

- **Upstash, Sentry, rate limiting, analytics.** Ruled out by Kian.

## Accepted risks

- **No rate limiting in production.**
- **No error monitoring.**
- **No analytics.**
- **The admin PIN doubles as the session signing key.** One leaked session
  cookie yields the PIN offline in ~16 ms.
- **Cleaner codes are 4 digits.** 10,000 combinations and no rate limiting,
  so the cleaner door can be brute-forced. Exposure is limited to submitting
  cost entries under another cleaner's name; receipts and admin approval
  remain required.
- **Cleaner codes are stored readably**, by Kian's ruling (2026-09-28): any
  admin can see and change any cleaner's code. A code is its `cleaner_codes`
  document ID and sits on the cleaner's document, so a copy of the database
  — every `./backups/` export included — exposes every cleaner code, current
  and replaced.

## Receipt reading — Kian's decision (2026-09-30)

- **Receipt photos leave Nubnb's systems and go to Google's Gemini API**
  (`POST /api/cleaner/read-receipt`, model `gemini-3.8-flash`, thinking
  low). A receipt shows what was bought, where, when, sometimes a card's
  last four digits, and sometimes a property address a cleaner wrote on it.
- Google's Gemini API terms (https://ai.google.dev/gemini-api/terms,
  effective 2026-03-23), "How Google Uses Your Data": for **Paid Services**
  Google "doesn't use your prompts (including … files such as images …) or
  responses to improve our products", logs them "for a limited period of
  time, solely for detecting and preventing violations of the Prohibited
  Use Policy", and may store them "in any country in which Google or its
  agents maintain facilities". For **Unpaid Services** the content is used
  to "improve, and develop Google products" and "human reviewers may read"
  it. Access "is a 'Paid Service' only when accessing the API through a
  Cloud Project associated with an active billing account" — so
  **`GEMINI_API_KEY` must come from a billing-enabled project.** Only Kian
  can confirm that; the code cannot.
- **The reading fills the form; the cleaner confirms.** What is stored as the
  entry is what the cleaner sent. The raw reading is stored apart, in
  `cost_entry_readings/{entryId}`, as evidence about the model. It is never
  a claim about the purchase.
- **The purchase date is never filled from the reading.** A purchase date
  more than 12 months in the past, or in the future, is refused wherever
  one is entered (Toronto calendar).
- **Spend is capped in code:** 40 readings per cleaner per day, 300 per day
  in all (`receipt_reading_quota/YYYY-MM-DD`), about $0.60 a day at most at
  the measured $0.002 a reading. Google's project quota is the backstop.

## Costs — Kian's rulings of 2026-09-30 (dispatch 21)

- **Tax is its own field on a cost entry, never a line among the items.** An
  item line is something that was bought. Entries written before this store
  any tax the cleaner typed as a line; they are never backfilled, so both
  shapes must display correctly for good.
- **A property may have a cleaner-facing name**, which cleaners see instead
  of the real name everywhere in their app. It lives in the server-only
  collection `property_cleaner_names/{propertyId}`, denied to browsers in
  `firestore.rules`, **never on the property document**: `properties` is
  world-readable and these names will sometimes be street addresses. Admins
  set it through `/api/admin/properties/[id]/cleaner-name`; cleaners read it
  through `/api/cleaner/start`; the public site never sees it. A property
  without one falls back to its real name.
- **`/admin/costs` is the review queue** and opens on what still needs
  attention rather than everything ever logged. **Each property's page is
  its ledger:** clicking a property in the admin list opens its costs —
  approved entries only, a date range the admin picks, its totals, and its
  Excel and PDF exports. An approved entry moves from the queue into its
  property's ledger. A rejected or removed entry never appears in a ledger;
  it stays in the queue, marked, with its prior state readable. The queue
  and the ledger read the same entries: nothing is erased, duplicated,
  copied or moved between collections.

## Costs — Kian's rulings of 2026-09-30 (the ledger, and approved entries)

- **A property's ledger is reachable the obvious way:** from the property's
  name or a clearly labelled control on its row in the admin list, not an
  icon an admin has to be told about. Clicking through lands on that
  property's costs with its date range and both exports, without further
  clicks. The edit form stays reachable.
- **Approved entries stay editable and removable.** An approved entry is
  already in a co-owner's PDF, so an admin who finds a wrong amount can
  correct a line, correct the tax or remove the entry after approval, not
  only before. Each is recorded in the entry's history. A removal takes the
  entry out of the ledger, its totals and its exports, and it stays visible
  in the queue, marked. Nothing is erased.
- **If an entry is corrected after it appeared in an exported PDF, the
  ledger makes that visible:** an admin can tell that what a co-owner
  already received no longer matches.

## Availability — Kian's rulings of 2026-09-30 (dispatch 22)

- **Admin-only, inside the existing admin panel, its own page, plus stats
  on the admin home page — the same shape as costs.** The section is called
  **Availability**. The current design language and styling throughout.
- **Availability is refreshed on a schedule and searched from the stored
  copy, not fetched live per property.** Slightly stale availability is
  acceptable; a slow search on a phone call is not. **Hourly.**
- **Schedule it on Firebase, not Vercel** — the Vercel allowance is shared
  with other projects.
- **Mobile responsiveness is a later version.** Not scoped.
- **Keep daily snapshots from day one.**
- **Show Airbnb-gone properties ranked and marked.**
- **Build the listing-page check, subject to the datacenter test.**
- **Show the stay total on a search row.**
- **Rank the attention list by empty nights in runs of at least the
  property's minimum stay — the nights it could actually sell. Keep the raw
  empty-night count as a column beside it.**
- **One plain line at the top of the attention view saying the list shows
  where nights are open, not why, and not whether anyone wanted them. The
  same caveat, shorter, under the home-page tile.**
- "Empty and available" is the real signal; a property blocked by its owner
  is not a problem to solve.
