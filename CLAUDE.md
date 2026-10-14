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

- **Upstash, Sentry, rate limiting, analytics.** Ruled out by Kian. Rate
  limiting is ruled in for admin sign-in only (dispatch 38, below).

## Accepted risks

- **No rate limiting in production**, except admin sign-in (dispatch 38).
- **No error monitoring.**
- **No analytics.**
- **Cleaner codes are 4 digits.** 10,000 combinations and no rate limiting,
  so the cleaner door can be brute-forced. Exposure is limited to submitting
  cost entries under another cleaner's name; receipts and admin approval
  remain required.
- **Cleaner codes are stored readably**, by Kian's ruling (2026-09-28): any
  admin can see and change any cleaner's code. A code is its `cleaner_codes`
  document ID and sits on the cleaner's document, so a copy of the database
  — every `./backups/` export included — exposes every cleaner code, current
  and replaced.
- **Admin PINs are stored readably**, by Kian's ruling (2026-10-13, night):
  any copy of the database — every `./backups/` export included — holds every
  admin PIN, and a main admin can act as any admin.

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
  (The home-page stats were withdrawn on 2026-10-02: see Admin home below.)
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

## Admin home — Kian's ruling of 2026-10-02

- **The stat tiles on top of the admin home are only four, left to right:**
  1. the number of total units on the platform;
  2. costs to be reviewed — just the number of the costs, not the price on
     them;
  3. leads coming in — only the new leads number;
  4. past due reports to be generated.

## Statements — Kian's rulings of 2026-10-02 (dispatch 23G)

- **Nubnb's cycle: admins write the previous month's statements between the
  1st and the 10th of the current month.**
- **A property owes statements from the latest of September 2026, the month
  it was added, and its record's start month.** Kian's ruling of 2026-10-03,
  superseding the earlier one that a property with no record owes every
  closed month.
- **A property owes a statement for any month in which it has accepted
  income or approved costs, regardless of when it was added. A management
  record's end month still stops it.** Kian's ruling of 2026-10-04,
  replacing the created-month part of the owed-months rule for months with
  money. **September 2026 and a record's start month still apply to money
  months. Accepted income is any line on the month's draft, typed or
  accepted, negatives included.** Kian's confirmation of 2026-10-04.
- **A property's status is based on the previous month — what is due now:**
  finished is done; not finished, from the 1st to the 10th, is a warning;
  not finished after the 10th is a warning, unchanged; any month two or more
  months back with no finished statement is a problem, which outranks the
  warning. **The current month is never counted; it is not due.**
- **The property list has a column showing that status**, in the tones the
  rest of the admin uses, readable at a glance across every row, linking to
  that property's page at the month in question. **The property page's
  head, the home panel and the Statements tile use the same rule and the
  same words. One function decides it.**
- **An admin can delete a finished statement, whether or not it was
  downloaded, and continue editing the month as a draft.** This replaces the
  earlier ruling that a finished statement is never changed. **Consequence:
  once deleted, there is no record of what an owner received.**
- On delete, the report document and its stored PDF are removed, and the
  draft reopens with everything the statement held — lines, fee, balance,
  notes, Report For — so the admin continues rather than retypes. Download
  records for it go too, since the statement they refer to is gone. **The
  admin confirms first, told what is lost:** "This statement was downloaded
  3 October. Deleting it removes the record of what was sent."
- **Superseding stays as it is:** an admin can still correct by superseding
  instead of deleting.

## Team and costs — Kian's rulings of 2026-10-02 (dispatch 23H)

- **When an admin creates a cleaner or a handyman, they type the 4-digit
  code** rather than being given a generated one. Offer to generate one, but
  let them type it. The existing refusals hold: a code already in use, a code
  equal to the admin PIN, and the reserved list. Changing a code afterwards
  is unchanged.
- **An admin can delete a cost entry entirely — the document, its history,
  and its receipt object in Storage.** This reverses the earlier ruling that
  nothing is deleted. **Consequence: a deleted entry leaves no record of what
  was claimed or who logged it.**
- **A confirmation names what is lost:** who logged it, when, the amount, and
  that the receipt photo goes with it. It is the only safeguard, so it is
  written plainly.
- **Removal stays as it is** — excluded from totals, still visible, marked —
  so an admin can exclude without erasing.
- **The delete is refused when the entry is printed in a finished
  statement, and says which.** A statement already sent cannot reference an
  entry that no longer exists.

## Team — Kian's ruling of 2026-10-02 (afternoon)

- **A team member — a cleaner or a handyman — can be fully deleted.**
  **Consequence: the account is gone for good and cannot be reactivated.**
- **A code can be reused when no active account holds it.** This replaces
  the earlier rule that a replaced code is never given out again.

