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
- **Verification never acts as a real admin.** Test admins are `__TEST__`
  accounts, created and removed as before; a real admin's account is never
  used, read-only or not. Kian's ruling of 2026-10-15.
- **Verification never writes into a month or a property an admin may be
  working.** Test income, costs and statements go on an Unlisted `__TEST__`
  property in a month at least two years ahead. Kian's ruling of 2026-10-18.

## Accepted state — do not re-raise

- 14 delisted listings.
- Empty house rules on older properties.
- `priceInfo.weekly` / `priceInfo.monthly` stored but unused.
- 3 divergent prices.
- Rate limiting disabled, pending Upstash.

## Ruled out — do not propose again

- **Upstash, Sentry, rate limiting, analytics.** Ruled out by Kian. Rate
  limiting is ruled in for admin sign-in (dispatch 38, below) and the
  cleaner door (cleaning schedule, 2026-10-14 evening, below).

## Accepted risks

- **No rate limiting in production**, except admin sign-in (dispatch 38) and
  the cleaner door (2026-10-14 evening).
- **No error monitoring.**
- **No analytics.**
- **Cleaner codes are 4 digits.** 10,000 combinations; the lock (2026-10-14
  evening) slows guessing from one connection without stopping it, so the
  cleaner door can be brute-forced. A guessed code can submit cost entries
  under another cleaner's name, where receipts and admin approval remain
  required, and it can mark that cleaner's jobs cleaned.
- **Cleaner and handyman codes may be easy codes (all one digit, or a straight run of digits) when typed; a
  guesser tries those first.** The cleaner door's lock slows guessing, and a
  guessed code can mark that cleaner's jobs cleaned.
- **Cleaner codes are stored readably**, by Kian's ruling (2026-09-28): any
  admin can see and change any cleaner's code. A code is its `cleaner_codes`
  document ID and sits on the cleaner's document, so a copy of the database
  — every `./backups/` export included — exposes every cleaner code, current
  and replaced.
- **Admin PINs are stored readably**, by Kian's ruling (2026-10-13, night):
  any copy of the database — every `./backups/` export included — holds every
  admin PIN, and a main admin can act as any admin.
- **"Amir and Bahareh codes should not be changed"** — Kian's ruling of
  2026-10-19. Their current admin PINs appear in the public repository's
  history.

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
  acceptable; a slow search on a phone call is not. **Hourly.** The schedule
  and "Hourly" are replaced by Kian's ruling of 2026-10-14 (night): no
  scheduled job (Calendar refresh, below).
- **Schedule it on Firebase, not Vercel** — the Vercel allowance is shared
  with other projects. Replaced by Kian's ruling of 2026-10-14 (night): no
  scheduled job (Calendar refresh, below).
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

  Replaced by Kian's rulings of 2026-10-17 (Admin home, below): Statements
  due, Costs to review, New leads, Turnovers in the next 2 days; the units
  count moves to the table's header.

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
  is unchanged. The reserved list is replaced by Kian's ruling of
  2026-10-17: cleaner and handyman codes may be easy codes (Codes and PINs,
  below).
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
  dated rates.** Replaced by Kian's ruling of 2026-10-19 (Cleaning prices,
  below): the amount starts from the property's preset, and the default rate
  is no longer used.
- **Admins log every cleaning by hand: cleaner, property, date, amount, an
  optional note. No list of bookings or checkouts to tick.** Its "no link
  between cleanings and bookings" is replaced: jobs link cleanings to
  bookings (Cleaning schedule, 2026-10-14 evening).
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
  stays ruled in for admin sign-in only (and, since 2026-10-14 evening, the
  cleaner door).
- **The shared PIN (ADMIN_PIN) stays only as the recovery script's PIN.**

## Admin PINs — Kian's rulings of 2026-10-13 (night)

These replace the evening rulings they change: PINs generated by Nubnb and
shown once, and a sign-in with the shared PIN giving a generated PIN.

