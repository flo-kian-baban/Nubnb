# The financial management engine: findings and plan (dispatch 23, 2026-09-30)

**Status: plan only. Nothing is built.** Part 1 reports what exists, from a
read-only pass over the working tree and the latest Firestore export
(`backups/2026-09-30T21-31-05Z`, 64 documents in 9 collections). Part 2 is
the proposal. Nothing was written to Firestore or Storage, no build was run,
and no export was taken: the export rule applies before a write, and there
was none.

**Revised 2026-10-03 (dispatches 23C and 24):** §2.7, the monthly backup, is
rewritten for what was built since, made accountant-ready, and brought in
line with Kian's rulings of 2026-10-03 (a mirror, a button from the 11th,
owners' folders apart from Nubnb's, no versions, the month as a ZIP). It
replaces what §2.6, §2.8, §2.10, §2.11 and §2.13 say about the backup. The
rest of Part 2 stands as written on 2026-09-30; much of it was since built
differently, as `CLEANER-COSTS-DESIGN.md` §16–§30 record.

**Precondition, as found.** Dispatch 21 is deployed (`107be8f`, then
`98027f8`). The tree is **not** clean: dispatch 22 (availability) sits in it
uncommitted, 13 files changed and the `functions/`, `app/lib/availability/`
and `app/admin/availability/` trees untracked. This plan assumes dispatch 22
lands first, because it reuses two things from it: the `functions/` package
with its predeploy copy, and the admin header's fifth section. If dispatch 22
is discarded instead, this dispatch creates the `functions/` package itself
and the header counts change by one; nothing else in the plan moves.

**The rulings this is built under.** From `CLAUDE.md`: $0 at current
traffic, as little Vercel as possible, prices set by admins and never
computed, no backfills, nothing deleted, verification in raw output. From
the dispatch: the seven rulings below, "no existing Firestore document
modified, nothing ever deleted". Read here as: no document that exists today
is written by this work, every entry keeps its append-only history, and a
finished report is never written again. Two working documents this dispatch
itself creates (a report's draft, and a property's co-owner record) are
saved in place while they are worked on, as `property_cleaner_names` already
is. If Kian reads the ruling more strictly, drafts become append-only, one
document per save, at some cost in reads; §2.13 names it.

---

## Part 1. What exists

### 1.1 The cost entry, its review, the ledger and the exports

**The entry** (`cost_entries/{autoId}`, `CLEANER-COSTS-DESIGN.md` §1c, §11.1,
§13.2) is written once, by `createCostEntry` in one transaction with its
send-once guard and, when the phone had one, its Gemini reading. It holds
`cleanerId` and `cleanerNameAtEntry`, `propertyId` and `propertyNameAtEntry`,
`createdAt`, `purchasedOn`, `note`, `currency: 'CAD'`, `lines[]` (each
`{ name, quantity, lineTotalCents }`, the amount as printed, quantity never
multiplied), `taxCents` on version 2 documents, `receipts[]` (exactly one),
`status`, `statusChangedAt`, `statusReason` and `history[]`. After creation
only the three status fields and `history` ever change, through
`review()` in `server-cost-entries.ts`, which refuses a write unless the
history is the length the page last saw (`seen`, 409 `ENTRY_CHANGED`). The
lines that count are computed on read (`readLinesNow`): the sent lines with
every `line_corrected`, `line_added` and `tax_corrected` event applied.

**Statuses** are `pending | approved | rejected | removed`; every entry is
written `pending`; an admin moves it, from any of the four, with a history
event `{ at, action, from, to, actor, reason }`. The actor is one of two
roles, `admin` (always `{ id: null, name: null }`: one shared PIN) or
`cleaner`. The history words are `created, deactivated, reactivated,
code_changed, submitted, approved, rejected, removed, line_corrected,
line_added, tax_corrected`. Words once written are permanent.

**The queue and the ledger** are two filters over one read
(`GET /api/admin/cost-entries`, the whole collection, no `orderBy`, no
`limit`). The queue is `NEEDS_ATTENTION`: every entry whose status is not
`approved`. A property's ledger is `?property=<id>&status=approved`, with a
date range, totals, an Items tab, and the two exports. Dates are the Toronto
day an entry was sent (`sentDay(createdAt)`); `purchasedOn` is stored but not
used for any period, and today's entries mostly have none.

**The exports.** The Excel file is made in the browser and not recorded. The
PDF is recorded first: `POST /api/admin/cost-reports` recomputes the report on
the server, refuses a stale page (409 `REPORT_CHANGED`), and `create()`s one
`cost_report_exports` document holding, for each entry, its history length
and the three amounts printed. The page then compares every recorded PDF with
the entries as they now stand (`sincePdf`, `entryPdfState`) and marks each
row "in PDF", "changed since PDF", "still in a PDF". The record says a PDF was
made, not that it was sent.

**The people.** `cleaners/{autoId}` holds `name`, `code`, `status`,
`sessionEpoch`, `history`; `cleaner_codes/{code}` is the index that keeps the
four-digit codes unique for ever. The cleaner door is `POST
/api/cleaner/session` (code in, cookie out, path `/api/cleaner`, 12 hours),
and every cleaner route re-reads the cleaner document on each request
(`readSessionCleaner`: `name`, `status`, `sessionEpoch`). There is no role
field anywhere: a cleaner is a document in `cleaners`.