## Backup — Kian's rulings of 2026-10-03 (dispatch 24)

- **The backup is a mirror.** What is deleted in Nubnb is deleted from the
  backup.
- **A "Back up this month" button on the admin home from the 11th.** It
  lists the properties still due and backs up what exists; running it again
  updates the backup.
- **Owners' folders are separate from Nubnb's.**
- **No versions.** A corrected statement replaces the old one.
- **The admin can download a whole month as a ZIP** in the same folder
  structure the backup will use.

## Properties — Kian's rulings of 2026-10-03 (dispatch 24)

- **Exclude from reporting:** a toggle in the property edit form. An
  excluded property owes no statements: it leaves the Statement column's
  due and past-due counts, the tile, the home panel and the backup button's
  check. It still has costs, income and a property page; nothing about it
  is deleted. Stored server-side, never on the property document.
- **Unlisted:** a toggle in the property edit form. An unlisted property
  does not appear anywhere on the public site — the homepage, the map, its
  own page, the property API, the sitemap. It stays fully usable inside:
  the admin, the cleaner app, availability, reporting. It is unreadable by
  the public, Firestore rules included, without breaking listed ones.

## Releases — Kian's ruling of 2026-10-03

- **When a commit changes `firestore.rules` or `storage.rules`, deploying
  them is part of releasing that commit, and the dispatch report says so.**
  No rules change sits undeployed.

## Dispatch 26 — Kian's rulings of 2026-10-03

- **The calendar link:** strip `icalUrl` from every public response, page
  and payload. Deny browser reads of the properties collection entirely in
  `firestore.rules`, since no browser reads it any more. Change no property
  document.
- **The Fund page: take it offline until counsel has read it.** Remove it
  from the site and every link to it. Keep its content in the repo, unused.
  A visitor to /fund sees the site's not-found page.
- **The fee base: no default.** The fee base starts empty on every new
  statement. A statement cannot be finished while it has a fee rate and no
  base. Drafts already saved keep what they hold.
- **The five receipt photos** restored into `receipts-restored/` were
  Kian's test receipts and were deleted on his instruction on 2026-10-04.

## Permission checks — Kian's ruling of 2026-10-04

- **When a permission check blocks an action, it is retried only after Kian
  explicitly approves that action.** "Continue" after an error is not
  approval.

## Income — Kian's rulings of 2026-10-04 (dispatch 27)

- **An Income page in the admin, beside Costs: the one place income comes in
  for all properties.** Upload: the monthly Airbnb CSV, built so other
  channels can be added later as other upload types. To review: proposed
  lines, accepted, edited or rejected by an admin, one at a time or a
  property's together. By property: each property's accepted income for the
  month, linking to its property page. No charts in this version.
- **Gaps, shown without anyone looking for them:** titles not linked to a
  property; properties with check-ins in the month on their calendar but no
  income; linked titles missing from the month's file.
- **The Income page and the property page's Income tab read the same lines.
  Nothing is copied between them.**
- **The reading proposes; an admin confirms.** Nothing reaches an owner's
  statement until an admin accepts it, as with a cleaner's receipt. Accepted
  lines become ordinary income lines. A finished statement is never touched.
- **CSV only, read exactly with no AI.** No PDF, image or AI path.
- **Income belongs to the month Airbnb paid it out — the row's Date, Toronto
  calendar.** Not the stay's start: long stays are paid in monthly
  instalments, each row carrying the whole stay's dates.
- **The amount on a line is the Amount column, what Airbnb paid.** Gross,
  service fee and cleaning fee are stored as evidence, not printed. An amount
  is never filled from the property's nightly price.
- **Lines:** a reservation reads "Revenue - Sep 9–13, 2026". A line whose
  stay runs outside the upload's month shows its payout date: "Revenue - Apr
  29–Dec 31, 2026 (paid Sep 30)"; stays inside the month print without it.
  Adjustment, Resolution Adjustment and Resolution Payout are their own
  lines, signed, labelled with their type and the stay's dates. Payout rows
  are never lines: they are used only to check the file adds up, and the
  destination in their Details column is never stored.
- **Matching:** each Airbnb title is linked to one Nubnb property by an
  admin, once, and remembered. An unlinked title is listed with its rows and
  total, never dropped. A title whose link exists but which no longer appears
  in a new file is shown, so a renamed listing is noticed. Twin Bed Studio,
  Private Lakeside Cottage and Spacious 3 Bedroom Suite Bayview & Sheppard
  stay unlinked until an admin links them.
- **Duplicates:** a booking's confirmation code is not unique — instalments
  share it. A line is the same line only if confirmation code, payout date,
  type and amount all match. The same stay uploaded twice is caught and not
  proposed twice.