- **The main admin sets each admin's PIN when adding them, and can change any
  ordinary admin's PIN. Nubnb no longer generates PINs. An admin can still
  change their own PIN.**
- **Main admins can see every admin's PIN, their own included, on the Admins
  page. PINs are stored readably.**
- **PINs stay unique, sign-in stays PIN only, and the connection lock
  stays.**
- **The Add an admin dialog opens on Admin, not Main admin.**

## Admin PINs and cleaner codes — Kian's rulings of 2026-10-13 (late night)

These replace the rulings they change: six-digit admin PINs.

- **Admin PINs are four digits.**
- **No admin PIN may equal any cleaner code ever issued, current or
  retired, and no cleaner code may be issued or changed to any admin PIN.
  Both doors check the same index.**
- **The connection lock stays (five wrong PINs, 15 minutes). Twenty wrong
  PINs from one connection in a Toronto day lock it until a main admin
  lifts it.**
- **Everything else from tonight stands: main admins set and see every PIN,
  sign-in by PIN alone, unique PINs, Admin as the default level.**
- **The "too easy" list for four digits is the one cleaner codes already
  use, and ADMIN_PIN stays refused as any admin's own PIN.** Cleaner codes
  no longer refuse that list, by Kian's ruling of 2026-10-17 (Codes and
  PINs, below); admin PINs still do.
- **Kian's account: the recovery script puts him on the shared PIN, and Set
  your PIN takes four digits.**

## Admin header — Kian's ruling of 2026-10-13 (evening)

- **Below 1400 px wide, the admin header's section links sit on their own
  row under the brand and actions, on every admin page.** Replaced by Kian's
  rulings of 2026-10-17: the navigation is a left-hand column (Admin home,
  below).

## Admin navigation — Kian's ruling of 2026-10-15

- **The admin navigation bar does not contain a link to the live public
  site. The buttons specific to each page — "Add Property", "Add team
  member" and the like — are not part of the navigation; they are part of
  the page they belong to.**

## Cleaning schedule — Kian's rulings of 2026-10-14 (phase 1)

- **A job is one property's turnover, created automatically two days before
  an Airbnb reservation's checkout date, from the property's calendar
  copies. Only reservations create jobs, never owner blocks. Properties
  without a calendar link get no jobs.**
- **Admins assign one or more active cleaners to a job.**
- **In the cleaner app, a cleaner's assigned jobs come first, soonest first,
  above everything else.** Its home screen shows today's and tomorrow's jobs,
  by Kian's ruling of 2026-10-16 (Cleaner app, below).
- **"Mark cleaned" on a job, by a cleaner assigned to it, from the checkout
  day on, creates a cleaning record (dispatch 37B's) at once, with no admin
  confirmation. The cleaner never types the amount; it is 37B's rule (last
  paid for that property, else their default rate). With neither, the job
  is done and the cleaning waits for an admin to type its amount.** The
  amount rule is replaced by Kian's ruling of 2026-10-19 (Cleaning prices,
  below): the property's preset by the stay, none with two or more cleaners.
- **With several cleaners on one job, each marks their own; the owner is
  charged what the cleaners are paid, added up (37B's one
  "Expense - Cleaning" line already does this).**
- **A cleaner can undo their own Mark cleaned until that month's statement
  is finished. After that, admins change or remove it under 37B's rules.**
- **No proof of cleaning is required.**
- **A job whose reservation disappears or moves is marked "booking
  changed", never deleted.**

## Cleaning schedule — Kian's rulings of 2026-10-14 (evening)

- **The plan's recommendations 1–4 are accepted: same dates under a new ID
  keep the job; a cleaning's day is the checkout day; Undo lasts until a
  finished statement prints the cleaning; until the function is deployed,
  jobs come from Refresh now only.**
- **Jobs link cleanings to bookings; this replaces 37B's "no link"
  ruling.**