**Production today** (the export of 21:31Z): 46 properties; 2 cleaners (Kian,
Amir), both active with codes; 2 cost entries, both approved by hand, one in
the version 1 shape (Kian's, 8 lines, tax as a line, $110.47) and one in
version 2 (Amir's, 2 lines, `taxCents 181`, $15.71); 2 readings; 2
submissions; 3 recorded PDFs; 1 quota day; 3 contact submissions. Storage
holds the property images plus two receipts.

**What changes for the three new things**, in one place, so the rest of the
plan can refer to it:

| Ruling | On the entry | On the cleaner | Elsewhere |
|---|---|---|---|
| Auto-approve under $200 | New entries may be written `approved` at once, with a second history event whose actor has a new role `system`; a new map `autoApproved` on every new document (`null` when not); a new history word `seen` | nothing | The queue's definition widens (§2.2); the pane, the row and the tiles say "approved automatically" |
| Handymen | A new field `kind: 'receipt' \| 'work'` on every new document (absent means receipt); a work entry has `receipts: []`, one line whose name is the description, `taxCents: null`, and is always `pending` | A new field `role: 'cleaner' \| 'handyman'` on every new document (absent means cleaner); the actor role `handyman` | A JSON route `POST /api/cleaner/work`; the app's second flow; a Kind column and "What was bought / work done" in the ledger, the Excel file and the PDF |
| Monthly reports | nothing on the entry. A finished report records each entry's history length and printed amounts, exactly as a ledger PDF does, so the same comparison marks an entry "changed since the September statement" | nothing | New collections (§2.8), a new admin section, two tiles, one Storage prefix, two functions |

Nothing here touches an existing document. Readers already treat a missing
field as absent, so an entry written before this reads as a receipt entry
with no auto-approval, and a cleaner written before this reads as a cleaner.

### 1.2 What the PDF and Excel writers can do, and whether a live preview can reuse them

Both writers are pure and client-safe, and both already run in the browser:
`app/admin/costs/page.tsx` calls `pdfFor(report)` and `workbookFor(report)`
and hands the bytes to a Blob. No package is involved.

**`app/lib/costs/pdf.ts`** (334 lines) writes PDF 1.4 by hand: Helvetica and
Helvetica-Bold with Adobe's metrics (so text can be measured, right-aligned,
cut with "…" and wrapped), WinAnsi text, US Letter portrait, a repeating
table header, page numbers, a title and creation date in the Info
dictionary. It knows two drawing operations: text and a horizontal rule. Its
helpers (`winAnsi`, `widthOf`, `fitted`, `wrapped`, `literal`, the `Page`
class, `assemble`) are private to the module; the one export is `pdfFor`,
which lays out exactly the cost report.

**`app/lib/costs/xlsx.ts`** (259 lines) writes a workbook as a stored ZIP
(`zip.ts`) of seven XML parts with inline strings, real dates and real
numbers, five cell styles. Its cell and sheet helpers are private; the one
export is `workbookFor`.

**So: a live preview can reuse the PDF writer, and should.** What is needed:

1. Lift the primitives into `app/lib/pdf/core.ts` (metrics, encoding,
   measuring, `Page`, `assemble`) and add one drawing operation the statement
   needs and the ledger PDF does not: a filled rectangle (`re f`), for the
   shaded band behind the recorded cost rows and the box around the closing
   figure. `pdf.ts` then imports the core and keeps `pdfFor` unchanged; the
   new `app/lib/reports/statement-pdf.ts` lays out the statement. The same
   split for `xlsx.ts` into `app/lib/xlsx/core.ts`, if the statement ever
   gets a workbook (§2.12: not in this version).
2. Run the statement writer in the browser on every change, 300 ms after the
   last keystroke, and show the bytes in an `<iframe>` through a Blob URL.
   Every desktop browser renders a PDF inline. Two iframes are kept and
   swapped when the new one has loaded, so the page never flashes blank
   between versions. This is the real document taking shape, not a picture
   of it: the bytes the admin is looking at are the bytes the finish step
   stores, byte for byte, because the finish step runs the same pure
   function on the same frozen inputs (§2.5, "Finishing").
3. Nothing else. No HTML twin to keep in step with the PDF, no PDF renderer
   to add, no server round trip per keystroke.

The alternative, an HTML rendition styled to look like the page, would drift
from the PDF the moment either changed and would need its own layout code.
It is not proposed. Mobile is out of scope for the admin (dispatch 22
ruling), and the inline PDF viewer is the one part of this that a phone
would do badly.

### 1.3 Where the money arithmetic lives, and how income and a fee fit

Every amount is a safe integer of cents and reaches storage by splitting the
typed string, never through a float (`toCents` in `server-cost-entries.ts`:
`"7.98"` → `798`). The only arithmetic anywhere is addition:

| Where | What it adds |
|---|---|
| `readLinesNow` (model.ts) | a line's amounts into `itemsCents`; `itemsCents + taxCents` into `totalCents` |
| `totalsByProperty`, `countedItems`, `buildReport` (costs/report.ts) | entries into period totals, in the browser |
| `recordReportExport` (server-cost-entries.ts) | the same, on the server, to record a PDF |
| `costFigures` (DashboardStats.tsx) | this month's and the pending totals, for the tiles |
| `formatCents`, `decimal` (xlsx.ts), `amountField` (cost-display.tsx) | none: they write cents out as text by integer division |

Nothing multiplies. `quantity` is informational by ruling; the one price on a
property (`nightlyPrice`) is read, never computed. Totals are worked out to
show and never stored, with one exception the rulings created: a recorded
PDF stores the amounts it printed, as evidence of what went out.

**Income and a fee fit without a new kind of arithmetic.** An income row's
amount is typed as dollars and cents and stored as integer cents through the
same `toCents`. The fee is typed the same way. The statement's reconciliation
is three sums and two subtractions: income − costs − fee = payable. It can
be negative (a month where costs exceed income), and the document then says
"owed to Nubnb" rather than "payable to owners". The finished report stores
the four figures it printed, as the ledger PDF record does.

**What would break the rule, and is therefore not proposed:** a fee typed as
a percentage and multiplied out by code. The dispatch says it plainly: code
never multiplies a price. §2.13 puts this to Kian with a recommendation.

### 1.4 Nothing about a property says who its co-owners are

Every one of the 46 property documents has the same 31 fields: `id, slug,
location, currency, bedrooms, beds, bathrooms, guests, propertyTypeTag,
highlights, amenities, terms, coordinates, averageRating, type, price,
priceInfo, googleMapsUrl, offers, reviews, airbnbUrl, coverImage, name,
description, addressDetails, details, icalUrl, totalReviewCount, images,
coverImageStored, imagesStored`. None names an owner, a contact, an email or
a share. The `Property` type (`app/types/property.ts`) has no such field.
The word "owner" occurs in the app only in marketing copy and a comment.
`contact_submissions` holds the renters' leads, not owners. The only
per-property server-side record besides the property itself is the
cleaner-facing name.

So a monthly report addressed to someone has nobody to be addressed to. The
proposal (§2.5, §2.13) adds a server-only per-property record, in the shape
`property_cleaner_names` already takes, with the co-owners' names and,
optionally, their emails; and it says what the document reads when the
record is empty.

### 1.5 Three facts about Google Drive, checked on Google's pages today

The backup (§2.7) depends on them, so they were read rather than assumed:

- **A refresh token from an OAuth consent screen in "Testing" status expires
  in 7 days** (developers.google.com/identity/protocols/oauth2, "Refresh
  token expiration"). One in production status does not expire by age; it
  dies if unused for six months, if the user revokes it, or if that client
  issues more than 100 tokens. The backup uses it every day.
- **The `drive.file` scope is non-sensitive**, "recommended for most use
  cases", and needs only basic verification; it lets an app see and change
  only the files it created (developers.google.com/workspace/drive/api/guides/api-specific-auth).
- **A service account cannot own files in Drive**: "Service accounts don't
  have storage quota and can't own any files. Instead, they must upload files
  and folders into shared drives, or use OAuth 2.0 to upload items on behalf
  of a human user" (developers.google.com/workspace/drive/api/guides/handle-errors,
  under `storageQuotaExceeded`). Shared drives need Google Workspace, which
  is paid. So the backup must act as a person, with that person's one-time
  consent.

---

## Part 2. The proposal

### 2.1 Shape

One new admin section, **Reports**, beside Costs and Cleaners: its home page
is the tracker (§2.6), and each property-month opens as a statement editor
with the document alive on the right (§2.5). Two changes inside Costs: the
queue learns about auto-approved entries and shows who is worth a look
(§2.2), and work entries from handymen sit in the queue, the ledger and the
exports beside receipt entries (§2.3). The cleaner app gains a second flow
for handymen behind the same door. Two scheduled functions on Firebase copy
each closed month to Google Drive and let a failed copy be seen (§2.7). Two
tiles on the admin home. Nothing on the public site changes; no public page
makes a new call.

### 2.2 Auto-approval under $200, and how an admin would notice clustering

**The rule, as built.** In `createCostEntry`, for an entry of `kind:
'receipt'` sent by a `cleaner`, if the sum of the lines plus the tax as sent
is **strictly under 20,000 cents**, the document is created with
`status: 'approved'`, `statusChangedAt: now`, and a history of two events at
the same instant: `submitted` (`to: 'pending'`, actor the cleaner) and
`approved` (`from: 'pending'`, `to: 'approved'`, actor
`{ role: 'system', id: null, name: 'auto-approval' }`, reason
`"Under $200.00: approved automatically"`). The document also carries
`autoApproved: { thresholdCents: 20000, totalCents: <as sent>, at }`, or
`null`, on every new entry, so the rule can change later without confusing
the record of entries approved under the old one. The threshold is a
constant in `LIMITS`, not a setting. Work entries never qualify (§2.3), and
the test is on the kind, not the role, so a later ruling is one line.

**It still appears in the queue.** The queue's `NEEDS_ATTENTION` becomes:
not approved, **or** auto-approved and not yet seen. "Seen" is a new history
word: `POST /api/admin/cost-entries/[id]/seen` appends
`{ action: 'seen', actor: admin }` through the same `review()` transaction,
with `seen` (the history length) as on every review, and changes no status.
The queue shows such entries in their own group at the top, "Approved
automatically, not yet looked at (n)", each row marked **Approved · auto**,
with a **Seen** button on the row and **Mark all n as seen** on the group.
The pane says: "Approved automatically: under $200.00, and no admin has
looked at it. It counts in the ledger now. Correct it, remove it, or mark it
seen." Correct, remove and reject work exactly as on any approved entry;
each takes it out of the group. In the ledger, the PDF and the statement,
an auto-approved entry is an approved entry; the record distinguishes, the
co-owner's document does not (my decision; it is a one-word change if Kian
wants "auto" printed).

**Noticing a cleaner whose entries cluster under the threshold.** The record
only helps if something surfaces it, so three things do, all computed in the
browser from the entries the page already holds (`watchList()` in a new
`app/lib/costs/patterns.ts`, pure, over the last 90 Toronto days, receipt
entries only, rejected and removed ones included because the pattern is in
the sending):

1. **The distribution, per cleaner, in words**, on the Cleaners page and in
   the pane of any entry by that cleaner: "Last 90 days: 14 receipts ·
   under $50: 2 · $50–100: 3 · $100–150: 1 · **$150–200: 7** · $200 and
   over: 1 · approved automatically: 13 of 14". The band just under the
   threshold is always named, whatever it holds.
2. **Same-day splits**: two or more receipts from one cleaner for one
   property on one Toronto day, each under $200, adding up to $200 or more.
   Listed as such: "30 Sep, Loft Plateau: $184.20 + $96.10 = $280.30 in two
   receipts".
3. **A "Worth a look" panel** at the top of the queue, shown only when the
   rule below fires, naming the cleaner, the figures, and a link to the
   queue filtered to that cleaner (a `?cleaner=<id>` filter is added to the
   costs page). The same sentence appears as the detail line of the "Costs
   to review" tile: "2 approved automatically, not yet seen · 1 cleaner
   worth a look".

The rule that fires the panel (mine, two constants): in 90 days, **three or
more** receipts in the $150.00–$199.99 band **and** that band holding **40 %
or more** of the cleaner's receipts (the band is a quarter of the range, so
40 % is a marked lean); **or** two or more same-day split sets. Under five
receipts in 90 days the panel says "too few to judge" and fires on splits
only. None of this blocks anything or writes anything: it is a reading of
the record, and the admin decides. With two entries in production the panel
will say "too few to judge" for some months; that is the honest state.