- **Stored:** dates, amount, type, confirmation code, listing title, the file
  it came from. Never the guest's name, never a payout destination, no phone
  numbers, no reservation links. Airbnb remitted tax is stored per row for a
  later tax rule; it is not a line. No tax lines, no fee, no cleaning counts.
- **The uploaded CSV is kept privately as evidence, like a receipt, with its
  Guest and Details columns blanked, plus the original file's SHA-256.**

## Property form — Kian's rulings of 2026-10-10 (dispatch 29)

- **The offers editor lists the property's own stored categories plus the
  standard ones. "Home safety" replaces "Safety" in the standard list.**
- **"Not included" is not picked; it follows availability. Unticking an item
  moves it there; ticking moves it back.**
- **Counts such as parking spaces stay in the item's name.**
- **Unticking an offer drops its star, as deleting does.**

## Property pages — Kian's rulings of 2026-10-10 (dispatch 30)

- **Creating and editing a property happen on their own pages, not in a
  pop-up.**
- **The admin uses no native browser controls on these pages: no native
  selects, date or file pickers, checkboxes, validation bubbles or confirm
  dialogs. Every control is Nubnb's own, in the admin's design language.**

## Production reset — Kian's ruling of 2026-10-12 (dispatch 32)

- **Production reset of 2026-10-12: all cost, income and statement data
  recorded before this date was test data and was cleared. Properties and
  their settings were kept.**

## Safe to finish — Kian's rulings of 2026-10-12 (dispatch 34)

- **Each check at Finish warns and asks for one extra confirmation. Only a
  statement with no Report For name is refused.**
- **A property with drafts, statements, accepted income, title links or
  cost entries cannot be deleted; the page points to Unlisted and Exclude
  from reporting.**
- **A duplicate Airbnb listing or calendar link is refused on create and
  warned about on save.**
- **The statement PDF prints the property and the month at the top.**
- **Finish, Correct and Delete on the property page use Nubnb's own
  dialogs, no native browser controls.**
- **Unseen automatic approvals warn only.**
- **Finish may show the month's Airbnb checkouts beside a missing cleaning
  line, as a count, never a charge.**

## Admin dialogs, the fee and deletions — Kian's rulings of 2026-10-12 (dispatch 34)

- **No native browser dialogs anywhere in the admin.** The property list's
  Delete uses Nubnb's own dialog, not the browser's confirm.
- **A $0.00 fee does not print on the statement PDF.**
- **Records the admin cannot delete may be deleted by exact document ID
  after an export, never by pattern.** (K13)

## Corrections — Kian's rulings of 2026-10-12 (dispatch 35)

- **When an older statement is redone after a later one printed an
  adjustment for a change, the redone statement prints only what is left
  after that adjustment. A correction is counted once.**
- **A change made after a statement was finished shows on the next month's
  statement, never on an earlier month finished later.**
- **A carried balance is a link to the statement it came from. If that
  statement is corrected or deleted, the difference appears as an
  adjustment line on the next open statement. An uncarried debt keeps
  being offered until a statement carries it.**
- **The delete and correct confirmations name any later statement that
  adjusted or carried from this one.**
- **A redone month prints what it first charged; any change after the
  later statement goes to the next month.** Kian's confirmation of
  2026-10-12.

## Office costs, empty months and Airbnb titles — Kian's rulings of 2026-10-12 (dispatch 36)

- **An office cost belongs to a month the admin picks, defaulting to the
  month on screen. A cost for a month already finished goes on the next
  statement, and the notice names it.**
- **Empty months can be finished together from the Statements panel.**
  Each property still gets its own statement, PDF and reference, the
  reference suggested from its last one. It refuses while any Airbnb title
  in that month's file is neither linked nor set aside.
- **An Airbnb title can be marked "not a Nubnb property".** It stays listed
  and marked, leaves the gaps count, and its lines are rejected. This
  amends "never dropped" and "stays unlinked until an admin links it".
- **An empty month finishes without needing a note on the owner's PDF.**
- **An office cost prints the month it belongs to, with the day it was
  logged in brackets: "Sep 2026 (logged Oct 12)".**
- **The ledger's Excel and PDF exports place costs by the same month rule
  as statements.**

## The month's money — Kian's rulings of 2026-10-13 (dispatch 37A)

- **Every page showing a property-month's figures reads them through the
  one calculation. No page computes its own.**
- **Airbnb claw-backs count as less revenue, never as expenses. The fee
  base is what Airbnb actually paid.** (M1)
- **A month whose only money is a logged cleaning or a cash payment is
  owed a statement.** (M2)

## Cleanings — Kian's rulings of 2026-10-13 (dispatch 37B)