- **The cleaner door gets the admin door's lock: five wrong codes from one
  connection lock sign-in for 15 minutes; twenty in a Toronto day lock it
  until an admin lifts it from the Team page.**
- **The hourly calendar copy deploys as the existing Cloud Function, with
  the job sync inside it.** Replaced by Kian's ruling of 2026-10-14 (night):
  no scheduled job (Calendar refresh, below).
- **The developer's own choices in §9 of the plan are accepted unless one
  changes money, a statement or what an owner receives; any such is listed
  for Kian first.** His answers on the four listed:
  - **Undo deletes the cleaning; the job's history keeps who marked it,
    when, the cleaning's ID and its amount.**
  - **A booking-changed job cannot be marked cleaned. A job that changes
    after it was marked keeps its cleaning, charged as usual, and reads
    "changed after it was marked" for an admin to decide.**
  - **The cleaner's job list reaches 45 days back; an older unprinted
    cleaning is changed or removed by admins under 37B.**
  - **A cleaning with no amount is pending: not charged, and counted by
    Finish's pending warning. If its amount is typed after its month is
    finished, it goes on the next open statement, labelled with its
    month.**

## Cleaning schedule — Kian's rulings of 2026-10-14 (night)

- **A job's cleaning keeps its cleaner** (the developer's choice 1,
  accepted).
- **When an admin deletes a job's cleaning, the job keeps the mark as
  "removed by the office", and that cleaner cannot mark it again. An admin
  can reopen it for them from the Schedule page, recorded in the job's
  history.** This replaces the developer's choice 2.
- **The cleaner-codes risk wording is accepted as written.**

## Calendar refresh — Kian's ruling of 2026-10-14 (night)

This replaces the ruling that the hourly calendar copy deploys as a Cloud
Function.

- **No scheduled job. The calendar copy and the cleaning jobs refresh:**
  - **in the background, on the first admin page opened or the first
    cleaner app opened each Toronto day, never delaying the page;**
  - **when an admin presses Refresh calendars, as now.**
- **Only one refresh runs at a time; a second trigger while one runs does
  nothing.**
- **The Schedule page and the Availability page say when the calendars were
  last read, in amber past 24 hours.**
- **The scheduled Cloud Function and its configuration are removed from the
  repo. Nothing in Google Cloud changes: the APIs stay off.**
- Extended by Kian's ruling R1 of 2026-10-19 (Schedule, round 1, below): the
  Schedule and a cleaner's app also start the same refresh when the calendar
  copy is more than 3 hours old.

## Team pay — Kian's rulings of 2026-10-15

Cleaning schedule phase 2: pay, on the Team page.

1. **Owed to a team member = their cleanings with an amount + their
   approved receipts + their approved handyman work. A receipt an admin
   marks "paid with Nubnb's card" is not owed.** [ruling 1]
2. **Payments are recorded by any admin: amount, date, method (e-transfer,
   cash, other), optional note, and the admin who recorded it.**
3. **No pay periods: each person has a running balance (owed minus paid).
   It may go negative after a change, shown as overpaid.** [ruling 2]
4. **Any admin can delete a payment after a confirmation naming it; the
   person's history keeps it, with who deleted it.** [ruling 3]
5. **On the Team page each person's row shows Earned, Paid and Balance;
   opening them lists every item and payment by date, with a date
   filter.**
6. **In the cleaner app, each person sees their own Earned, Paid and
   Balance, and nobody else's.** Replaced by Kian's ruling of 2026-10-16:
   the cleaner app shows no pay (Cleaner app, below).
7. **Nothing here changes statements or what owners receive.**

Kian's rulings of 2026-10-15, added after the design report:

- **A cleaning, receipt or work entry dated on or before a payment to its
  person cannot be deleted; it can be removed. The refusal says so and
  names the payment.**
- **A team member whose balance is not zero cannot be deleted; the refusal
  names the balance and says to deactivate instead.**