### 2.3 Handymen

**The same door, an own role.** A handyman is a document in `cleaners` with
`role: 'handyman'`, issued and managed on the same admin page with the same
code model: `POST /api/admin/cleaners` gains `role` (`cleaner` when absent,
for the existing callers), codes come from the one `cleaner_codes` index (a
code is unique across both roles, which one door requires), a code change
and a deactivation work unchanged. The session token is unchanged; the role
is read from the document on every request, where `status` and
`sessionEpoch` already are, so a role can never be carried by a stale
token. The collection keeps its name: renaming it is a backfill. The admin
section is named **Team** in the header, with a Role column and a role
choice on the create row (my decision; "Cleaners" can stay if Kian prefers).

**A work entry** is a `cost_entries` document with `kind: 'work'`. It is
written by a new JSON route, `POST /api/cleaner/work`, body
`{ submissionKey, propertyId, description, price }`: the description NFC,
trimmed, 1–200 characters (`LIMITS.WORK_DESCRIPTION_MAX`; a receipt line's
120 is short for "replaced the kitchen faucet cartridge and resealed the
sink drain"), the price as `"185.00"`, positive, through `toCents`. Stored
as one line `{ name: description, quantity: 1, lineTotalCents }`,
`taxCents: null`, `receipts: []`, `note: null`, `purchasedOn: null`,
`status: 'pending'` always, `autoApproved: null`. The send-once guard, the
in-transaction re-read of the account, and the orphan logging are the
existing ones; there is no upload and no reading. A cleaner's session is
refused on this route, and a handyman's on the receipt and read-receipt
routes (403 `ROLE_MISMATCH`), so neither can log the other kind.

**What the handyman sees.** The same page, `/cleaner`, whose start route now
returns the role. A handyman gets: code → property (same screen, same
cleaner-facing names) → **Work**: "What did you do?" (one text field, 200
characters) and "Price" (`$`, number pad) → Send → Sent. "My work" lists
their own entries with the same statuses as "My receipts". No camera, no
photo, no Gemini, no items. The bar's tag reads "Work" instead of
"Receipts". Item-name suggestions for cleaners are drawn from receipt
entries only, so work descriptions never turn up as items.

**What the admin sees.** In the queue and the ledger a **Work** badge on the
row, "No receipt: handyman work" where the receipt icon would be, and a
Kind filter beside Status. In the pane, "Work done" in place of "Items
bought", the description in full, and the one amount; **Correct** changes
the description or the price as a `line_corrected` event, exactly as a line;
tax can be corrected too (an invoice may carry it). Approve, reject with a
reason the handyman sees, remove: unchanged. In the Excel file, a `Kind`
column and "Logged by" in place of "Cleaner"; in the ledger PDF and the
statement, the column reads "What was bought / work done", and a work row's
description wraps to a second line rather than being cut. Every work entry
needs an admin's approval regardless of amount, as ruled; the queue shows
them beside pending receipts.

**Why one collection, not two** (mine, and expensive to change): the queue,
the ledger, the totals, the exports, the PDF records, the statement and the
backup all read `cost_entries` once. A second collection would double every
one of those paths for a document that differs by two fields. The cost is
that `receipts` is no longer "exactly one" on every document; the readers
already handle an empty array and a missing one.

### 2.4 Income rows

An income row is `{ id, source, label, reference, from, to, amountCents }`:
`id` a UUID the browser makes (for reordering and React); `source` one of
`airbnb | vrbo | private | other` (words permanent; `other` so a new source
never forces a new word); `label` 1–160 characters ("Airbnb payout, stay
12–15 Sep"); `reference` optional, up to 60 characters (a booking code);
`from` and `to` optional `YYYY-MM-DD` (the stay); `amountCents` a non-zero
safe integer, negative for a refund or an adjustment. Rows live **in the
statement's draft** (§2.5) as an array, in the order the admin puts them,
and can be added, edited, reordered and removed freely until the statement
is finished; then they are frozen in the finished report, as the lines of
an entry are frozen in the entry. Nothing prefills an amount: not
`priceInfo.nightly`, not the calendar copy, nothing on the site. The
platform's prices are never used, as ruled.

### 2.5 The monthly report

**What it is.** One document per property per calendar month (Toronto), the
statement a co-owner receives. It reconciles: income, minus costs, minus the
management fee, equals what the co-owner receives. It is written in the
statement editor, with the PDF alive beside the fields, and finished once.

**The document, page by page** (US Letter, the writer of §1.2):

- **Head.** NUBNB · MONTHLY STATEMENT · the property's name · "September
  2026" · "Prepared for" the co-owners' names when the property has them
  (§2.13, decision 4), else "the owners of <property>" · the statement's
  reference (the first six characters of its ID, as an entry's `ref`) ·
  when superseding: "Replaces the statement finished 3 Oct 2026 (ref
  Q7m2Ka). Reason: <reason>."
- **Income.** One row per income row: stay or date · source · description ·
  reference · amount. Then **Total income**.
- **Costs.** Under a caption that sets them apart: "Recorded from receipts
  and work approved in Nubnb's cost ledger. They are shown as recorded and
  cannot be edited here." The rows sit on a light grey band. One row per
  approved entry of the month: date · what was bought / work done · ref ·
  items · tax · total, `*` when corrected, as the ledger PDF prints them.
  Then, when there are any, a sub-group **From earlier months, not
  previously reported** (entries approved late) and a sub-group
  **Adjustments to earlier statements** (an entry an earlier statement
  printed that has since changed or left: its statement's ref, what was
  printed, what it is now, the difference). Then **Total costs**.
- **Management fee.** One line: its label and amount, or "No fee this
  month".
- **Closing figure.** A boxed line: Income − Costs − Fee = **Payable to the
  owners** (or **Balance owed to Nubnb** when negative), each of the four
  figures on its own line above it.
- **Notes to the owners**, when the admin wrote any (up to 1,000
  characters), then the standard notes the ledger PDF carries about
  receipts, items and tax, and "Statement finished 3 Oct 2026, 11:42 a.m.,
  Toronto time · ref Q7m2Ka".
- Every page: the property and month in the running head, "Page n of m".

**On screen: the editor**, `/admin/reports/edit?property=<id>&month=YYYY-MM`,
two columns on a desktop window:

- Left, the fields: **Income** (the rows as a list with a drag handle and
  ↑ ↓ buttons, each row's source as an `AdminSelect`, description,
  reference, stay dates as a `DateRangeField`, amount; **Add row**;
  remove with a confirm when the row has anything typed); **Management
  fee** (label and amount, prefilled from the property's default fee when
  it has one, §2.13 decision 3); **Costs** (read-only: the month's approved
  entries, each with **Open entry**, which lands on
  `/admin/costs?property=&status=approved&entry=<id>` where the receipt
  shows; the late entries and adjustments, marked; and a warning row when
  pending entries fall in the month: "3 entries sent in September are
  pending. They are not in this statement. Review them first." with a link
  to the queue filtered to the property); **Notes to the owners**; and
  **Finish and freeze…**.
- Right, the PDF, regenerated 300 ms after the last change, double-buffered
  so it never flashes (§1.2). The two kinds of row are told apart on both
  sides: editable rows are white fields with controls; recorded rows are
  the grey band with a lock glyph and "recorded" in the margin, and the
  same grey band in the PDF.
- The head of the page says whose statement it is and its state: "Draft ·
  saved 11:41:52" / "Saving…" / "Not saved: <reason>" / "Finished 3 Oct
  2026 · ref Q7m2Ka · Download PDF · Correct this statement…".

**The draft** is `monthly_report_drafts/{propertyId}_{YYYY-MM}`, one working
document per property-month: `{ schemaVersion: 1, propertyId, month,
income: IncomeRow[], fee: { label, amountCents } | null, notes, supersedes:
{ reportId, reason } | null, revision, createdAt, updatedAt, finishedAs:
string | null }`. Saved by `PUT /api/admin/monthly-reports/draft` 800 ms
after the last change, whole, with the `revision` the page loaded; a
different stored revision is 409 `DRAFT_CHANGED` (a second admin, or a
second tab), and the page reloads the draft and says so. Nothing typed is
lost to a refresh: the draft is on the server, not in the tab. A draft is
never deleted; after finishing it holds `finishedAs`.

**Finishing**, `POST /api/admin/monthly-reports`, body `{ propertyId,
month, draftRevision, entries: [{ id, seen }], earlier: [{ id, seen }],
adjustments: [{ entryId, statementId, deltaCents }] }`, the page's claim of
what it built the document from:

1. The server reads the draft (its revision must match), the property's
   entries, its finished reports and its management record, and works the
   statement out again: the month's approved entries by `sentDay`, the late
   entries (approved, sent in an earlier closed month on or after the
   property's first statement month, in no current finished report of this
   property), the adjustments (entries a current finished report of this
   property printed whose amounts now differ or whose status left approved),
   each with its history length. If that is not exactly the page's claim:
   409 `STATEMENT_CHANGED`, nothing written, nothing downloaded. If an entry
   in it cannot be added up: 409, as for a ledger PDF.
2. It builds the frozen report object with `finishedAt` set to now, runs the
   same statement writer on it, and stores the bytes create-only at
   `monthly-reports/<reportId>.pdf` with `ifGenerationMatch: 0`, private,
   `no-store`, its SHA-256 in the object's metadata: the receipt pattern.
3. In one transaction it re-reads and re-checks the same claim, then
   `create()`s `monthly_reports/{reportId}` and updates the draft with
   `finishedAs` and `finishedRevision`. A claim that fails the second check
   leaves an orphan PDF object, logged by path, exactly as an orphaned
   receipt is.
4. The answer carries the report; the page shows "Finished" and offers the
   PDF. The browser can, and in verification will, run the writer on the
   returned frozen object and hash the bytes: the hash matches the stored
   object's, which is the proof that what the admin saw is what was stored.

**The finished report**, `monthly_reports/{autoId}`, is written once with
`create()` and never updated: `{ schemaVersion: 1, propertyId,
propertyNameAtFinish, month, ownersAtFinish: [{ name }], income:
IncomeRow[], incomeCents, costs: [{ entryId, ref, day, kind, description,
itemsCents, taxCents, totalCents, corrected, historyLength, receiptSha256 |
null, group: 'month' | 'earlier' }], adjustments: [{ entryId, statementId,
printedCents, nowCents, deltaCents, historyLength }], costsCents, fee:
{ label, amountCents } | null, feeCents, payableCents, pendingLeftOut,
notes, entryIds: string[], finishedAt, actor: admin, supersedes:
{ reportId, reason } | null, draftRevision, pdf: { path, bytes, sha256 } }`.
The four money figures are stored because they were printed, as the ledger
PDF record stores its totals; nothing reads them back into a total.

**Superseding.** A finished statement is never edited. On a finished month
the editor is read-only and offers **Correct this statement…**, which asks
for the reason (required, up to 500 characters), then rewrites the working
draft from the finished report (income, fee, notes copied; costs
recomputed live) with `supersedes: { reportId, reason }`, and finishing it
creates a second `monthly_reports` document carrying that pointer. The
pointer is on the **newer** document only; the older is never written
again, and readers derive "replaced" from the newer one. Both stay
downloadable; the tracker lists both, the older marked "Replaced on 5 Oct
by ref K2p9Xe: <reason>". A PDF record's comparison treats the replaced
statement as settled by the newer one, as a newer ledger PDF settles an
older (§14.5 of the costs design).

**Late entries and later changes** are the ordinary case, not the
exception: a receipt sent on 30 September may be approved on 4 October,
after September's statement went out, and an approved entry may be
corrected in November. Rather than force a correction of every closed
month, the next statement carries them under their own headings, computed
as above and stored in the frozen report, so the statements reconcile over
time: every approved entry appears in exactly one current statement, and
every change to one already printed is carried once as an adjustment.
§2.13 decision 5 puts the principle to Kian.

**"Nothing to report"** is a finished statement with no rows and a zero
closing figure. It is honest, it keeps the tracker uniform, and it costs
one click.

**Pending entries at finish time**: the page warns, allows, and the frozen
report records `pendingLeftOut`, as the ledger PDF's confirm does today
(D3 of dispatch 19). An entry approved later comes in as a late entry.

**Sending.** The system does not send anything in this version: there are
no owner emails on record (§1.4), and email would be a decision of its own
(§2.12). "Sent" means the admin downloaded the finished PDF and sent it by
whatever means; each download is one create-only `report_downloads`
document `{ reportId, at, actor }`, made by the route that mints the
60-second signed URL, so the tracker can say "downloaded twice, last 3 Oct
11:44". Google serves the bytes; Vercel serves a link.

**Which month an entry belongs to** is the ledger's rule and no other: the
Toronto day it was sent. `purchasedOn` plays no part, as it plays none in
the ledger.

### 2.6 The tracker and the home tiles

**`/admin/reports`**, the section's home, opens on the last closed month
(the month before the current Toronto month), with a month control to move
back or forward.

- **The line at the top.** "September 2026 · 31 of 46 statements finished ·
  15 outstanding · 2 drafts in progress · backup: stored in Drive 3 Oct,
  128 files, 96 MB, verified".
- **The table**, one row per property in scope (from its first statement
  month to its last, §2.13 decision 4; every property from the default
  start month otherwise), sorted outstanding first, then drafts, then
  finished: Property · **Statement** (Outstanding, in the alert tone;
  Draft, saved when; Finished when, ref; Replaced ×n) · Income · Costs ·
  Fee · Payable · **Exported** (downloaded n times, last when; or Never) ·
  **Backed up** (Stored, when; Not yet; Failed, when, reason) · Open /
  Download PDF. A property with no finished report for a closed month is
  **outstanding and says so**, in those words.
- **Loose ends**, under the table, only when there are any: pending entries
  sent in a closed month ("2 entries sent in September are still pending:
  they hold up nothing but are in no statement until reviewed"), approved
  entries in a closed month that no current statement carries ("1 late
  entry for Loft Plateau will go into the next statement"), and entries a
  finished statement printed that have since changed ("1 adjustment for
  Ajax will go into the next statement, or correct September's").
- **The backup panel** for the month (`?view=backup`): the latest run's
  status, when it started and finished, the Drive folder as a link
  (`drive.google.com/drive/folders/<id>`), the manifest as a table (each
  file, bytes, SHA-256, Drive's MD5 verified or not), every error in the
  run's own words, the earlier runs folded away, and **Run the backup
  again** (§2.7, the manual run). A closed month older than three days with
  no successful run reads "Not backed up yet: the daily run has not stored
  September" in the alert tone.

**One read**: `GET /api/admin/monthly-reports` answers every finished
report's summary fields (`select`, not the frozen detail), every draft's
summary, every download record, every backup run, every management record
and every property's name; the editor's own read
(`GET .../draft?property=&month=`) brings that property's full reports,
entries and draft. Firestore charges a read per document either way; at 46
properties that is about 600 report documents a year and stays far inside
the daily free reads for years. Near 5,000 it wants a per-year filter.

**Two tiles on the admin home**, in the shape of the six:

| Tile | Value | Detail | Leads to |
|---|---|---|---|
| **Statements, September** | properties outstanding for the last closed month | "31 of 46 finished · 2 drafts in progress"; accent tone while any is outstanding | `/admin/reports?month=2026-09` |
| **Backup, September** | Stored / Not yet / Failed | "3 Oct · 128 files · 96 MB · verified", or the failure's words; alert tone when not stored three days after the month closed or when the last run failed | `/admin/reports?month=2026-09&view=backup` |

Eight tiles in a three-column grid leave a ragged last row; the grid goes to
four columns at 1,200 px and above, two rows of four, and keeps its two- and
one-column steps below (mine). The tiles cost the admin home one more read,
the tracker's.

### 2.7 The monthly backup, organised for accountants (revised 2026-10-03, dispatches 23C and 24)

**Status.** The month as a ZIP (§2.7.9) is built in dispatch 24. The Drive
mirror is the next dispatch, after Kian creates the Google account; nothing
of it is built. This section replaces the §2.7 written on 2026-09-30, and
what §2.6, §2.8, §2.10 and §2.13 said about the backup.

**Kian's rulings of 2026-10-03** (recorded in `CLAUDE.md`):

1. The backup is a mirror. What is deleted in Nubnb is deleted from the
   backup.
2. A "Back up this month" button on the admin home from the 11th. It lists
   the properties still due and backs up what exists; running it again
   updates the backup.
3. Owners' folders are separate from Nubnb's.
4. No versions. A corrected statement replaces the old one.
5. The admin can download a whole month as a ZIP in the same folder
   structure the backup will use.

And from the same dispatch: a property **excluded from reporting** owes no
statements and leaves the button's list of properties still due; it still
has costs and income, and what exists of them is backed up like any
other's.

The footing of 30 September stands where the rulings leave it: Google Drive
in a Google account Nubnb owns, the `drive.file` scope, the work done on
Firebase, every file checked by its SHA-256.

#### 2.7.1 What the backup holds

One folder tree, mirrored from Nubnb, in which **one month is one ZIP's
worth**: the ZIP an admin downloads for September is exactly what the
backup holds for September, folder for folder and file for file.

```
Properties/
  Corner Penthouse l Tall Ceiling · 1VpX0w/
    2026/
      2026-09 September/
        2026-09 Payment Summary Sept-321-John (iDDcBK).pdf
        2026-09 Corner Penthouse l Tall Ceiling.xlsx
        Receipts/
          2026-08-28 ref Q7m2Ka.jpg
          2026-09-03 ref ykHRE5.jpg
        README.txt
        manifest.json
        SHA256SUMS.txt
Nubnb/
  2026/
    2026-09 September/
      2026-09 Fee income.xlsx
      2026-09 Not charged.xlsx
      Not charged receipts/
        Corner Penthouse l Tall Ceiling · 1VpX0w/
          2026-09-07 ref Ab12Cd - rejected.jpg
      Records/
        cost_entries 2026-09.json
        monthly_reports 2026-09.json
        monthly_report_drafts 2026-09.json
        report_downloads 2026-09.json
        property_management.json
      README.txt
      manifest.json
      SHA256SUMS.txt
```

In Drive the two top-level folders sit in a folder `Nubnb backup`; in the
ZIP, named `Nubnb 2026-09 September.zip`, they are its top level.

**Against the two readers.**

- *An owner's accountant wanting one property's year:* Kian shares
  `Properties/<property>/2026` with them, as a viewer: twelve month folders,
  each complete on its own. Nothing they can reach names another property,
  another owner's figures, or anyone on Nubnb's team. A month-first layout
  would need twelve shares for one property's year, or one share that shows
  every owner's figures.
- *Nubnb's accountant wanting fee income across all properties:* Kian shares
  `Nubnb/2026`. Each month holds the fee income of every property, each
  statement it rests on listed by reference, SHA-256 and place under
  `Properties/`.

**Which properties have a month folder:** every property that has, for the
month, a current finished statement, a draft, or a cost the statement
charges or would charge. A property with none of these has no folder; the
fee income workbook lists it with its standing (*Due*, *Past due*, *No
statement expected*, *Excluded from reporting*), so its absence is said.

**Names.**

- *A property's folder:* the property's name, `·`, the first six characters
  of its ID. The name is the one of the day: in the mirror a rename renames
  the folder. (A property carries no street address; its record holds the
  city and the area. The address reaches the README and the workbook through
  Report For, when a statement prints one.)
- *The statement:* `<month> Payment Summary <its typed reference> (<report
  ref>).pdf`. The report ref is the six characters the download's own name
  carries (`nubnb-statement-2026-09-iDDcBK.pdf`), so an accountant holding
  the file an owner was sent can match it. Only the current statement: a
  corrected statement replaces the old one (ruling 4).
- *A receipt:* `<day sent> ref <entry ref>.<jpg|png|webp>`, the two things
  the statement prints for it ("Expense - ref ykHRE5 · Sep 3, 2026"). An
  entry with more than one receipt (none today) adds `(2 of 2)`. When two
  refs in one folder differ only by letter case, both names take the full
  entry ID, because the Windows and macOS file systems ignore case.
- *The workbook:* `<month> <property>.xlsx`.
- Every name is cleaned of the characters Windows refuses (`\ / : * ? " <
  > |`) and kept under 120 characters, so the ZIP and a folder downloaded
  from Drive unpack anywhere; ZIP entries with characters beyond ASCII
  carry the UTF-8 flag.

#### 2.7.2 What a property's month holds

**The statement,** when the month has a current finished one: its stored
PDF, byte for byte, never drawn again.

**The workbook,** real numbers and real dates, totals as values in whole
cents (the ledger Excel's convention):

| Sheet | One row per | Columns |
|---|---|---|
| Statement | printed line, in print order, then the closing lines | the state (*Finished* with when, *Draft: not sent to anyone*, or *No statement*); the reference, report date and Report For; then as the PDF: description, transaction (the quantity), rate, amount; Total, the carried balance, Revenue share; the fee's label, rate, base, amount as computed, amount printed, and whether it was overwritten; the notes; how many entries were pending at finishing |
| Costs | recorded cost the statement charges (or, with no statement, would charge), this month's and then earlier months' | the printed line; day sent; ref; entry ID; kind (Receipt, Handyman work, Office); logged by, as a role; what was bought or the work done; items before tax; **tax**; total; corrected by Nubnb; approved (by the office, or automatically under $200); purchase date when given; the receipt file, or *No receipt: handyman work*, or *No receipt: entered by the office*; the receipt's SHA-256 |
| Items | item line of those costs | ref; item; quantity (for reference, never multiplied); amount as printed; corrected or added by the office |
| Adjustments | entry an earlier statement printed that has since changed or left | ref; the statement and month that printed it; printed; now; the difference |
| History | event on those entries, up to what the statement printed | when (Toronto); what; from and to; by (a role); reason; the line or the tax before and after |
| Receipts | receipt file | file; ref; bytes; the SHA-256 Nubnb recorded at upload; the SHA-256 of the file; equal |
| About | | what this is, when it was made, how to check the files, what it cannot show (§2.7.4) |

An expense typed as a statement line (a negative line such as "Expense -
Cleaning") appears on the Statement sheet as printed, and has no row in
Costs: it has no receipt in Nubnb.

**The figures come from the statement, the detail from the entry.** Each
cost's items, tax and total are the ones the statement froze (`costs[]` on
the report). Its item lines are worked out again from the lines the cleaner
sent and the first *n* events of its history, *n* being the history length
the statement recorded: the arithmetic the server ran at finishing
(`readLinesNow`). The two totals are checked against each other, and a
disagreement is said in the README. A month with no finished statement is
the statement as it stands: the same `buildStatement` the editor's preview
runs, on the draft when there is one.

**Tax, on every receipt, apart:** the tax field (`taxCents`) as printed; *None
entered* when it is empty, which is not zero; *In the items* for an entry
written before tax had its own field (production holds none today, but both
shapes must read correctly for good).

**The receipts,** under `Receipts/`, one per counted cost and per
adjustment, byte for byte.

**`README.txt`** for a person: the property and month; when the folder was
made and by what (the admin's download, or the backup); the statement and
its state; the downloads Nubnb had recorded for it; how to check the files;
the limits. **`manifest.json`** for a machine: every file with its bytes,
its SHA-256, where it came from (collection, document ID, Storage path) and
the hash Nubnb had recorded for it. **`SHA256SUMS.txt`**: the same hashes in
the form `shasum -a 256 -c SHA256SUMS.txt` checks on a Mac.

**Never in a property's folder:** a team member's name, a cleaner code, a
model's reading, a cleaner-facing name, an entry not charged to this owner,
anything of another property.

#### 2.7.3 Nubnb's month, across all properties

**`<month> Fee income.xlsx`:**

| Sheet | One row per | Columns |
|---|---|---|
| Fees | property: every one, so none is missing without a word | property and ID; its standing for the month (`monthStanding`, the same words as the list's column), and *draft in progress* when there is one; the statement's reference; when finished; revenue; typed expenses; recorded costs; fee base; fee rate; fee as computed; **fee as printed**; overwritten; total; carried balance; revenue share (payable to the owner, or, negative, owed to NuBNB); downloads recorded. A totals row over the finished statements: fee income, revenue, shares payable, owed to NuBNB |
| Statements | current finished statement of the month | property; reference; report ID; when finished; its file under `Properties/`; bytes; SHA-256 |
| About | | as for a property, and: the fee is one printed amount, and **nothing in Nubnb records whether HST applies to it** |

**`<month> Not charged.xlsx`** lists every entry sent in the month that the
month's statements do not charge (pending, rejected, removed, or approved
and carried by another month's statement) with **who logged it, by name**,
its status and reason, its amounts and where it is charged, if anywhere;
its receipts are under `Not charged receipts/<property>/`. **`Records/`**
holds the month's documents as stored: the entries the folder names, the
month's current statements, drafts and download records, and the
management records.

**Never copied anywhere:** `cleaners`, `cleaner_codes` (the codes),
`cost_entry_readings`, `cost_entry_submissions`, `receipt_reading_quota`,
`property_cleaner_names`, `property_visibility`, `contact_submissions`, the
availability copy, the properties themselves.

#### 2.7.4 Evidence

| File | What vouches for it |
|---|---|
| Statement PDF | Its SHA-256 was taken over the bytes at finishing, on the server, and stored on the statement document (`pdf.sha256`, written once, never updated) and in the Storage object's metadata. The ZIP and the backup refuse a copy whose SHA-256 differs. An accountant holding the PDF an owner was sent can hash it and compare: equal hashes, the same document. |
| Receipt photo | Its SHA-256 was taken over the bytes stored at upload and written on the entry (`receipts[].sha256`) and in the statement's cost row (`receiptSha256`). The ZIP and the backup check it; a photo that does not match is refused, named, and nothing is made. |
| Workbook, README | Made from the stored documents. Not evidence by themselves: a readable form of what `manifest.json` and `Records/` hold, whose figures can be set against the PDF line by line (the Statement sheet is the PDF's table). |
| `manifest.json`, `SHA256SUMS.txt` | Every file's hash, as made. In the backup the manifest's own SHA-256 is kept in Nubnb (next dispatch), so Nubnb's database vouches for the manifest and the manifest for every file. |

**The chain, receipt to statement:** the PDF prints "Expense - ref ykHRE5 ·
Sep 3, 2026" and its amount → the Costs sheet's row for ref ykHRE5 gives
the entry ID and the items, tax and total the statement document froze →
the row names `Receipts/2026-09-03 ref ykHRE5.jpg` and its SHA-256 → that
SHA-256 is the one on the entry and in the statement's cost row → the
statement document's own SHA-256 is the PDF's.

**What cannot be proven, plainly.**

1. That a purchase happened, for this property, at this price: the photo is
   what a cleaner's phone sent, and the cleaner chose the property.
2. When the photo was taken or the purchase made: the phone re-encodes the
   photo, dropping the camera's date; the purchase date is usually empty;
   only the upload time, on Nubnb's clock, is known.
3. That the tax figure is the tax printed on the receipt: a cleaner typed it,
   or confirmed the model's reading of it, or an admin corrected it.
4. Which admin did anything: one shared PIN; every admin action reads
   *admin*.
5. That the income lines are right: an admin typed them.
6. Anything Nubnb no longer holds. The backup is a mirror (ruling 1): a
   statement or entry deleted in Nubnb leaves the backup at its next run,
   and then no copy remains anywhere. A month folder shows Nubnb as it stood
   when it was made, and says when.
7. That the backup is untouched, independently of Nubnb: whoever holds the
   account can change files in Drive; no third party timestamps anything.
8. That an owner received a statement: Nubnb records that a download was
   made, not that anything was sent.
9. Anything about handyman work, office costs or expenses typed on a
   statement beyond Nubnb's own record: there is no receipt.

#### 2.7.5 Tax

**What the CRA asks for**, from the chart "Input tax credit information
requirements" in guide RC4022 (canada.ca, read 2026-10-03; GST/HST
Memorandum 8.4 still prints the earlier $30 and $150 tiers):

| Information | Under $100 | $100 to $499.99 | $500 or more |
|---|---|---|---|
| The supplier's business or trading name | ✓ | ✓ | ✓ |
| The invoice date, or the date the tax was paid or payable | ✓ | ✓ | ✓ |
| The total amount paid or payable | ✓ | ✓ | ✓ |
| The GST/HST charged, or that the price includes it at the applicable rate | | ✓ | ✓ |
| The supplier's GST/HST registration number | | ✓ | ✓ |
| The buyer's name or trading name, or their agent's | | | ✓ |
| The terms of payment, and a brief description | | | ✓ |

The same guide: records are kept six years from the end of the year they
relate to. The CRA's page "Acceptable format, imaging paper documents and
backing up electronic files": an image takes the place of a paper document
when it is made to the national standard CAN/CGSB 72.34; "if your business
cannot meet the CGSB standards when imaging, it has to keep the original
documents."

**What the folder gives, per receipt:** the photo; the total as printed; the
tax as its own figure; the day it was sent; the purchase date when given;
whether Nubnb corrected it. **What it does not hold as data:** the
supplier's name, the supplier's GST/HST number, the invoice date, the
buyer's name, the terms of payment. The first three are printed on most
retail receipts and can be read in the photo; the last two are usually on
no retail receipt. Whether a credit can be claimed, by whom (the CRA's
"recipient" is the person liable to pay for the supply), and whether the
photos may stand in for the paper are the accountant's questions; the
backup does not answer them. **No tax data at all:** handyman work, office
costs (the tax as typed, no receipt in Nubnb), expenses typed on a
statement, the fee, the revenue lines.

#### 2.7.6 The mirror (the next dispatch)

**When it runs:** when an admin presses **Back up <month>** on the admin
home, shown from the 11th for the month just closed (ruling 2). Beside it,
the properties still due for that month: owed, not excluded, with no
finished statement, from `reportingStatus`, the rule the list's column and
the tile already use. It backs up what exists; pressing it again brings the
backup level with Nubnb. No schedule and no trigger: nothing runs that an
admin did not ask for. (Mine: an older month is brought level the same way,
chosen in the statements panel's month control.)

**What one run does:** builds the month's package with the same pure module
the ZIP uses (`app/lib/backup/`), then makes the month's two folders in
Drive equal to it: a file missing in Drive is uploaded; a file whose
SHA-256 differs (a corrected statement, a corrected workbook) is replaced; a
file in Drive that the package no longer holds (a deleted statement, a
deleted entry's receipt, a property no longer in the month) is deleted
(ruling 1). Each upload is checked against Drive's own `sha256Checksum`
(or `md5Checksum` where Drive gives no SHA-256). The run touches only files
it made: the `drive.file` scope sees nothing else.

**Where it runs:** on Firebase, not Vercel. The button's route on Vercel
writes one request document; a function triggered by it (Firestore,
`us-central1` beside the `nam5` database, the default service account, no
key) does the work and writes its outcome back, which the admin home reads.
No shared secret, no Vercel time spent on the copy. (Mine; an HTTPS
function with a secret would also do.)

**What it stores in Nubnb** (server-only, denied in `firestore.rules`): one
document per run (month, who asked, when, what was uploaded, replaced and
deleted, each file's hash, Drive's checksums, the manifest's SHA-256,
errors), and the Drive folder IDs.

**How a failed run is visible:** on the admin home, beside the button: the
last run's outcome in its own words ("Google refused the sign-in: the
backup must be authorised again"), in the alert tone when it failed; and on
the property page, *In the backup · 11 Oct, 09:12* for the month shown. No
tile: the home has four, by ruling.

**What Kian authorises once:** a Google account for Nubnb (nubnb.ca has no
mail records, so no Google Workspace and no shared drive; letsconnex.com has
Workspace but is not Nubnb's), 2-step verification on; the Drive API and
Secret Manager API on `nubnb-fd02a`, with the six the availability refresh
needs; an OAuth consent screen, External, the one scope `drive.file`,
publishing status **In production** (a token from a screen left in Testing
dies after 7 days); a Desktop OAuth client; then a script on his Mac that
takes his consent as the backup account and hands the token to Secret
Manager without printing it; then the deploy.

**Cost, at $0**, against the allowances read on 2026-09-30 and 2026-10-03,
at measured sizes (real receipt photos 0.2 to 0.5 MB; statement PDFs 25 to
31 KB) and 100 receipts a month, far above today's rate: a run is a few
function minutes a month (2,000,000 invocations and 400,000 GB-seconds
free); the uploads about 60 MB (5 GB outbound free); the Storage reads in
the bucket's own region (US-CENTRAL1, free within one location, 50,000
Class B operations free); a few hundred Firestore reads per run (50,000 a
day free); one secret version (6 free per billing account); Drive about
0.7 GB a year of the account's 15 GB. No Cloud Scheduler job and no
Eventarc event beyond the button's own (events from Google sources cost
$0). The billing account now carries two projects, `nubnb-fd02a` and
`cnx-personal`; `cnx-personal` has neither Cloud Scheduler nor Secret
Manager enabled (checked 2026-10-03). Only the Artifact Registry size of
the deployed functions cannot be confirmed before the first deploy (0.5 GB
free).

#### 2.7.7 Deletion, as ruled

The backup is a mirror (ruling 1). A statement deleted in Nubnb (23G), an
entry deleted outright with its receipt (23H), leave the backup at its next
run. **Consequence:** once a deletion has been mirrored, no copy of what was
deleted remains anywhere; Storage's soft delete keeps a deleted object for
7 days, and the local exports in `backups/` keep the documents they caught.
What an accountant was handed before (a ZIP, a shared folder they copied)
stays with them; the backup does not.

#### 2.7.8 Exclusion from reporting

A property excluded from reporting (a toggle in the property form, stored
on its server-only `property_management` record) owes no statements:
`reportingStatus` gives it the standing *Excluded from reporting*, which
counts in no figure. It is left out of the Statement column's due and
past-due counts, the tile, the home panel, and the button's list of
properties still due. Its costs, income, drafts and any statement finished
for it are backed up like any other property's: exclusion changes what is
owed, not what exists.

#### 2.7.9 Inside Nubnb: the month as a ZIP (built in dispatch 24)

On the admin home's statements panel, for the month shown: **Download
<month>**, one ZIP holding `Properties/` and `Nubnb/` for that month, as
§2.7.1–§2.7.3 lay out. It works whether or not any backup has run.

**How, without Vercel carrying the bytes:**

1. `GET /api/admin/month-package?month=YYYY-MM` (admin session): reads the
   month's statements, drafts, download records and management records, and
   the cost entries; for each property with a month folder, takes its
   current finished statement or works the statement out as it stands
   (`buildStatement`); answers the statements, only the entries they name
   and the entries sent in the month, the stored documents for `Records/`,
   and a 60-second signed link for each receipt and statement PDF. It
   records one `report_downloads` document per current statement in the
   package (`via: 'month-package'`: the package hands the statement out, and
   23G's delete confirmation counts downloads) and one
   `month_downloads/{autoId}` document for the package itself.
2. The browser fetches each file from Google through its link, checks its
   SHA-256 against Nubnb's record, and refuses to make the ZIP, naming the
   file, if one differs or cannot be fetched.
3. It builds the workbooks, READMEs, manifests and checksum lists with
   `app/lib/backup/`, zips everything with the stored-ZIP writer
   (`app/lib/costs/zip.ts`) and saves `Nubnb 2026-09 September.zip`.

Vercel answers JSON: about 1 MB at 100 receipts a month, inside its 4.5 MB
response cap for years; the bytes come from Storage.

#### 2.7.10 Doors that are expensive to change

The folder layout and every name; the manifest's shape; that one month is
one ZIP's worth and the backup holds exactly the ZIP's files; that owners'
folders never name the team; `month_downloads`; the `via` word on a
download record. **Not doors:** the button's place, the 11th (it follows
the 10th of the ruling), the README's words.

### 2.8 The stored shapes, and every choice that is expensive to change

New collections, all server-only, all denied in `firestore.rules` and
exported by `export-firestore.mjs` like every root collection:

| Collection / path | One document per | Written | Changed |
|---|---|---|---|
| `monthly_reports/{autoId}` | finished statement | `create()` | never |
| `monthly_report_drafts/{propertyId}_{YYYY-MM}` | property-month being worked on | `create()` then `update()` with a revision check | in place while a draft; then only `finishedAs` |
| `report_downloads/{autoId}` | download of a finished PDF | `create()` | never |
| `property_management/{propertyId}` | property with owners, a statement range or a default fee | `set()` on save, as `property_cleaner_names` | in place, by an admin |
| `backup_runs/{autoId}` | backup run | `create()` | never |
| Storage `monthly-reports/<reportId>.pdf` | finished statement's bytes | create-only (`ifGenerationMatch: 0`) | never |
| Drive `Nubnb backups/<YYYY-MM>/…` | month | uploaded once, verified | a missing file is added by a later run; nothing is replaced |

Fields added to existing collections, on **new documents only**:

- `cost_entries`: `kind: 'receipt' | 'work'`, `autoApproved: {…} | null`;
  `receipts` may be `[]` on a work entry. History gains the word `seen`.
  The actor's `role` gains `system` and `handyman`.
- `cleaners`: `role: 'cleaner' | 'handyman'`.

**The one-way doors**, each named because there are no backfills and every
document keeps its shape for ever:

1. **The collection names and the Storage prefix above.** Renaming means
   moving documents.
2. **`kind` on an entry and `role` on an account, with absence meaning
   receipt and cleaner.** Every reader must keep that reading for the
   documents written before this. A third kind or role later is a new word,
   never a new meaning for an old one.
3. **Handyman work in `cost_entries`, not a collection of its own** (§2.3).
   Splitting later would leave two shapes for ever and change every reader.
4. **The frozen statement embeds its income rows, cost rows and adjustments
   as arrays**, as an entry embeds its lines: one atomic `create()`, one
   document in every export and backup, well under the 1 MiB limit (a
   200-row statement is about 60 KB). Moving rows to a subcollection later
   would drop them out of the export script, which exports root collections
   only.
5. **The PDF bytes are stored, with their SHA-256 on the document.** "Exactly
   what the co-owner received" is the bytes, not a promise that a future
   writer regenerates them identically. Storing them later would not
   recover the ones handed out before.
6. **`supersedes` is on the newer document.** A finished statement is never
   written again, so it cannot carry a forward pointer. Readers compute
   "replaced".
7. **`entryIds` and each cost row's `historyLength` on the statement**, the
   ledger PDF record's own device: it is what lets a later correction be
   marked "changed since the September statement", and what defines
   "already reported" for late entries. It cannot be added to a statement
   after the fact.
8. **Month means the Toronto calendar month of the day an entry was sent.**
   The ledger's rule; a statement built on any other day would disagree with
   the ledger PDFs already handed out.
9. **Money as integer cents, income and fee included, negative allowed on an
   income row, never on a fee; the fee an amount, never a rate.** If a rate
   is ever wanted, it is a new field beside the amount (the admin's note of
   how they arrived at it), never a field code multiplies.
10. **The income `source` words**: `airbnb, vrbo, private, other`.
11. **The auto-approval record on the entry** (`thresholdCents`,
    `totalCents`, `at`) and the actor role `system`. A threshold that
    changes later confuses nothing; the record says what rule each entry
    met.
12. **The draft keyed by property and month.** One working copy per month;
    a correction reuses it. Two concurrent working copies would need a
    different key.
13. **The backup's folder layout and file names in Drive, and the manifest's
    shape.** A layout change later leaves two layouts side by side in a
    folder nobody wants to reorganise by hand.
14. **`schemaVersion` on every new document**, as everywhere.

**Not one-way doors:** the 800 ms save delay, the 300 ms preview delay, the
pattern rule's constants, the tile grid, the section's name, the daily tick
time, the two-months-per-run cap, the 540 s timeout, the signed link's 60
seconds, loosening any validation, adding optional fields.

### 2.9 The screens

| Screen | What it is |
|---|---|
| `/admin/reports` | The tracker (§2.6): month control, the line at the top, the table, loose ends, the backup panel behind `?view=backup` |
| `/admin/reports/edit?property=&month=` | The statement editor with the live PDF (§2.5); read-only with Download and Correct once finished |
| `/admin/costs` | The queue gains the "Approved automatically, not yet looked at" group with Seen, the "Worth a look" panel, a Kind filter, a `?cleaner=` filter, the Work badge, "No receipt: handyman work"; the pane gains the auto-approval note, Seen, "Work done", the cleaner's 90-day distribution, and statements in "PDFs it went out in" |
| `/admin/cleaners` (header pill **Team**) | Role column, role choice on the create row, the 90-day distribution per cleaner |
| Property form | A **Co-owners** block (names, optional emails), **Statements from / until** (months), **Default management fee** (label, amount), saved through their own route like the name for cleaners |
| `/admin` | Two more tiles; the "Costs to review" detail line carries the auto-approved count and "worth a look" |
| `/cleaner` | The handyman flow: property → Work → Sent, and My work; the bar's tag by role |

### 2.10 The routes

| Route | Door | Request | Answer |
|---|---|---|---|
| `POST /api/cleaner/work` | handyman | JSON `{ submissionKey, propertyId, description, price }` | 201 `{ id, status: 'pending', createdAt }`; 200 `alreadyReceived`; 403 `ROLE_MISMATCH` for a cleaner; the entry route's refusals otherwise |
| `GET /api/cleaner/start`, `GET /api/cleaner/entries` | either | none | as now, plus `role`; a handyman's list is their work |
| `POST /api/cleaner/entries`, `POST /api/cleaner/read-receipt` | cleaner | as now | 403 `ROLE_MISMATCH` for a handyman |
| `POST /api/admin/cleaners` | admin | `{ name, role }` | as now |
| `POST /api/admin/cost-entries/[id]/seen` | admin | `{ seen }` | 200 `{ entry, changed }`; 409 `ENTRY_CHANGED` |
| `GET /api/admin/monthly-reports` | admin | none | 200 the tracker's data (§2.6) |
| `GET /api/admin/monthly-reports/draft?property=&month=` | admin | none | 200 `{ draft, entries, reports, management }` |
| `PUT /api/admin/monthly-reports/draft` | admin | `{ propertyId, month, revision, income, fee, notes, supersedes }` | 200 `{ draft }`; 409 `DRAFT_CHANGED`; 422 |
| `POST /api/admin/monthly-reports` | admin | the claim (§2.5) | 201 `{ report }`; 409 `STATEMENT_CHANGED` / `STATEMENT_ENTRY_UNREADABLE`; 502 `STATEMENT_RECORD_FAILED` ("may or may not have been finished") |
| `GET /api/admin/monthly-reports/[id]/pdf` | admin | none | 200 `{ url, expiresAt, seconds: 60 }`, and one download record |
| `GET`/`PUT /api/admin/properties/[id]/management` | admin | `{ owners, statementsFrom, statementsUntil, defaultFee }` | 200 |
| `POST /api/admin/backups/run` | admin | `{ month }` | 202; 502 when the function did not answer |

Every admin write keeps the admin route order: session, cross-site, media
type, ID, JSON, schema, work; every response `no-store`.

### 2.11 Cost, in Vercel's terms

Nothing new on any public page or at build time. An admin's statement costs
one function call per 800 ms pause in typing (bounded by how long they
type), one to finish, one per download link; the tracker one per open; the
home one more per open. Firestore stays inside the free reads for years at
this scale (§2.6). The functions stay inside the allowances of §2.7. The one
thing that could ever cost is Drive filling up (§2.7's arithmetic), and that
is Kian's account, at Google's price, years out.

### 2.12 What this cannot do

- It does not know what Airbnb, Vrbo or a private guest actually paid.
  Income is what an admin types; there is no payout feed and none is
  proposed.
- It does not compute the fee. The admin types an amount (§2.13).
- It does not send the statement. Nobody's email is on record, and email
  would be a decision of its own: what is sent from where, to whom, with
  what wording, and what "sent" then means in the tracker.
- It does not put receipt photos in the statement. The PDF writer could
  embed JPEGs, but twenty receipts make a 20 MB statement; the co-owner gets
  the entry's reference and Nubnb keeps the receipt.
- It does not prefill anything from the calendar copy. The availability
  snapshot knows a month's Airbnb reservations by date; "Airbnb: 3 stays, 14
  nights" as an empty income row would be a real convenience, later, and
  never with an amount.
- It does not audit. A statement is Nubnb's account to a co-owner, built
  from records Nubnb approved; it is not an independent check on Nubnb.
- It cannot see clustering that has not happened yet, and with two entries
  it sees nothing for months.
- It cannot make a backup permanent. The Drive folder belongs to whoever
  owns the account; if that account is closed, the copy goes with it.
  Firebase keeps the originals, and nothing there is deleted.
- It does not make an Excel file of a statement in this version; the ledger
  Excel for the same month exists.
- Mobile is not scoped for any admin screen; the live PDF is the one part a
  phone would do badly.

### 2.13 Decisions

**Kian's, five, each with a recommendation:**

1. **The auto-approval line, and how an auto-approved entry leaves the
   queue.** Proposed: strictly under $200.00 on the entry as sent, items
   plus tax; it leaves the queue when an admin marks it Seen, one at a time
   or all at once, and correcting, removing or rejecting it counts as seen.
   Recommended as proposed. The alternative, leaving the queue on its own
   after n days, hides exactly the entries the record is meant to surface.
2. **Google Drive or OneDrive, and whose account.** Recommended: Google
   Drive, in a Google account that belongs to Nubnb rather than to a person
   (free, 15 GB, survives a change of staff), authorised once with the
   `drive.file` scope from a consent screen in production status. OneDrive
   works the same way with one more cloud to look after.
3. **The management fee.** Recommended: an amount typed on each statement,
   prefilled from a default amount set on the property, with a free label
   the admin writes ("15 % of income" if that is how they arrived at it).
   Not recommended: a percentage the code multiplies out, because code never
   multiplies a price and the fee would be the first exception.
4. **Co-owners and each property's statement range.** Recommended: a
   server-only per-property record, set in the property form, with the
   co-owners' names, optional emails kept for a later sending decision, the
   month statements start from (default October 2026, the first full month
   after this is built) and, when a property leaves management, the month
   they stop; the statement is then addressed by name. Without it every
   statement reads "Prepared for the owners of <property>" and every
   property is expected to have one from the default start month.
5. **Late entries and later changes.** Recommended: carried into the next
   statement under "From earlier months" and "Adjustments to earlier
   statements", so every approved entry appears in exactly one current
   statement and every change is carried once, with a superseding statement
   reserved for a mistake in the statement itself. The alternative, a
   correction of the closed month for every late receipt, produces a
   replaced statement most months.

**Mine, not rulings, each reversible at review:** handyman work as
`cost_entries` of `kind: 'work'` and the role on the `cleaners` document
(§2.3, and door 2 and 3 of §2.8, so reversible only before the first
production write); the same `/cleaner` URL for both roles; the header pill
"Team"; the description as the one line, 200 characters; the words of the
auto-approval event; the pattern rule's constants (90 days, three in the
band, 40 %, two split sets, "too few" under five); income rows embedded in
the draft and the statement; the draft saved in place with a revision;
the real PDF as the preview, double-buffered, rather than an HTML twin; the
PDF made on the server and its bytes stored, with the browser able to prove
it saw the same bytes; downloads recorded, the statement Excel not built;
`supersedes` on the newer document; "Nothing to report" as an ordinary
finished statement; pending entries warned about, allowed and recorded; the
daily tick with monthly work, two months per run, full snapshots of the
small collections in every folder, `code` stripped from the cleaners
snapshot, MD5 verified against Drive and SHA-256 in the manifest; an HTTPS
function with a secret for the manual run rather than a Firestore trigger
through Eventarc; the four-column tile grid; the auto-approved mark shown to
admins and not printed for co-owners. If "no existing document modified" is
meant to reach the working documents this dispatch creates, the draft
becomes one document per save and the newest is read back; nothing else
changes.

### 2.14 Build order, and what would prove it

Not started. The order, when it is:

1. **Model and arithmetic**: `kind`, `role`, `autoApproved`, the words
   `seen`, `system`, `handyman`; the statement types; `app/lib/reports/`
   (month, late entries, adjustments, the reconciliation) and
   `app/lib/costs/patterns.ts`, pure and checked in node against made-up
   entries, as the PDF comparison was (27 checks in §14.7).
2. **The writers**: `app/lib/pdf/core.ts` lifted out of `pdf.ts` with the
   filled rectangle, `pdfFor` unchanged and its bytes compared before and
   after against a stored report; `statement-pdf.ts`.
3. **The server**: auto-approval in `createCostEntry`; `POST
   /api/cleaner/work`; the seen route; the draft, finish, download and
   management routes; `firestore.rules`; the export script's expected list.
4. **The admin**: the queue's group, panel and filters; the editor with the
   live PDF; the tracker; the property form's block; the tiles; the header's
   section.
5. **The cleaner app**: the handyman flow and My work.
6. **The functions**: `backupMonths`, `backupNow`, the authorise script, the
   secrets, `functions-sync` copying `app/lib/reports/` in.

Verification, in raw output, on a local production build reading production
data with throwaway secrets, `__TEST__` accounts created through the real
routes and deleted by ID afterwards, the opening and closing exports
byte-identical apart from what the test wrote and removed, as every
dispatch since 17:

- a `__TEST__` cleaner's receipts at $199.99 and at $200.00 through the real
  route: the first stored `approved` with the two events and the
  `autoApproved` map, in the queue's group, Seen taking it out, the ledger
  counting it; the second stored `pending`;
- a `__TEST__` handyman's work entry through the real route, stored
  `pending` with `kind: 'work'` and `receipts: []`, the cleaner's session
  refused on the work route and the handyman's on the receipt route, the
  entry in the queue, the ledger, the Excel file and the PDF;
- the pattern panel on a made-up 90 days of entries, firing and not firing
  on each side of each constant;
- a statement drafted, its rows reordered, the draft reloaded in a second
  tab and the stale tab's save refused; finished, the returned frozen
  object run through the writer in the browser and its SHA-256 equal to the
  stored object's; a late entry approved afterwards appearing under "From
  earlier months" in the next month's draft; a correction to a printed
  entry appearing under "Adjustments"; a superseding statement with its
  reason, both listed, the older marked replaced;
- the tracker's counts against a hand count from the export; the tiles
  against the tracker;
- one backup run, by `.run()` of the function handler locally against a
  throwaway Google account's token, for a month holding the test data:
  the folder in Drive, the manifest's SHA-256 equal to the entries' own, the
  MD5 verified, the run document; then a run with the token revoked,
  recorded `failed` and the tile in the alert tone; then the test month's
  Drive folder deleted by Kian, since nothing in Nubnb deletes;
- the scheduled tick itself and the manual run through Vercel need Kian's
  deploy, as the availability refresh does.

---

## Appendix. What was run

Read-only, on 2026-09-30, from the working tree at `98027f8` plus the
uncommitted dispatch 22:

- `CLEANER-COSTS-DESIGN.md` whole (1,261 lines); `AVAILABILITY-SEARCH-PLAN.md`
  §2.3, §2.7–2.9; `CLAUDE.md`.
- `app/lib/cleaners/model.ts`, `app/lib/costs/{report,pdf,xlsx,zip}.ts`,
  `app/lib/firebase/{server-cost-entries,server-cleaners,server-cleaner-start,server-property-names,admin}.ts`,
  `app/lib/cleaners/{session,receipts}.ts`, `app/lib/api/verify-admin.ts`,
  `app/lib/{costs-client,cleaner-client,cleaner-draft,on-demand,price}.ts`,
  `app/types/property.ts`, every route under `app/api/admin/cost-entries`,
  `app/api/admin/cost-reports`, `app/api/admin/properties/[id]/cleaner-name`,
  `app/api/cleaner/{entries,session,start}`, `app/admin/page.tsx`,
  `app/admin/costs/{page,EntryPane,cost-display}.tsx`,
  `app/admin/components/{DashboardStats,AdminHeader}.tsx`, the tile grid in
  `app/admin/page.module.css`, `app/cleaner/CleanerApp.tsx`,
  `firestore.rules`, `storage.rules`, `firebase.json`,
  `functions/src/index.ts`, `scripts/{export-firestore,functions-sync}.mjs`,
  `package.json`, `functions/package.json`; `grep -i owner` over `app/`.
- `backups/2026-09-30T21-31-05Z/*.json`: document counts per collection,
  every field name on the 46 property documents, the two entries' status,
  shape and dates, the two cleaners, the three PDF records.
- Three Google pages through the headless browser, quoted in §1.5.

Nothing was written anywhere, no server was started, and no export was
taken.