- **Each cleaner has one default rate. A cleaning's amount starts from the
  amount that cleaner was last paid for that property, or their default if
  none, and the admin can change it freely. No per-property rate table, no
  dated rates.**
- **Admins log every cleaning by hand: cleaner, property, date, amount, an
  optional note. No list of bookings or checkouts to tick; no link between
  cleanings and bookings.**
- **On the owner's statement, a month's cleanings print as one line,
  "Expense - Cleaning", with the total. The ledger lists each cleaning.**
- **The cleaner is never named on anything an owner receives.**
- **A cleaning logged after its month's statement is finished goes on the
  next open statement, labelled with its month. A cleaning changed or
  removed after printing is adjusted on the next month's statement — the
  same rules costs follow.**
- **Cleanings are a tab inside the Costs page.**
- **A cleaning is also the cleaner's earnings record.**
- **Finish keeps its warning when a month has Airbnb checkouts but no
  cleaning logged — a count only.**

## Airbnb files — Kian's rulings of 2026-10-13 (dispatch 37C)

- **Accepted Airbnb lines are read where they are stored, never copied into
  the month's draft. They still print as ordinary lines; an edit changes the
  line itself; a line on a finished statement is locked.** (M10)
- **A line accepted for a month already finished goes on the next open
  statement, with its date printed.** (M11)
- **Each property holds one active Airbnb title, set on its edit page;
  previous titles are kept so older files still match. The property save
  never writes it. The Income page's Link stays as a second way to set the
  same title.**
- **A title linked to the wrong property can move while none of its lines is
  on a finished statement; its unfinished accepted lines go back for
  review.** (M13)
- **A renamed title is suggested from the evidence, never applied without an
  admin.** (M14)
- **Two identical rows in one file are two payments.**
- **Row types Nubnb does not recognise are kept with their property and shown
  as needing a decision, never dropped or set aside silently.**
- **Statement lines from files print by stay date, newest first.**
- **Correcting a month returns a late line to it; a printed line changes only
  by correcting its statement.** Kian's confirmation of 2026-10-13.
- **Deduction wording stays as is; uploads and title links cannot be
  deleted; no missing-instalment flag.** Kian's ruling of 2026-10-13.
- **A title is listed as "not in this month's file" only for months after it
  became the property's active title.** Kian's ruling of 2026-10-13.

## Admin accounts — Kian's rulings of 2026-10-13 (dispatch 38)

- **One main admin, Kian, adds and removes admins and sets their level.**
  Two levels to start: main admin and admin.
- **Every admin action records which admin did it, from now on. Records made
  before keep "admin".**
- **Admin PINs are 6 digits.**
- **Sessions are signed with their own secret, no longer the PIN.** This
  retires the accepted risk that the PIN doubles as the signing key.
- **PIN boxes mask their digits.** Kian's ruling of 2026-10-13, after the
  first report.
- **A main admin cannot be removed, demoted or given a new PIN by anyone but
  themselves.** Kian's ruling of 2026-10-13, after the first report.

## Admin sign-in — Kian's rulings of 2026-10-13 (evening)

These replace dispatch 38's sign-in rulings: each admin signing in with their
own PIN after typing their name, five wrong tries locking that PIN, and
today's shared PIN being the main admin's until Kian changes it.

- **Admins sign in with their PIN only. No name is typed. The PIN identifies
  the admin.**
- **Every admin PIN is unique. The main admin sets an admin's name when
  adding them; the admin can change their own name later (Change name,
  beside Change PIN). Names stay unique.**
- **Five wrong PINs from one connection lock sign-in from that connection for
  15 minutes.** The main admin can lift a lock on the Admins page. Store the
  connection only as a keyed hash, never the address itself. Rate limiting
  stays ruled in for admin sign-in only.
- **The shared PIN (ADMIN_PIN) stays only as the recovery script's PIN.**

## Admin PINs — Kian's rulings of 2026-10-13 (night)

These replace the evening rulings they change: PINs generated by Nubnb and
shown once, and a sign-in with the shared PIN giving a generated PIN.

- **The main admin sets each admin's PIN when adding them, and can change any
  ordinary admin's PIN. Nubnb no longer generates PINs. An admin can still
  change their own PIN.**
- **Main admins can see every admin's PIN, their own included, on the Admins
  page. PINs are stored readably.**
- **Admin PINs stay six digits.**
- **PINs stay unique, sign-in stays PIN only, and the connection lock
  stays.**
- **The Add an admin dialog opens on Admin, not Main admin.**

## Admin header — Kian's ruling of 2026-10-13 (evening)

- **Below 1400 px wide, the admin header's section links sit on their own
  row under the brand and actions, on every admin page.**