- **TEAM-PAY-PLAN.md is accepted as designed, including the developer's
  choices in its §7 unless one changes statements or what owners receive;
  any such is listed for Kian first.**

## Property list columns and direct payments — Kian's rulings of 2026-10-15

On the admin home's property list, and PROPERTY-LIST-COLUMNS-PLAN.md:

- **The property list drops Location, Type and Beds. In their place: an
  income tracking status (for cash, the cash collection) and a cleaning
  status.**
- **Any admin can receive a direct payment and record it. Direct payments
  are anything paid outside Airbnb.**
- **Part A (the two columns) ships first; part B (direct payments) after
  it.**
- **A direct payment prints with its method's word ("Cash - Monthly stay -
  received Oct 3"). The payer is never printed.**
- **The revenue figure beside the fee base, and Finish's base check, count
  direct income. The base stays typed.**
- **Money received for a month already finished goes on the next open
  statement with its day printed, as Airbnb lines do.**
- **Monthly periods only. A part payment goes to the oldest unpaid month
  first, changeable; an overpayment waits for the next month.**
- **A payment printed on a finished statement is locked and changes only
  by correcting that statement. An unprinted one is removed (kept, struck
  through, out of totals), never deleted.**
- **B is built; no direct short stay is recorded until Kian confirms tax
  treatment with his accountant.**
- **PROPERTY-LIST-COLUMNS-PLAN.md's §7 choices are accepted.**
- **The short-stay threshold is 30 nights, not 28, until Kian's accountant
  confirms otherwise.** Kian's ruling of 2026-10-15, after the part B report.
- **The developer's other choices in the part B report are accepted.**

## Property names — Kian's rulings of 2026-10-15 (evening)

- **"All the internal lists should not have airbnb as title (addresses, the
  cleaner names should be on the listing)."** A property's cleaner-facing
  name, usually its address, is its name on every admin list.
- **Availability and Leads also show the public title as a small grey line
  under it, because renters ask about a listing by that title. Search
  everywhere matches both. The property page and its edit page are headed by
  the address, with the public title under it.**
- **What owners receive switches to the address too: new statements, the
  costs ledger's PDF and Excel, and the backup folders. A finished statement
  keeps the name it printed.**
- Dispatch 21's rulings stand: a property without a cleaner-facing name falls
  back to its public title, and the public site never sees the name.

## Cleaner app — Kian's rulings of 2026-10-16

1. **The cleaner app shows no pay: no earned, paid or balance figures.**
   This replaces Team pay ruling 6. The admin's Team pay is unchanged.
2. **The cleaner app uses Manrope only; Playfair Display is removed from
   it.** The public site is unchanged. **The Playfair preload stays**, by
   Kian's decision of 2026-10-17: the shared root layout still preloads it on
   every page, the cleaner app's included.
3. **Home screen: today's and tomorrow's jobs with Mark cleaned, then one
   "Add a receipt" button (handymen: "Add work"). No property list on the
   home screen.** "No property list on the home screen" is replaced by
   Kian's ruling of 2026-10-17: the home lists every unit (below).
4. **Adding a receipt starts with the camera. The reading runs while the
   cleaner continues. One screen then shows the property, the items and the
   tax, editable, with Send.**
5. **The property is prefilled: the job marked cleaned that day, else the
   soonest job assigned today, else nothing (search, recent properties
   first). It is shown in bold above Send, with Change.**
6. **A cleaned job reads "Cleaned · Undo" with "Add a receipt for this
   unit".**
7. **"History" replaces "My receipts": jobs done and receipts sent, with
   status and any rejection reason, and no pay.**

## Cleaner app — Kian's rulings of 2026-10-17

1. **The cleaner app's home lists every unit under the cleaner's jobs:
   "All units", searchable, the cleaner's recent units first. Tapping a unit
   starts a receipt for it. Mark cleaned stays only on jobs the cleaner is
   assigned to. Handymen: tapping a unit starts work for it.**
2. **The cleaner app takes the public site's look while staying light:**
   - **each unit and job card shows the property's cover photo, rounded as
     on the public site's cards, using the stored small copies (never full
     images);**
   - **the public site's brand blue for badges and its dark navy for
     buttons;**
   - **the NUBNB wordmark as the public header sets it;**
   - **Manrope only, white background.**

   **Job cards get badges: Today, Tomorrow, Same-day turnover, Cleaned.**

Kian's review of 2026-10-17:
- **The developer's choices in CLEANER-COSTS-DESIGN.md §50.2 are
  accepted.**

## Job sync — Kian's ruling of 2026-10-17

- **The sync judges a property's jobs only when that property's calendar
  was read in this run. A property missing from the run (not read, failed,
  timed out, or absent from a partial copy) keeps its jobs exactly as they
  are. "Calendar removed" and "property deleted" are recorded only when that
  is known from the property itself.**

## Codes and PINs — Kian's rulings of 2026-10-17

These replace what they change: the reserved list for cleaner codes (dispatch
23H) and cleaner codes using the "too easy" list (2026-10-13, late night).

1. **Cleaner and handyman codes may be easy codes (all same digits, straight
   runs): the "too easy" refusal is removed for them.**
2. **An admin PIN no admin holds any more may be set again.**
3. **Kept: admin PINs refuse the easy list; no admin PIN equals any cleaner
   code ever issued; no two accounts share a code or PIN.**
4. **Every refusal that remains says why in one plain line.**

Kian's review of 2026-10-17:
- **The developer's three decisions of 2026-10-17 on codes and PINs are
  accepted:** a code chosen at random still skips easy codes; an admin
  choosing their own PIN is told whether another admin or a cleaner code
  holds it; easy cleaner codes are an accepted risk (Accepted risks, above).

## Admin home — Kian's rulings of 2026-10-17

These replace the four tiles of 2026-10-02 and the header row of 2026-10-13
(evening).

1. **Admin navigation moves to a left-hand column on every admin page,
   grouped: Operations (Properties, Schedule, Availability), Money (Costs,
   Income), People (Team, Leads, Admins); the admin's name and menu at its
   foot. Built so a section can take sub-pages later.**
2. **Every admin page shows a small "Calendars read <time>" tag with a
   Refresh button that refreshes all calendars and jobs (the existing
   refresh, with its one-run-at-a-time rule). Amber past 24 hours, red past
   48.**
3. **Home tiles: Statements due (blocked · ready · finished, counting due
   and past due); Costs to review; New leads; Turnovers in the next 2 days
   (with how many need a cleaner). The units count moves to the table's
   header.**
4. **Property rows: Price / Night and Open go. A click on the row opens the
   property page; Edit and Delete stay as icons. Public prices are unchanged
   everywhere else.**
5. **Filters: Type and Bedrooms go. Above the table, one row of chips with
   counts that filter the list: Needs attention, Statements blocked,
   Statements ready, Airbnb lines to review, Needs a cleaner, Calendar not
   read, Direct overdue. Search and City stay. Sort: Needs attention
   (default), Next checkout, Address.** Kian's ruling R3 of 2026-10-19 adds
   "Not marked" (Schedule, round 1, below).
6. **Each row has a Next step: the single most pressing action, linking to
   where it's done (Add Report For name, Finish <month>, Assign a cleaner
   for <day>, Review n Airbnb lines, Calendar not read, Record direct
   payment). "Up to date" when nothing is needed. A statement is "blocked"
   when Finish would refuse it.** Kian's ruling R3 of 2026-10-19 adds "Not
   marked" as a Next step (Schedule, round 1, below).
7. **The Statement, Income and Cleaning cells stay, quiet unless they need
   something. A property whose calendar failed in the last refresh, or has
   no link, reads "Calendar not read", never "No turnover".**

Kian's review of 2026-10-17:
- **The left navigation shows icons only below 1440 px wide, each with its
  name on hover and focus; full labels at 1440 and up.**
- **The design note in CLEANER-COSTS-DESIGN.md §53 is accepted.**

## Property page — Kian's rulings of 2026-10-17 (the audit)

- **K3. Finish warns when the revenue share is below zero.**
- **K4. A "Use what Airbnb paid" button beside the fee base fills it on
  click; the base never fills itself.**
- **K5. Each property may have a reference stem; a new statement's
  reference is suggested as <Mon>-<stem>.**
- **K6. Each property may have a default fee rate.**
- **K2. September cleanings are logged during October and print on
  October's statements as late cleanings; Finish's "No cleaning line"
  warning for September is expected.** Kian to strike if cleanings are not
  charged.

## Income page — Kian's rulings of 2026-10-17 (the audit)

- **K1. A month's routine Airbnb lines may be accepted in one confirmation
  that names the number of lines, properties and the total. Held back for
  a decision one by one: negative amounts; stays that began more than a
  month before the file's month; unknown row types; possible duplicates;
  properties that owe no statement; properties whose month would go below
  zero. Accept all per property stays.** This amends dispatch 27's "one
  at a time or a property's together".
- **K2. Each property with Airbnb bookings is either linked to a title
  from an uploaded file or marked "not paid through Nubnb's files" by an
  admin. The page lists unmarked untitled properties apart, and Finish
  warns on them.**

## Costs page — Kian's rulings of 2026-10-18 (round 1)

- **K1. A whole-month ledger (page, PDF, Excel) adds a section, "On this
  month's statement from earlier months", listing late costs and adjustments
  with the month each belongs to. Partial date ranges stay as they are.**
- **K2. Finish keeps warning and never refuses. Its pending warning names
  cleanings with no amount separately: "n cleanings have no amount yet; they
  will go on <next month>'s statement once typed."**
- **K5. Remove (don't delete) the cleaning on [the property's address, left
  out: this file is public] of 15 October 2026, marked by a team member since
  deleted.**

## Schedule, round 1 — Kian's rulings of 2026-10-19 (the Schedule audit)

- **R5. A property can have one regular cleaner, set on the property's edit
  page (internal group) and on the Schedule ("Make Ana the regular cleaner
  for this property").**
  - **A server-only field or record, never on the public property document;
    the property save refuses it, as it refuses the cleaner-facing name.**
  - **When the job sync creates a job and the property has an active regular
    cleaner, it assigns them, recorded in the job's history as assigned by
    "regular cleaner" (system actor).**
  - **A deactivated or deleted regular cleaner assigns nobody, and the job
    shows "Needs a cleaner".**
  - **Existing jobs are never changed (no backfill).**
- **R1. Reads on open: when the Schedule or a cleaner's app opens and the
  calendar copy is more than 3 hours old, start the same background refresh
  used for the day's first visit (one run at a time, the same lease). The
  Schedule shows the result when that run finishes, without a manual reload.
  The cleaner app re-reads its jobs once when the run finishes.** This extends
  the first-visit ruling (Calendar refresh, 2026-10-14, night).
- **R2. A booking-changed job on the cleaner's card reads "Cancelled: don't
  go" or "Moved to <day>", with no Mark cleaned. On the Schedule, an admin
  can take a cleaner off a booking-changed job; the server already accepts
  this.**
- **R3. "Not marked" (checkout passed, assigned, not marked cleaned and not
  removed) becomes a Next step on the home, with its own chip and count,
  using the one Next-step rule.**
- **R4 is declined: jobs stay made two days before checkout (Cleaning
  schedule, phase 1, ruling 1).**

Kian's review of 2026-10-19:
- **The home's Cleaning cell follows the Schedule: a job with nobody on it is
  red on its checkout day and after, amber before. One shared rule for both
  pages, not two copies.**
- **Setting a regular cleaner from the Schedule's picker asks first in Nubnb's
  own dialog: "Make <name> the regular cleaner for <property>? New jobs there
  go to <name>." Then it saves, as now. The edit page's tile asks the same way
  if it saves outside the form's Save; if it saves with the form, leave it.**

## Cleaning prices — Kian's ruling of 2026-10-19 (the NuBNB Cleaner Pay Schedule)

- **"Cleaning prices are presets per property, not per cleaner: a short-term
  price for an ordinary turnover and a long-term price after a stay of 28
  nights or more. They are the base for each house; the admin can change any
  cleaning's amount, because it may vary by unit, day or booking."**
- The presets live in a server-only record per property
  (`property_cleaning_prices/{propertyId}`), never on the property document,
  never sent to the cleaner app, owners' files or public pages. They are set
  on the Report For sheet (two columns, and an "Import prices" CSV that saves
  only matched rows on the admin's confirm) and on the property's edit page.
- **The amount rule**, replacing the 2026-10-14 rule "last paid for the
  property, else the cleaner's default rate": a Mark cleaned on a job with
  exactly one cleaner takes the long-term preset when the stay behind the job
  is 28 nights or more, else the short-term preset, and no amount when the
  property has no matching preset; a job with two or more cleaners gives every
  cleaner's cleaning no amount, and the admin types the split; a cleaning
  logged by hand prefills from the same rule. Each cleaning records where its
  amount came from (short-term preset, long-term preset, typed). The cleaner's
  default rate is no longer used anywhere; the stored field stays, and "Set
  rate" is gone from the Team page. Changing a preset never changes an
  existing cleaning. No backfill.
- The pay schedule itself is confidential: the CSV and the PDF are never
  committed. Kian imports the CSV himself after deploy.

Kian's instruction and ruling of 2026-10-19 (the second round):

- **A second cleaner after a mark:** on the Schedule, adding a cleaner to a
  job where another cleaner's mark already created a cleaning with an amount
  asks first in Nubnb's own dialog: "<name>'s cleaning already carries $X
  (<short-term|long-term> preset). With two cleaners, the amounts need
  splitting: edit them on the Cleanings tab." Confirming assigns as today;
  no amount changes by itself.
- **Properties with no preset:** "For unsure rows, we just keep it open as
  input by admin, and we keep that input item as a recommendation for next
  time (based on if it's short term or long term)." The recommendation for a
  property and tier with no preset is the most recent amount an admin typed
  for a cleaning there in that tier, counting only cleanings not removed,
  typed, and from a job with exactly one cleaner or logged by hand; never a
  share from a two-cleaner job. Wherever an admin types a missing amount
  (the Cleanings tab's "Waiting for an amount" rows, and later the Team pay
  view), the field opens prefilled with it, labelled "Last typed for
  <short-term|long-term>: $X"; Enter or Save confirms it; nothing is charged
  until an admin confirms. Mark cleaned and hand-logged cleanings on such a
  property still arrive with no amount: the recommendation is never applied
  automatically and never becomes a preset. A preset for that tier, once
  set, replaces the recommendation completely.

## Team page — Kian's rulings of 2026-10-19 (round 1; the Team page audit)

Build per the 2026-10-19 audit, on top of the cleaning prices per property.

- **Pay from the pay view (the audit's one change, Kian's instruction):** "The
  person's pay view lists their cleanings with no amount at the top, each with
  an amount field, plus 'Save all'. Each field opens prefilled the same way as
  the Cleanings tab: the property's preset for that tier if one exists,
  otherwise 'Last typed for <short-term|long-term>: $X', otherwise empty. A
  two-cleaner share is never prefilled. Nothing is charged until Save or Save
  all. Saving updates Earned and Balance without reloading. Use the same server
  route and history rules as the Cleanings tab."
- **K1.** "Recording a payment while the person has cleanings with no amount,
  or receipts or work waiting for review, asks first in Nubnb's own dialog. The
  dialog names the counts and says the balance doesn't include them. Still
  allowed."
- **K2.** "A payment larger than the current balance asks first: 'This pays $X
  more than <name> is owed. Record it as an advance?' Still allowed."
- **K3.** "Deleting a member is refused while they have any cleaning with no
  amount, or any receipt or work not yet decided, as well as with a nonzero
  balance (existing rule). The refusal names what's outstanding and points to
  Deactivate."
- **K4.** "Deactivating or deleting a member who is regular cleaner for any
  property lists those properties in the same dialog. Each has a picker:
  another active cleaner, or 'Nobody'. Saving applies the replacements
  together with the deactivation or delete, recorded in each property's
  regular-cleaner history. Existing jobs follow Schedule round 1's rules
  unchanged."
- **K5.** "A code change's history entry no longer sends the old or new code to
  the browser. Admins see 'Code changed by <admin> on <day>'. Stored history is
  unchanged: no backfill, and the server strips codes on read."
- **The Team page shows, per person, the properties they're regular cleaner
  for and their count of upcoming jobs (checkout today or later).** Each links
  to the Schedule filtered to that person.

## Availability page — Kian's rulings of 2026-10-19 (round 1; the Availability audit)

Build per the 2026-10-19 audit.

- **K1.** "The stay total includes the cleaning fee and is labelled 'before
  taxes': '<n> nights × $<nightly> + $<fee> cleaning = $<total> before taxes'.
  The fee is priceInfo.cleaningFee; with none, it says 'no cleaning fee set'.
  Each value shown is an admin-set price, never computed beyond that sum.
  Remove the old caption. Add a 'Copy' control that copies that one line."
- **K2.** "Opening the Availability page on a calendar copy more than 3 hours
  old starts the same refresh as R1 (same lease), and the page shows the
  result when it finishes."
- **K3.** "Each 'Not on Airbnb' mark shows its check date ('Not on Airbnb ·
  checked Sep 30'). Don't revive the listing-page check."
- **K4.** "A stay shorter than the property's minimum nights is a near miss
  with the chip 'minimum <n> nights', never a fit."
- **K5.** "Unlisted properties carry a 'Not on the site' mark in search and
  attention results; excluded-from-reporting stays unmarked."
- **Engineering, Kian's instruction:** "Each result row whose calendar copy is
  older than the run, or failed, carries its own 'calendar read <day, time>'
  mark. Search and ranking tables fit at 1440 and 1280; no sideways scroll.
  'Edit' on a result opens that property's edit page directly, not the admin
  home. The page's GET /api/admin/properties (1.66 MB, 118 reads) is replaced
  or narrowed to the fields the page needs, if it can be done without
  touching other pages."

## Security rules (not Kian's rulings; the developer's, 2026-10-19)

The repository is public. These hold until Kian changes them.

- **No code or PIN value in the tree.** Before every commit, `node
  scripts/scan-tree-for-codes.mjs` runs over every tracked file against the
  current cleaner codes and the admin PINs of a fresh export; a commit is
  refused on any hit. A hit is rewritten (a literal as `1_440`, an example as
  a description), never masked in place. Examples in documents name no digits.
- **A code that appeared in Nubnb's public code is never given out.** Every
  code or PIN ever issued whose four digits appear anywhere in the git history
  is on a denylist: the random draw skips it and a typed code is refused with
  "That code has appeared in Nubnb's public code and is never given out."
  The list lives in the server's environment only — `CLEANER_CODE_DENYLIST`,
  HMAC-SHA256 hashes under `CLEANER_SESSION_SECRET`, made by
  `node scripts/code-denylist.mjs` from the history and an export — never in
  the repository or the database. It is rebuilt after any commit that could
  add a code to the history, and after the key is rotated. **The denylist is
  keyed with `CLEANER_SESSION_SECRET`: rotating that secret means regenerating
  `CLEANER_CODE_DENYLIST` before codes can be issued again** (with the list
  set and the key missing, issuing a code fails closed). The same list refuses
  an admin PIN: choosing or setting a PIN on it is refused with the same
  sentence.
