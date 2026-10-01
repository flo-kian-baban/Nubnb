# Cleaner cost logging: design (dispatches 17, 18 and 19)

**Status.**
- **Dispatch 17** was approved by Kian on 2026-09-26 with decisions D1–D4. It was amended on 2026-09-28 by Kian's ruling that **cleaner codes are 4 digits, not 6**, and corrected the same day after independent review (§3.11's exit rule, a design error, and an in-app Back guard on the one-time code panel, since removed with the panel).
- **Dispatch 18** (2026-09-28) applies Kian's ruling, which overrides the dispatch-17 design: **a cleaner's code is visible to admins at any time and can be changed by an admin; the one-way hash goes** (§1a, §1b, §2, §3, §4, §5). It adds the cleaner app at `/cleaner` (§10).
- **Kian's dispatch-18 decisions:** the test cleaner KiKi is deleted by document ID; a send-again guard is added (§1d); the receipt photo is taken before the items.
- **Verified 2026-09-29** against a local production build reading production data, as §9 plans.
  - KiKi's two documents were deleted by ID and all test data by exact ID and path.
  - The closing export is byte-identical to the opening one, KiKi's documents excepted, and the Storage listing is unchanged.
- **Dispatches 17 and 18** were committed as `5056bac` and deployed on 2026-09-29.
- **Dispatch 19** (2026-09-29) adds the admin's review and reports: the costs page at `/admin/costs`, approve / reject / correct / remove, receipts through 60-second signed links, per-property Excel and PDF, the unambiguous amount label, and a cleaner's own receipts (§11). Kian's decisions D1–D5 and defaults are in §11. Verified on 2026-09-29 against a local production build reading production data; implemented in the working tree, not committed or deployed.

> **Codes are stored readably, by Kian's ruling of 2026-09-28.** A code is the ID of its `cleaner_codes` document and the value of its cleaner's `code` field. **Any copy of the database therefore exposes every cleaner code, current and replaced:** a `./backups/` export, a console export, or anything read with the service-account key. The ruling and this exposure are recorded in CLAUDE.md under "Accepted risks".

**Precondition (dispatch 17).** HEAD is 21f85bb. The working tree has one change, Kian's uncommitted edit to `CLAUDE.md`, so "tree clean" does not strictly hold. Kian's edit is left exactly as it is. On Kian's instruction (2026-09-28), this dispatch appends one bullet to its "Accepted risks": 4-digit cleaner codes.

**Facts this design relies on:**
- The deployed `firestore.rules` and `storage.rules` are identical to the repo files. Three designers read them through the Firebase MCP; verification step V0 checks this again.
- Bucket `nubnb-fd02a.firebasestorage.app`:
  - No IAM or ACL grant to `allUsers` or `allAuthenticatedUsers`.
  - Uniform bucket-level access is off.
  - The default object ACL is private to the project.
  - Soft delete keeps deleted objects for 7 days.
- The installed `@google-cloud/storage` is 7.19.0, and its `save()` accepts `preconditionOpts`.
- The Admin SDK's `WriteBatch` and `Transaction` both have `create()`.
- `PinGate.tsx` hard-codes `PIN_LENGTH = 4`. It auto-submits once the 4th box is filled (lines 103-107) and cuts a paste to its first 4 digits (line 79).

**Shape checkpoint (the dispatch says "report the shape before building it").** §1 and §2 were reported before the build, and Kian decided: D1 the line total as printed; D2 a 12-hour session; D3 code reissue in the next dispatch, before any real cleaner is onboarded; D4 `purchasedOn` and `note` included. No document shape becomes permanent until the first production write, and that cannot happen before Kian has reviewed and deployed. Everything written during verification is test data and is deleted.

**Dispatch 18 checkpoint ("report the cleaner screen flow before building it").** §10's flow was reported before the build. Kian chose the photo before the items, and the send-again guard of §1d. One production write predates this: the cleaner "KiKi", created during dispatch-17 testing in the version 1 (digest) shape, without the `__TEST__` prefix. Kian ruled that it is deleted by document ID.

---

## 1. Data model

**Layout.** Four new **root** collections and one new Storage prefix. There are no subcollections, because `scripts/export-firestore.mjs` exports root collections only and merely *reports* subcollections.

**Writes.**
- Every write goes through the Admin SDK, from the routes in §4.
- New documents are written with `create()`. Cleaner status changes and code changes are a transactional `update()`. A code change also sets `retiredAt` on the replaced code's document (§3.12).
- The app **never** calls `set()` or `delete()` on these collections, and never deletes under `receipts/`.
- No code path writes to `properties` or `contact_submissions`. `properties` is read only through `getAll(ref, { fieldMask: ['name'] })`.

**Timestamps.** Every timestamp is an ISO-8601 UTC string from `new Date().toISOString()`: 24 characters, ending in `Z`, so text order is time order. This is the repo convention.

**Shared shapes** (client-safe, in `app/lib/cleaners/model.ts`):
- `Actor = { role: 'admin' | 'cleaner', id: string | null, name: string | null }`.
  - Every admin action today is recorded as `{ role: 'admin', id: null, name: null }`: there is one shared PIN and no admin identity, and the record says so.
- `HistoryEvent = { at: ISO, action: string, from: string | null, to: string | null, actor: Actor, reason: string | null }`.
  - Events are appended inside a transaction, by reading the array, adding to it and writing it back. `FieldValue.arrayUnion` is never used, because it silently drops an element identical to one already present.
- `schemaVersion` is on every new document: **2** on cleaners and code documents (the readable code of dispatch 18), **1** on cost entries and submissions. Version 1 of a cleaner or a code document is the digest shape of dispatch 17. Readers use it as a hint only; **it is never an auth gate**.

### 1a. `cleaners/{cleanerId}`

The ID is a Firestore auto ID from `collection('cleaners').doc()`: 20 characters, `[A-Za-z0-9]`.

| Field | Type / constraint | Written by | Mutable? |
|---|---|---|---|
| `schemaVersion` | `2` | create | never |
| `name` | string: NFC-normalised, trimmed, 1–80 UTF-16 units, no `\p{Cc}`. Duplicates allowed. | create | never so far (a future rename appends a `renamed` event) |
| `code` | four digits, `^[0-9]{4}$`: the cleaner's **current** code, equal to the ID of its `cleaner_codes` document | create; code change | by a code change only |
| `status` | `'active' \| 'deactivated'` | create (`'active'`), PATCH | workflow |
| `statusChangedAt` | ISO | create, PATCH | workflow |
| `createdAt` | ISO | create | never |
| `sessionEpoch` | safe integer ≥ 1, starts at `1` | create; `+1` on every status change and every code change | increment only |
| `codeIssuedAt` | ISO: when the current code was set | create; code change | by a code change only |
| `history` | `HistoryEvent[]`, append-only. Actions: `created`, `deactivated`, `reactivated`, `code_changed` (later `renamed`). On `code_changed`, `from` and `to` are the old and new codes. | create, PATCH, code change | append only |

```json
{ "schemaVersion": 2, "name": "Marie Tremblay", "code": "0429", "status": "active",
  "statusChangedAt": "2026-09-26T15:02:11.482Z", "createdAt": "2026-09-26T15:02:11.482Z",
  "sessionEpoch": 1, "codeIssuedAt": "2026-09-26T15:02:11.482Z",
  "history": [ { "at": "2026-09-26T15:02:11.482Z", "action": "created", "from": null, "to": "active",
                 "actor": { "role": "admin", "id": null, "name": null }, "reason": null } ] }
```

- No API response ever contains `sessionEpoch`.
- Codes appear only in admin responses (§4).
- **Version 1** had `codeDigest` (64 hex characters) instead of `code`. It was written only during dispatch-17 testing (KiKi, deleted in dispatch 18).
  - Readers treat a cleaner without `code` as having **no code on record**, and such a cleaner cannot sign in.
  - A code change on such a cleaner sets `code` and marks the digest document retired. `codeDigest` is left in place, inert.

### 1b. `cleaner_codes/{code}`: every code ever issued, and the index that keeps codes unique

The ID is the four-digit code itself. `create()` refuses a second document with the same ID, so of two writes of one code exactly one lands.

| Field | Type | Mutable? |
|---|---|---|
| `schemaVersion` | `2` | never |
| `cleanerId` | cleaner auto ID | never |
| `issuedAt` | ISO | never |
| `retiredAt` | `null` while the code is the cleaner's current one. Set once, when an admin replaces it. Sign-in requires `null` **and** a cleaner whose `code` is this code. | once, by a code change |

```json
{ "schemaVersion": 2, "cleanerId": "Qm3x…(20)", "issuedAt": "2026-09-26T15:02:11.482Z", "retiredAt": null }
```

These documents are **never deleted**.
- An issued code stays reserved for ever, even once replaced or its cleaner deactivated.
- It is never given to a second person, so a code seen in the history always names one cleaner.

**Version 1** documents had a 64-hex HMAC digest as the ID, plus `keyVersion: 1` and `keyCheck`. A 4-digit ID cannot collide with a 64-hex ID, and no version 1 code is ever looked up at sign-in.

### 1c. `cost_entries/{entryId}`

The ID is a Firestore auto ID, pre-allocated with `collection('cost_entries').doc()` before the receipt upload so that the Storage path can carry it. No ID or attribution field ever comes from the client.

| Field | Type / constraint | Mutable? |
|---|---|---|
| `schemaVersion` | `1` | never |
| `cleanerId` | taken from the verified session, never from the body | never |
| `cleanerNameAtEntry` | copied from `cleaners/{id}.name` **inside the create transaction** | never |
| `propertyId` | a Firestore doc ID (`isDocumentId`) that exists at write time. Any property is accepted, delisted ones included. **This is the reference.** | never |
| `propertyNameAtEntry` | `string \| null`: the `name` read with `getAll(…, { fieldMask: ['name'] })` at write time. It is a display fallback only (a property can be renamed or hard-deleted), never the reference. | never |
| `createdAt` | ISO, server clock: "when it was logged" | never |
| `purchasedOn` | `'YYYY-MM-DD' \| null`, optional input, always present (D4) | never |
| `note` | `string \| null`, 1–500 characters, optional input, always present (D4) | never |
| `currency` | `'CAD'`, set by the server, always present | never |
| `lines` | `Line[]`, 1–100 items | never |
| `receipts` | `ReceiptRef[]`, **exactly 1** in v1 | never |
| `status` | `'pending'` at create. The review route (§11) writes `'approved' \| 'rejected' \| 'removed'`. | workflow |
| `statusChangedAt` | ISO; equals `createdAt` at create | workflow |
| `statusReason` | `null` at create. Later a string of 1–500 characters, required when the status is `rejected`. | workflow |
| `history` | `HistoryEvent[]`: `[{ action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id, name }, reason: null, at }]` | append only |

- **`Line`** is `{ name, quantity, lineTotalCents }`:
  - `name`: string, NFC, trimmed, 1–120 characters, no `\p{Cc}`.
  - `quantity`: a finite number greater than 0 and at most 99999.999, with at most 3 decimals. It is **informational and is never multiplied into money.**
  - `lineTotalCents`: a safe integer from −99,999,999 to 99,999,999 inclusive. It is **the amount printed on that receipt line** (D1). Negative means money back (a discount or a return), and 0 is allowed.
- **Entry rule:** the sum of `lineTotalCents` must be greater than 0. The sum is **computed on read for display and is never stored**. No code computes, adjusts or corrects any amount.
- **`ReceiptRef`** is `{ path, contentType, bytes, sha256, uploadedAt }`. The server takes every value from the bytes it stored: `contentType` is the sniffed type and `sha256` is hex.
- **After create, only `status`, `statusChangedAt`, `statusReason` and appended `history` ever change**, and only through the review routes (§11). **`lines` is never rewritten**: a correction or an added line is a history event carrying the line before and after, and the lines that count are computed on read (§11.1).
- **Mistakes and duplicates** are handled by rejecting or removing the entry, or correcting a line. Nothing is deleted; every earlier state stays in the history.

```json
{ "schemaVersion": 1, "cleanerId": "Qm3x…", "cleanerNameAtEntry": "Marie Tremblay",
  "propertyId": "a8Kd…", "propertyNameAtEntry": "Loft Plateau",
  "createdAt": "2026-09-26T18:40:03.117Z", "purchasedOn": "2026-09-25", "note": null, "currency": "CAD",
  "lines": [ { "name": "Paper towels 12-pack", "quantity": 2, "lineTotalCents": 3798 },
             { "name": "Instant savings", "quantity": 1, "lineTotalCents": -500 },
             { "name": "GST/QST", "quantity": 1, "lineTotalCents": 494 } ],
  "receipts": [ { "path": "receipts/Zr81…/6c0e2b9e-4f1a-4d6e-9a3c-1b7f0d2e8a55.jpg", "contentType": "image/jpeg",
                  "bytes": 1183422, "sha256": "…64 hex…", "uploadedAt": "2026-09-26T18:40:02.704Z" } ],
  "status": "pending", "statusChangedAt": "2026-09-26T18:40:03.117Z", "statusReason": null,
  "history": [ { "at": "2026-09-26T18:40:03.117Z", "action": "submitted", "from": null, "to": "pending",
                 "actor": { "role": "cleaner", "id": "Qm3x…", "name": "Marie Tremblay" }, "reason": null } ] }
```

A coarse shop is one line, for example `{ "name": "Costco run", "quantity": "1", "lineTotal": "187.43" }`. The model never asks for more detail than the receipt has.

**Entry input** is the `entry` multipart part: a JSON string of at most 32,768 characters, validated with `z.strictObject`. Any extra key, such as `cleanerId`, `status` or `receipts`, gets 422.

```json
{ "submissionKey": "3f1c9a2e-8b7d-4e21-9c0f-5a6b7c8d9e0f",
  "propertyId": "a8Kd…",
  "purchasedOn": "2026-09-25",
  "note": "optional",
  "lines": [ { "name": "Bleach 3.6 L", "quantity": "2", "lineTotal": "7.98" } ] }
```

- **`quantity`** must be a string matching `^(0|[1-9][0-9]{0,4})(\.[0-9]{1,3})?$`, converted with `Number()`, and the result must be greater than 0.
- **`lineTotal`** must be a string matching `^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$`. It is converted to integer cents by **splitting the string, never through a float**; `-0.00` becomes 0.
- **`purchasedOn`** is optional and may be `null`. It must be a real calendar date (a UTC round-trip reproduces it), at least `2020-01-01`, and no later than today in UTC plus 1 day.
- **`note`** is optional. It is trimmed, at most 500 characters, and may contain no control characters other than `\n`. An empty note is stored as `null`.
- **`lines`** must have 1–100 items, and each line is itself a `strictObject`.
- **`submissionKey`** (dispatch 18, required) must be a lowercase version 4 UUID, the form `crypto.randomUUID()` writes. It is the phone's one-time key for this receipt (§1d). It is **not** stored on the entry.

### 1d. `cost_entry_submissions/{cleanerId}_{submissionKey}`: the send-again guard (dispatch 18)

One document per receipt a cleaner has sent. The ID joins the cleaner's ID and the one-time key their phone gave that receipt, so no cleaner's key can meet another's.

| Field | Type | Mutable? |
|---|---|---|
| `schemaVersion` | `1` | never |
| `cleanerId` | from the verified session | never |
| `submissionKey` | the UUID from the entry input | never |
| `entryId` | the `cost_entries` ID this send wrote | never |
| `createdAt` | ISO, equal to the entry's `createdAt` | never |

- It is written with `create()` **in the same transaction as the entry**, and never updated or deleted.
- **Why it exists.** A phone that loses the answer to a send cannot tell whether the entry landed. It sends the same receipt again with the same key, and the server answers 200 `alreadyReceived` with the first entry's ID. It stores and writes nothing more.
- **Where the key is checked.**
  - Once, before the photo is looked at or anything is uploaded (`findSubmission`, 1 read).
  - Again inside the entry transaction, for two sends in flight at once. One wins; the other's already-uploaded receipt is a logged orphan, and it too gets 200 `alreadyReceived`.
- **A receipt changed after a send whose outcome is unknown is a different receipt.** The app gives it a new key. If the first send did land, the admin sees two entries and rejects one, as dispatch 17 designed for duplicates.

---

## 2. Choices that are expensive to change later

There are no backfills, so every document keeps the shape it was written with for ever, and readers must handle every shape ever written. They do so defensively: a missing field is shown as absent, and an unknown stored value is shown as it is (the `badgeOdd` pattern).

1. **Collection names `cleaners`, `cleaner_codes`, `cost_entries`, `cost_entry_submissions` and the `receipts/` prefix.** Renaming any of them means moving documents, which is a backfill.
2. **How codes are stored (dispatch 18, by Kian's ruling).**
   - The code is the ID of `cleaner_codes/{code}` and the value of `cleaners.code`. There is no hash and no pepper.
   - **Anyone with a copy of the database has every code.** That is the ruling's accepted cost.
   - A future change of code length (back to 6 digits, say) would put IDs of a second length beside the first. Issuance would then have to keep the two apart, for example by reserving a 6-digit code's 4-digit prefix. It is not a migration: a code change moves each cleaner.
   - The version 1 digest shape is left behind for good: no code reads it at sign-in.
3. **Codes are reserved for ever.** `cleaner_codes` docs are never deleted, even after deactivation or a code change. If a code were ever reused, the history's record of who held it would become ambiguous permanently.
4. **Identity is separate from the code.** Entries reference `cleanerId`, never a code. A code change is a pointer swap on the cleaner doc (§3.12): the cleaner keeps their ID, name, status and entries.
5. **Lines are embedded as an array (at most 100) in the entry.** The entry, its lines and its attribution land in one atomic `create()`, and all of it is inside the export. Moving lines to a subcollection later would leave two shapes for ever and drop out of backups.
6. **Money.**
   - Each line holds a signed integer `lineTotalCents`, meaning the amount printed on that line (D1).
   - Quantity is informational.
   - `currency: 'CAD'` is explicit.
   - No total is stored.
   - Floats, a different unit, or a later change of meaning could never be told apart in historical documents.
7. **`receipts` is an array (exactly 1 in v1) of `{ path, contentType, bytes, sha256, uploadedAt }`.** A singular `receipt` map would force every reader to handle two shapes. `sha256` could never be added later without re-reading every object and writing the value back, which is a backfill.
8. **Name snapshots sit alongside the IDs** (`cleanerNameAtEntry`, `propertyNameAtEntry`). `DELETE /api/properties/[id]` hard-deletes, and a snapshot cannot be recovered for entries written without one.
9. **Timestamps are ISO strings, never Firestore `Timestamp`.** Mixing the two types splits ordering and range queries.
10. **The status vocabulary and event shape.**
    - Cleaners are `active | deactivated`; entries are `pending | approved | rejected | removed` (`removed` added in dispatch 19).
    - Fields are `status`, `statusChangedAt` and `statusReason` (the leads naming), plus an append-only `history` with `Actor` and `from`/`to`.
    - Words once written are permanent. Documents written without history would need synthetic readers for ever.
11. **Fields that are always present:** `status`, `createdAt`, `cleanerId`, `propertyId`, `currency`, `purchasedOn` (possibly `null`) and `note` (possibly `null`). Firestore `where` and `orderBy` silently drop documents that lack the field (the `listLeads` lesson).
12. **Entries are immutable apart from their workflow fields.** Since dispatch 19 a line can be corrected or added, but only as a history event (`line_corrected`, `line_added`) carrying the line before and after; `lines` itself never changes. An entry written before dispatch 19 has no such events and reads exactly as it did.
13. **Readers always use the stored `receipts[].path` and never rebuild it.** That keeps the path scheme changeable for new uploads. Rebuilding paths would freeze the scheme.
14. **`schemaVersion` on every document.** It cannot be added to documents already written.
15. **The send-again guard's ID, `<cleanerId>_<submissionKey>` (dispatch 18).** Every entry from dispatch 18 on has one; older entries (test data only) have none.

**Not one-way doors:**
- The session token format, its lifetime and the cookie path. A change only signs cleaners out.
- Auto IDs versus idempotency. Added in dispatch 18 exactly this way, with no change to the entry's shape: a separate `cost_entry_submissions` document, `create()`d in the entry transaction (§1d).
- Adding optional fields later.
- Loosening validation later.

---

## 3. Access model

### 3.1 Secrets

Since dispatch 18 the cleaner door has **one** environment variable. Nothing else uses it.

| Var | Format | Purpose | Rotation |
|---|---|---|---|
| `CLEANER_SESSION_SECRET` | base64url of 32 random bytes; the string must match `^[A-Za-z0-9_-]{43,}$` and decode to ≥ 32 bytes | Signs cleaner session tokens | Any time: redeploy, and every cleaner is signed out. No data changes. |

- **Generating it:** `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- **The same value goes in Vercel Production and in `.env.local`, with a copy in a password manager.**
- **Validated lazily.** `getCleanerSecrets()` in `app/lib/cleaners/secrets.ts` runs inside handlers and **never at module scope**, so `next build` succeeds when the variable is absent.
- **Failing closed.** When it is missing or invalid, every cleaner route returns **503 `CLEANER_AUTH_NOT_CONFIGURED`**. Admin, cleaner creation and code changes are unaffected: they need no key.
- **What is never used as a key:** `ADMIN_PIN`, anything derived from it, and `ADMIN_SESSION_SECRET`.
- **`CLEANER_CODE_PEPPER` is no longer read by the app.** It keyed the version 1 digests of dispatch 17. It can be removed from Vercel and `.env.local`; nothing depends on it once KiKi, the only version 1 cleaner, is deleted.

### 3.2 Code issuance: `issueCleaner(name, adminPin)` in `app/lib/firebase/server-cleaners.ts`

1. **Admin PIN.** `adminPin` comes from the admin route, one of the few places outside `verify-admin.ts` that read `process.env.ADMIN_PIN`. If it is empty, return `admin-pin-missing`, which becomes 503 `ADMIN_PIN_NOT_CONFIGURED`. This is unreachable in practice, because admin auth needs the PIN.
2. **Database.** If the Admin SDK cannot be initialised, return `unavailable`, which becomes 503 `CLEANERS_UNAVAILABLE`. Nothing was written.
3. **Candidates.** Up to **5** candidates. For each one (n = 1…5):
   - `code = String(randomInt(0, 10_000)).padStart(CODE_LENGTH, '0')` with `CODE_LENGTH = 4`, using `import { randomInt } from 'crypto'`. It is called in exactly this synchronous two-argument form, with no injection seam.
   - **Reserved-code filter** (`reservedReason` in `app/lib/cleaners/codes.ts`). This runs on every candidate, after generation. The candidate is discarded if:
     - it **equals** `adminPin`, compared with `timingSafeEqual` on buffers of equal length (a PIN of any other length can never equal a code). The PIN is only compared. Codes and the PIN are both 4 digits and PinGate submits the moment the 4th digit is in, so a cleaner holding the admin PIN as their code would open /admin. That single code is never issued, and never accepted by a code change either (§3.12).
     - it is on the **reserved list**: all four digits the same (10 codes), an ascending run (`0123` … `6789`, 7 codes) or a descending run (`9876` … `3210`, 7 codes). With only 10,000 codes these 24, the first an attacker would try, matter more.

     That leaves 9,975 issuable codes, fewer those already issued.

     A discarded candidate logs `[cleaners] reserved candidate skipped (candidate n/5)` and the loop continues.
   - `cleanerRef = db.collection('cleaners').doc()`. `now = new Date().toISOString()`.
   - `db.batch().create(cleaner_codes/{code}, {…}).create(cleanerRef, {…, code, …}).commit()`. `create()` requires that the document does not exist, and the batch is all-or-nothing.
   - **Outcomes of the commit:**
     - Success returns `{ kind: 'created', cleaner }`, the cleaner's code on `cleaner.code`.
     - `err.code === 6` (`ALREADY_EXISTS`) means the code was issued before (to anyone, current or replaced) and **nothing was written**. Log `[cleaners] code collision (candidate n/5)` and continue.
     - Any other error returns `{ kind: 'unconfirmed' }`, which becomes 502 `CLEANER_CREATE_UNCONFIRMED`. Log `[cleaners] create not confirmed: grpc code <n>`. **Never retry after it.**
4. **Exhausted.** After 5 candidates, return `{ kind: 'exhausted' }`, which becomes **409 `CLEANER_CODE_UNAVAILABLE`** ("No unused code could be issued. Nothing was created. Try again.").

Of two concurrent issuances of the same code, Firestore lets exactly one `create()` win.

### 3.3 Login: `POST /api/cleaner/session`

1. `refuseCrossSite`, then media type `application/json`; otherwise 415 `UNSUPPORTED_CONTENT_TYPE`.
2. Secret check: 503.
3. If JSON parsing fails, or the body is not `z.strictObject({ code: z.string() })`: **400** `{ error: 'Invalid request' }`. The body is never logged.
4. If the code does not match `^[0-9]{4}$`: **401 `CLEANER_CODE_NOT_RECOGNISED`** ("Code not recognised"), with **no Firestore read**. The admin PIN is well-formed here, but it is never issued as a code, so it fails at step 5 like any code nobody holds, after one read. **The cleaner door never reads `ADMIN_PIN`.**
5. `get cleaner_codes/{code}`. If it is missing, or `retiredAt` is not `null` (a replaced code): the same 401.
6. `get cleaners/{cleanerId}`. It must exist, have `status === 'active'` and `code === code` (it still points at this code), and its `sessionEpoch` must be a safe integer ≥ 1. Anything else gets the same 401.
7. Issue a token (§3.4), set the cookie, and return **200** `{ cleaner: { id, name } }`.
8. Any Firestore error returns **503 `CLEANER_AUTH_UNAVAILABLE`** ("Could not check the code. Try again.") and logs only `[cleaner-session] lookup failed: grpc code <n>`. **Access is never granted on an error.**

### 3.4 Session token and cookie

- **Token:** `c1.<cleanerId>.<sessionEpoch>.<issuedAtMs>.<mac>`, where `mac = base64url(HMAC-SHA256(CLEANER_SESSION_SECRET bytes, "nubnb:cleaner-session:v1:" + cleanerId + ":" + epoch + ":" + issuedAtMs))`. It is 43 characters with no padding.
- **Parsing** uses one anchored regex: `^c1\.([A-Za-z0-9]{20})\.([1-9][0-9]{0,8})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$`.
- **Cookie:**
  - name `nubnb_cleaner_session`
  - `httpOnly: true`
  - `secure: process.env.NODE_ENV === 'production'`
  - `sameSite: 'strict'`
  - **`path: '/api/cleaner'`**
  - `maxAge: CLEANER_SESSION_MAX_AGE = 43200`, i.e. 12 hours, absolute (D2)
- **Where the browser sends it.** With that path, the browser sends the cookie only to `/api/cleaner` and `/api/cleaner/...`. It never goes to `/admin*`, `/api/admin/*`, `/api/admin-auth`, the other admin APIs or public pages.
- **Constants.** `CLEANER_SESSION_COOKIE`, `CLEANER_SESSION_PATH` and `CLEANER_SESSION_MAX_AGE` live in `app/lib/cleaners/session.ts`.
- **Sign-out (dispatch 18):** `DELETE /api/cleaner/session` answers with the same cookie, empty and `Max-Age=0`, so that browser no longer holds the token. It needs no session and reads nothing. Revocation of the token itself is still a status or code change.

### 3.5 `verifyCleanerSession(request)`: async, used only by `/api/cleaner/*`

1. Read only `nubnb_cleaner_session`, using the anchored regex `(?:^|;\s*)nubnb_cleaner_session=([^;]+)`, then `decodeURIComponent` inside a try/catch.
2. Check the secrets (503), the token regex and the MAC (`timingSafeEqual` on decoded buffers of equal length). The age must satisfy `now − issuedAt ≤ 43200 s` and `issuedAt − now ≤ 60 s`. **No I/O happens before this step passes.**
3. Read `cleaners/{id}` once. It must exist, with `status === 'active'` and `sessionEpoch === epoch`. A read error returns 503 `CLEANER_AUTH_UNAVAILABLE`.
4. Return `{ ok: true, cleaner: { id, name, sessionEpoch } }`.

Any other failure returns **401 `CLEANER_SESSION_INVALID`** ("Sign in with your code."), with `noStore`.

**Design rule:** there is no in-memory caching of cleaner documents anywhere.

### 3.6 Deactivation and reactivation: `setCleanerStatus(id, target)`

This is one transaction:
- read the cleaner (missing: 404);
- if `status === target`, write nothing and return `changed: false`;
- otherwise `update({ status: target, statusChangedAt: now, sessionEpoch: old + 1, history: [...old, { at: now, action: 'deactivated' | 'reactivated', from: <stored status or null>, to: target, actor: admin, reason: null }] })`;
- if `sessionEpoch` is not a safe integer ≥ 1, or `history` is not an array: 500 `CLEANER_RECORD_UNREADABLE`.

Effects (a code change has the same effect on sessions, §3.12):
- **Deactivation takes effect on the next request.** Every existing token fails §3.5 step 3 on both status and epoch. Login fails at §3.3 step 6.
- **An entry already in flight** re-reads the cleaner *inside its create transaction* (§4, step 14) and aborts, so no entry lands after the deactivation commits.
- **Reactivation** makes the same code work again. **Tokens issued before any status change stay dead for ever**, which covers a lost phone.
- **A code that leaked** means: deactivate the cleaner, and later reissue (D3).

### 3.7 The two doors, walked in both directions

| Attempt | Result |
|---|---|
| Cleaner code posted to `POST /api/admin-auth` | `verifyAdminPin` compares two 4-digit values; the admin PIN is never issued as a code, so 401. |
| Cleaner types or pastes the code into the /admin PinGate | PinGate submits all 4 digits. **No code equals `ADMIN_PIN`**: the reserved-code filter runs at issue and at every code change (§3.12), and `scripts/check-admin-pin-vs-cleaner-codes.mjs` guards a PIN change (§3.11). So 401 "Incorrect PIN". |
| Cleaner cookie sent to any admin route | The browser does not send it (path). Sent by hand, `verifyAdminSession` reads only `nubnb_admin_session`, so 401. |
| Cleaner token placed under `nubnb_admin_session` | `parseInt('c1')` gives NaN, so 401 before any HMAC. The key also differs. **A leaked cleaner cookie reveals nothing about `ADMIN_PIN`**: breaking it means brute-forcing a 256-bit key. |
| Admin cookie on cleaner routes | The browser sends it (admin path `/`), but cleaner routes never read it, so 401. |
| Admin token placed under `nubnb_cleaner_session` | Fails the `c1.` regex, so 401. |
| Admin PIN posted to `POST /api/cleaner/session`, or typed on `/cleaner` | Well-formed, but never a code: one read, then 401 `CLEANER_CODE_NOT_RECOGNISED`, the same answer as any code nobody holds. |
| Cleaner at `/admin`, `/admin/leads`, `/admin/cleaners` | The static shells hold no data. PinGate's `GET /api/admin-auth` returns 401, so the PIN gate is shown. `/cleaner` links nowhere in /admin. |

**Structural rules, checked by grep:**
- Every handler in `app/api/admin/` starts with `verifyAdminSession`.
- Every handler in `app/api/cleaner/` except `session` POST and DELETE starts with `verifyCleanerSession`.
- Nothing under `app/api/cleaner/`, `app/lib/cleaners/`, `server-cleaners.ts` or `server-cost-entries.ts` imports `verify-admin`.
- Nothing outside `app/api/cleaner/` imports `app/lib/cleaners/session`.
- `ADMIN_PIN` appears only in `verify-admin.ts`, `app/api/admin/cleaners/route.ts` and `app/api/admin/cleaners/[id]/code/route.ts`.
- Nothing under `app/cleaner/` or in `app/lib/cleaner-client.ts`, `cleaner-draft.ts` or `receipt-photo.ts` imports a server module.

### 3.8 Cross-site requests

- **SameSite=Strict** withholds both cookies from cross-site requests.
- **The earlier claim that JSON bodies force a CORS preflight was false.** Existing routes do not check `Content-Type`, so a `text/plain` or multipart POST is a "simple" request that needs no preflight.
- **On the new state-changing routes only:**
  - `refuseCrossSite`: if a `Sec-Fetch-Site` header is present and is not `same-origin`, return **403 `CROSS_SITE_REFUSED`**. curl sends no such header; browsers always do.
  - `requireMediaType`: the part of `Content-Type` before `;` must equal the expected type, otherwise **415 `UNSUPPORTED_CONTENT_TYPE`**. The expected type is `application/json`, or `multipart/form-data` for entries.
- **Routes covered:** `POST` and `PATCH /api/admin/cleaners*` (the code route included), `POST` and `DELETE /api/cleaner/session` and `POST /api/cleaner/entries`.
- Existing routes are not touched. The code lives in `app/lib/cleaners/request-guard.ts`.

### 3.9 Log hygiene

- **Codes** are returned only to the admin: the list, the create response and the code-change response, and shown on `/admin/cleaners`. They are never logged, never in a cleaner response, and never in a URL.
- **Never logged, displayed or returned anywhere:** a token, a secret, a request body.
- Firestore errors on cleaner-auth, issuance and code-change paths are logged as a gRPC code only, because their messages can include document paths, and a `cleaner_codes` path is a code.

### 3.10 Accepted risks and the threat boundary

These are stated, not proposals. Rate limiting is ruled out.

- **Online guessing is unthrottled, and the space is small.** This is Kian's ruling (2026-09-28), recorded in CLAUDE.md under "Accepted risks".
  - Codes are 4 digits: 10,000 combinations, 9,975 of them issuable. A full sweep is 10,000 requests. With N active cleaners, the first hit takes about 10⁴/(N+1) guesses, each costing 1 invocation and 1 read.
  - A hit grants only what the cleaner door grants: creating *pending* entries and uploading private receipts of 4 MiB or less. It never grants /admin.
  - Login costs 1 read on a miss and 2 on a hit, which reveals that an issued code exists (even a deactivated one).
- **Reading the database reveals every code (Kian's ruling, 2026-09-28).** Codes are stored readably, as `cleaner_codes` IDs and `cleaners.code`.
  - `./backups/` holds exports that include both collections, and `.env.local` holds the service-account key. Both sit in the repo folder, so a copy of that folder yields every code, current and replaced.
  - Before the ruling, the database alone revealed nothing, although the database plus the pepper revealed every code in milliseconds.
- **Every admin sees every code.** There is one shared PIN, so "admin" is anyone who has it.

### 3.11 Admin PIN change guard

The reserved-code filter only protects against the PIN **at the moment a code is issued or changed**. If `ADMIN_PIN` changes later, the new PIN could be a code issued earlier.

A read-only script, `scripts/check-admin-pin-vs-cleaner-codes.mjs`, closes that gap. Kian runs it before changing the PIN. Rewritten in dispatch 18 for readable codes:
- It reads the candidate PIN from `process.env.CANDIDATE_ADMIN_PIN` only, and never prints it. The candidate must be exactly 4 digits, because PinGate submits exactly four; anything else exits 2.
- It calls `enforceReadOnly()` from `export-firestore.mjs`.
- It checks that `codes.ts` still has `CODE_LENGTH = 4` and that `model.ts` still names both collections, and exits 2 if not.
- It counts version 1 documents (`keyVersion == 1`). Their codes are digests and cannot be compared, so while any remain it exits 2 with no answer. The only one ever written, KiKi's, is deleted in dispatch 18.
- It reads `cleaner_codes/{candidate}`. **It exits 1 whenever that document exists**: whatever the cleaner's status, whether the code has been replaced, and whether the cleaner document still exists. It prints the cleaner's ID, status and name, and whether the code is current or replaced.

  **Correction (2026-09-28), kept from dispatch 17: this was a design error, not an implementation slip.** The first design said "exits 1 if that cleaner is active". PinGate and `POST /api/admin-auth` compare against `ADMIN_PIN` alone and never consult a cleaner's status, so deactivation has no effect at the admin door. Found by the independent review of 2026-09-28 (finding F1). The same reasoning covers replaced codes: their former holder still knows them.
- It exits 0 only when no such document exists: "Checked the candidate PIN against every code ever issued: not one of them."
- It costs 2 reads, 3 on a hit.

### 3.12 Changing a code: `setCleanerCode(id, request, adminPin)` (dispatch 18)

`POST /api/admin/cleaners/[id]/code` with `{ code: "5831" }` (four digits the admin typed) or `{ generate: true }` (drawn like an issued code).

1. **Refused before any read:**
   - a typed code equal to `ADMIN_PIN`: 422 `CLEANER_CODE_IS_ADMIN_PIN`;
   - a typed code on the reserved list: 422 `CLEANER_CODE_TOO_EASY`;
   - no admin PIN configured: 503 `ADMIN_PIN_NOT_CONFIGURED`.
2. **One transaction.** Every read comes before the first write.
   - Read the cleaner. If it is missing: 404. If the typed code is already theirs: 200 `changed: false`, and nothing is written. If `sessionEpoch` or `history` cannot be advanced: 500 `CLEANER_RECORD_UNREADABLE`.
   - Read `cleaner_codes/{new}`. If it exists: **409 `CLEANER_CODE_TAKEN`**. The message says either "That code belongs to another cleaner." or, when `retiredAt` is set, "That code was used before and is never given out again."
   - Read the document of the code being replaced: `cleaner_codes/{current}`, or on a version 1 cleaner `cleaner_codes/{codeDigest}`.
   - Write:
     - `create(cleaner_codes/{new}, { schemaVersion: 2, cleanerId, issuedAt: now, retiredAt: null })`;
     - `update(old, { retiredAt: now })` when the old document names this cleaner and is not yet retired. It is kept, never deleted, so the old code stays reserved;
     - `update(cleaner, { code, codeIssuedAt: now, sessionEpoch: +1, history: [..., { action: 'code_changed', from: old code or null, to: new code, actor: admin }] })`.
   - A commit that fails with `ALREADY_EXISTS` is `taken`. Any other failure is 502 `CLEANER_CODE_CHANGE_FAILED`: "It may or may not have been saved."
3. **Generate** draws up to 5 candidates as in §3.2, skipping the reserved ones and the cleaner's own code, and runs the transaction for each until one is not taken. After 5: 409 `CLEANER_CODE_UNAVAILABLE`.
4. **Effects:**
   - **The old code stops working at once:** sign-in needs the code's document not to be retired and the cleaner to point at it.
   - The bumped `sessionEpoch` signs out every phone that signed in with the old code, on its next request. An entry in flight fails its transaction re-check (§4 step 14) with 401 "Nothing was logged".
   - The cleaner keeps their ID, name, status and history, and every entry keeps its attribution, because entries name the cleaner, never the code.
5. Costs: a transaction of 3 reads (2 on a cleaner without a code) and 3 writes; a generated code may take more than one transaction.

## 4. Routes

**Common rules:**
- Every response is `noStore`, including 401 and 4xx: `apiSuccess`, `apiError`, `apiFailure` and `apiValidationError` are wrapped with `noStore`.
- Bodies are validated with `z.strictObject`. Route IDs are checked with `isDocumentId`, imported unchanged from `app/lib/firebase/server-leads.ts`.
- Validation issues map as `{ path: i.path.join('.'), message }`.
- Every route runs on Node. No route exports `runtime` or `dynamic`. The route table must show the new API routes as `ƒ`.
- Routes live under `/api/admin/*` (admin door) and `/api/cleaner/*` (cleaner door).

| Route | Door | Request | Success | Errors (besides auth, 403, 415) | Firestore / Storage per call |
|---|---|---|---|---|---|
| `GET /api/admin/cleaners` | admin | none | 200 `CleanerSummary[]` = `{ id, name, code, status, statusChangedAt, createdAt, history }`, newest `createdAt` first, sorted in memory. `code` is null for a cleaner with none on record. | 500 `CLEANERS_READ_FAILED` | N reads with `.select('name','code','status','statusChangedAt','createdAt','history')`, so `sessionEpoch` never leaves Firestore |
| `POST /api/admin/cleaners` | admin | JSON `{ name }` | **201 `{ cleaner: CleanerSummary }`**, the new code on `cleaner.code` | 400 invalid JSON; 422; 503 `ADMIN_PIN_NOT_CONFIGURED` / `CLEANERS_UNAVAILABLE`; 409 `CLEANER_CODE_UNAVAILABLE`; 502 `CLEANER_CREATE_UNCONFIRMED` (hint: "It may have been created. Reload the list: if the name appears, their code is in their row.") | one 2-create batch per candidate tried |
| `PATCH /api/admin/cleaners/[id]` | admin | JSON `{ status: 'active' \| 'deactivated' }` | 200 `{ cleaner: CleanerSummary, changed: boolean }` | 400 "Invalid cleaner ID"; 422; 404 `CLEANER_NOT_FOUND`; 500 `CLEANER_RECORD_UNREADABLE`; 502 `CLEANER_UPDATE_FAILED` | transaction: 1 read + 0–1 write |
| `POST /api/admin/cleaners/[id]/code` (dispatch 18) | admin | JSON `{ code: "5831" }` or `{ generate: true }` | 200 `{ cleaner: CleanerSummary, changed: boolean }`, the new code on `cleaner.code` | 400 "Invalid cleaner ID" / invalid JSON; 422 (not four digits); 422 `CLEANER_CODE_IS_ADMIN_PIN` / `CLEANER_CODE_TOO_EASY`; 409 `CLEANER_CODE_TAKEN` / `CLEANER_CODE_UNAVAILABLE`; 404 `CLEANER_NOT_FOUND`; 500 `CLEANER_RECORD_UNREADABLE`; 502 `CLEANER_CODE_CHANGE_FAILED`; 503 `ADMIN_PIN_NOT_CONFIGURED` | transaction per candidate: 2–3 reads + 3 writes (§3.12) |
| `GET /api/admin/cost-entries` | admin | none | 200 `CostEntryView[]`, newest first, **whole collection read with no `orderBy` and no `limit`** (the `listLeads` pattern; nothing can silently vanish) | 500 `COST_ENTRIES_READ_FAILED` | E reads + `getAll` of distinct cleaners (fieldMask `name`, `status`) + `getAll` of distinct properties (fieldMask `name`) |
| `POST /api/cleaner/session` | code in body | JSON `{ code }` | 200 `{ cleaner: { id, name } }` + Set-Cookie | 400; 401 `CLEANER_CODE_NOT_RECOGNISED`; 503 | 1 read on a miss, 2 on a hit |
| `GET /api/cleaner/session` | cleaner cookie | none | 200 `{ cleaner: { id, name } }` | 401 `CLEANER_SESSION_INVALID`; 503 | 0 reads if the token is invalid, else 1 |
| `DELETE /api/cleaner/session` (dispatch 18) | none | none | 200 `{ signedOut: true }` + the cookie cleared (`Max-Age=0`, same path) | 403 `CROSS_SITE_REFUSED` | none |
| `GET /api/cleaner/start` (dispatch 18) | cleaner cookie | none | 200 `{ cleaner: { id, name }, properties: [{ id, name, city }], recentPropertyIds, itemNames }` (§10) | 401 `CLEANER_SESSION_INVALID`; 503 `CLEANER_AUTH_NOT_CONFIGURED` / `CLEANER_AUTH_UNAVAILABLE` / `CLEANER_START_UNAVAILABLE` | 1 session read + 1 per property + 1 per entry of this cleaner's + ≤ 300 of everyone's newest entries |
| `POST /api/cleaner/entries` | cleaner cookie | multipart: `receipt` (file) + `entry` (JSON string) | **201 `{ id, status: 'pending', createdAt, lineCount }`**; **200 `{ id, createdAt, alreadyReceived: true }`** when the one-time key was sent before (§1d) | see below | 1 session read + 1 key read + 1 property read + transaction {2 reads, 2 creates}; 1 Storage write. A repeated send stops after the key read. |

**`CostEntryView`** has this shape:
```
{ id, createdAt, status, statusChangedAt, statusReason, history,
  cleaner: { id, nameAtEntry, state: 'found'|'missing'|'unreadable', name: string|null, status: string|null },
  property: { id, nameAtEntry, state: 'found'|'missing'|'unreadable', name: string|null },
  purchasedOn, note, currency, lines,
  receipts: [{ contentType, bytes, sha256, uploadedAt }] }
```
- Object paths are never returned.
- Enrichment failures become `'unreadable'`; they never fail the list.
- Display prefers the live name and falls back to the snapshot.
- There is no pagination. The costs page (dispatch 19) filters and adds up in the browser, which needs every entry; revisit near 1,000 entries.

**Admin route order:**
1. `verifyAdminSession` (401 via `apiError(auth.error, auth.status)` + `noStore`).
2. For writes: `refuseCrossSite`, then `requireMediaType('application/json')`.
3. JSON parse (400 `'Invalid JSON body'`).
4. zod (422).
5. The work.

**Name schema** (POST cleaners):
```
z.string().transform(s => s.normalize('NFC').trim()).pipe(z.string().min(1).max(80).refine(s => !/\p{Cc}/u.test(s)))
```

**`POST /api/cleaner/entries`: exact order.** `export const maxDuration = 30`.

1. `refuseCrossSite`. Result: 403.
2. `verifyCleanerSession`. Results: 401 or 503. No body is read before this.
3. `Content-Length`, if present and greater than **4,300,000**. Result: 413 `ENTRY_REQUEST_TOO_LARGE`.
4. `requireMediaType('multipart/form-data')`. Result: 415.
5. `request.formData()`. Result on failure: 400 `ENTRY_BAD_REQUEST`.
6. The parts must be exactly `entry` (a string) and `receipt` (a File). Result: 400 `ENTRY_BAD_REQUEST`, or 400 `RECEIPT_MISSING`.
7. `entry`: at most 32,768 characters, then `JSON.parse`. Result: 400 `ENTRY_BAD_REQUEST`. Then zod (§1c). Result: 422.
8. Sum of `lineTotalCents` > 0. Result: 422 `ENTRY_TOTAL_NOT_POSITIVE`.
8b. **The one-time key** (dispatch 18): `get cost_entry_submissions/{cleanerId}_{submissionKey}`. If it exists, the answer is **200 `{ id, createdAt, alreadyReceived: true }`**, with the first send's entry, and nothing is stored or written. A read error gets 502 `SUBMISSION_CHECK_FAILED` ("Nothing was recorded; retry").
9. The declared type must be one of `image/jpeg`, `image/png`, `image/webp`.
   - `image/heic` or `image/heif` gets 415 `RECEIPT_TYPE_REJECTED`, with the hint "Take the photo as JPEG".
   - Any other type gets 415 `RECEIPT_TYPE_REJECTED`.
10. The bytes: more than 4,194,304 gets 413 `RECEIPT_TOO_LARGE`; 0 gets 422 `RECEIPT_EMPTY`; failing the magic-byte sniff gets 415 `RECEIPT_NOT_AN_IMAGE`.
11. Property lookup, `getAll(properties/{id}, { fieldMask: ['name'] })`.
    - Missing gets 422 `ENTRY_PROPERTY_NOT_FOUND`.
    - A read error gets 502 `PROPERTY_LOOKUP_FAILED`.
    - This happens **before any upload**, so bad input never creates an object.
12. `entryRef = db.collection('cost_entries').doc()`. This allocates an ID without writing.
13. `saveReceipt(...)` (§6). Result on failure: 502 `RECEIPT_STORAGE_FAILED` ("Nothing was recorded; retry").
14. `db.runTransaction`:
    - `tx.getAll(cleanerRef, submissionRef)`. The cleaner must exist, with `status === 'active'` and `sessionEpoch === token epoch`. Otherwise throw `SessionRevoked`, which becomes 401 `CLEANER_SESSION_INVALID` with the hint "Nothing was logged". A deactivation or a code change in flight lands here.
    - If the submission document exists, another send of the same receipt won: throw `DuplicateSubmission`, which becomes 200 `alreadyReceived` with that send's entry.
    - `tx.create(entryRef, doc)`, with `cleanerNameAtEntry` taken from this read, and `tx.create(submissionRef, …)` (§1d).
    - Any other failure is 502 `ENTRY_WRITE_FAILED`, with the hint "The receipt was received but the entry may not have been recorded; check before submitting again".
    - Every failure path, the duplicate included, logs `[cost-entries] orphaned receipt <path> (entry <id> not written: <reason>)`.

**No route exists only for testing.**
- `GET /api/admin/cost-entries` is the permanent reader; the costs page (§11) reads it.
- `GET /api/cleaner/start` is the cleaner page's gate and its one read on opening; `GET /api/cleaner/session` stays as the lighter "who am I".
- `POST /api/cleaner/entries` is the single validating writer.

---

## 5. Admin UI: `/admin/cleaners`

**Files:**
- `app/admin/cleaners/page.tsx` (`"use client"`, wrapped in `<PinGate>`; no Suspense, since it does not use `useSearchParams`).
- `app/admin/cleaners/page.module.css`.
- `app/lib/cleaners-client.ts`.

Dispatch 18 removed `app/admin/cleaners/NewCleanerCode.tsx`, the one-time code panel. Its guards went with it: `beforeunload`, the `pagehide` and `pageshow` clearing, the header-link confirmation and the in-app Back guard. They existed only because a code could never be shown twice; now it can be shown at any time.

**Styles.** The page imports `../page.module.css` as `shared`. Its own module holds `btnGhost`, `badge`, `badgeActive` (green), `badgeDeactivated` (grey), `badgeOdd` (amber), `createRow`, `codeEditor`, `code` and `rowAction`. The values are copied from `leads/page.module.css`, and that file is not modified.

**Reused unchanged:** `When`, `Absent` and `FieldText` from `../leads/lead-display`, and `NoticeBanner` / `useNotice` from `../components/Notice`.

**One edit** to `app/admin/page.tsx`: in `headerRight`, before "Add Property", add `<Link href="/admin/cleaners" className={styles.backBtn}><Users size={16} /><span>Cleaners</span></Link>`, and add `Users` to the lucide import. There is **no stat card**: it would add a function call per dashboard view, and `.statsGrid` is fixed at 5 columns.

**Layout:**
- **Header:** View Site | divider | "← Properties" (to `/admin`) | divider | `<h1>Cleaners</h1>`. On the right, Refresh (ghost).
- **List state:** `{ kind: 'loading' } | { kind: 'ready', cleaners } | { kind: 'error', title, detail }`.
  - The error state reads "Could not load cleaners", then "It is not empty — it has not loaded.", then the detail in `code`, and a Retry button. **No create form is shown in the error state.**
  - The true empty state reads "No cleaners yet. Create one above."
- **Create row** (in the ready and empty states):
  - A Name input with `maxLength={80}`, `autoComplete="off"` and `spellCheck={false}`.
  - A `btnPrimary` "Create cleaner" button, disabled when the trimmed name is empty and while a request is in flight.
  - On success, a success Notice "Created {name}. Their code is 0429.", and the list is read again.
- **Table:** Name | **Code** | Status | Created (`When`) | Status changed (`When statusChangedAt`) | ID (mono) | Actions.
  - The code is shown in mono, as stored. A cleaner with none on record shows `Absent` ("None on record"); a stored value that is not four digits shows as stored with `badgeOdd`.
  - Status badges: Active, Deactivated, any unknown stored value as-is with `badgeOdd`, and a missing value as `Absent` ("Not recorded").
  - Actions: "Change code" ("Set code" when none is on record), then "Deactivate" when active, "Reactivate" when deactivated, and no status action when the status is unknown.
- **Code editor** (opened by a row's "Change code"; one at a time, above the table):
  - It has the heading "New code for {name}", and the note "Current code: 0429." (or "No code on record."), followed by: "The old code stops working at once and is never given out again. Any phone signed in with it is signed out."
  - A four-digit input (`inputMode="numeric"`, digits only, `maxLength={4}`), "Save code" (enabled at four digits), "or", "Generate one", and "Cancel".
  - Both actions ask first with `window.confirm`. "Save code" asks: "Change {name}'s code from 0429 to 5831? The old code stops working…". "Generate one" asks: "Give {name} a new code, chosen at random? The old code (0429) stops working…".
  - Success replaces the row with the server's cleaner and closes the editor. It shows "{name}'s code is now 5831." with the detail "0429 no longer works." A `changed: false` answer shows the info Notice "Nothing was changed: 5831 is already {name}'s code."
  - A refusal (admin PIN, reserved, taken) shows an error Notice with the server's message and hint, and keeps the editor open.
  - An unknown outcome (no answer, a platform 5xx, or `CLEANER_CODE_CHANGE_FAILED`) shows the warning "The code change may or may not have been saved. Reload to see the stored code."
- **Confirmations for status** (`window.confirm`):
  - Deactivate: "Deactivate {name}? Their code stops working at once and any signed-in phone is signed out. Their entries keep their name."
  - Reactivate: "Reactivate {name}? Their existing code works again. Phones signed in before are still signed out."
- **Changes are not optimistic.** The button reads "Saving…", and the row changes only from the server's `cleaner`. One save runs at a time; every action is disabled meanwhile.
  - A status refusal shows an error Notice with the `describeHttpFailure` title.
  - An unknown status outcome shows a warning Notice: "The change may or may not have been saved. Reload to see the stored status."

**`app/lib/cleaners-client.ts`:**
- `call()` is a copy of the `leads-client` pattern. `leads-client.ts` is not modified.
  - Every request is `no-store` and nothing throws.
  - The result carries `unknown: true` for status 0, for a 2xx with an unexpected body, for a 5xx without app JSON, and for the application codes that say a write may have landed (`CLEANER_CREATE_UNCONFIRMED`, `CLEANER_CODE_CHANGE_FAILED`).
  - A 422's field issues are added to the detail.
- `fetchCleaners()`, `createCleaner(name)`, `changeCleanerStatus(id, status)` and `changeCleanerCode(id, { code } | { generate: true })` all use `call`. The code change expects `data.cleaner.code` to be a string, and equal to the typed code when one was typed.
- **Nothing is retried automatically.** An unknown create is reported with a persistent warning, "The cleaner may have been created. Reload the list: if '{name}' appears, their code is in their row.", kept apart from the Notice slot.

## 6. Receipt storage

**Path:** `receipts/<entryId>/<crypto.randomUUID()>.<jpg|png|webp>`.
- The extension comes from the sniffed type.
- The path never contains a filename, a cleaner name or a property.
- The entry ID carries about 119 random bits and the UUID about 122.

**Write** (`saveReceipt` in `app/lib/cleaners/receipts.ts`):
```
getAdminBucket().file(path).save(bytes, {
  resumable: false,
  contentType: sniffed,
  preconditionOpts: { ifGenerationMatch: 0 },   // create-only: the app can never overwrite a receipt
  metadata: {
    contentType: sniffed,
    contentDisposition: 'inline',
    cacheControl: 'private, max-age=0, no-store',
    metadata: { entryId, cleanerId, sha256, uploadedAt, originalName },
  },
})
```
- `originalName` is `(file.name || 'receipt').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)`. It goes in metadata only, which lets an orphan be attributed and lets test objects carry `__TEST__`.
- **There is never a `firebaseStorageDownloadTokens`, a `predefinedAcl` or `public`.** The object takes the bucket's project-private default ACL.
- **The app contains no receipt-delete code.**
- **Sniffer.** `sniffReceiptType` covers JPEG `FF D8 FF`, PNG signature, and WebP `RIFF….WEBP`. It is **copied** from `upload-image` without AVIF; `upload-image` is not touched.
- The stored `contentType` is the sniffed one.
- The server never transforms the bytes: there is no sharp and no Vercel CPU spent on it. `sha256` is taken over the exact bytes stored.

**Why receipts cannot be listed or guessed:**
- `storage.rules` denies every client get, list and write, and the deployed ruleset matches the file.
- With no download token, `firebasestorage.googleapis.com/v0/…?alt=media` has no credential to accept.
- Bucket IAM and ACLs grant nothing to `allUsers` or `allAuthenticatedUsers`, so `storage.googleapis.com/<bucket>/<path>` is not public.
- The random path is defence in depth.

**Warning.** Opening a receipt in the Firebase console Storage browser can mint a download token, which is a **permanent public URL**. Receipts must never be opened there.

**Size limit enforced:**
- **4 MiB (4,194,304 bytes) per receipt**, with one receipt per request.
- **4,300,000 bytes per request**, checked on `Content-Length` before the body is read.
- Both sit under Vercel's 4.5 MB (4,500,000-byte) platform cap: 4 MiB plus a JSON part of at most 32 KiB plus multipart framing is about 4.23 MB.
- The client shrink targets about 0.8–1.5 MB, so the cap is only a backstop.

**Client-side shrink** (built in dispatch 18 as `app/lib/receipt-photo.ts`):
1. Capture with `<input type="file" accept="image/*" capture="environment">` ("Take photo"), or the same input without `capture` ("Choose from phone"). Each input sits inside its label, so the tap reaches it with no script.
2. Decode through an `<img>` (`image.decode()`), which applies the camera's EXIF orientation, so a receipt shot upright stays upright.
3. Scale to at most **4 megapixels** (4,000,000 pixels) and a long edge of 4096 px. This is a pixel budget, so long receipts stay legible, and it is well under iOS's canvas ceiling of about 16.7 MP. Paint white first, so a transparent PNG does not turn black.
4. `canvas.toBlob('image/jpeg', 0.82)`.
5. If the result is 4 MiB or more, re-encode at 0.72 and then 0.62. After that, shrink by 15% along each edge at 0.62, up to 12 times, **until it is under 4 MiB** (4,194,304 bytes, the server's limit per receipt).
6. If it still does not fit, refuse on the phone: "This photo is too big. Take a new one with the camera."
7. Re-encoding strips EXIF, GPS included, and turns HEIC or PNG into JPEG. A photo the browser cannot decode (HEIC outside Safari) gets "This photo can't be used. Take a new one with the camera."

**Partial failure:**

| Where it fails | Outcome |
|---|---|
| Validation or property check | Nothing is stored. |
| Upload | 502 `RECEIPT_STORAGE_FAILED`. Nothing is in Firestore. |
| Upload succeeded, transaction failed or session revoked | An orphan object at `receipts/<entryId>/…` with no `cost_entries/<entryId>`. The exact path is logged. The object is private, costs cents, and its `entryId` and `cleanerId` metadata say whose it is. Nothing deletes it. It can be detected as a `receipts/<id>/` with no matching entry doc. |
| Entry committed, response lost | Since dispatch 18, sending again with the same one-time key answers 200 `alreadyReceived` and writes nothing (§1d). Only a receipt changed after such a send, which gets a new key, can make a duplicate; the admin rejects it with the reason "duplicate". |

**How an admin views a receipt** (built in dispatch 19, §11.4; the link lives 60 seconds, not the 5 minutes first designed):
- `GET /api/admin/cost-entries/[id]/receipt?i=0`, admin only.
- It reads the entry and the object metadata. **If `firebaseStorageDownloadTokens` is present, it flags `PUBLIC_TOKEN_PRESENT` without modifying the object.**
- It returns a V4 signed URL, valid for 60 seconds, with `responseDisposition: 'inline'`. The URL is signed locally with the service-account key; firebase-admin passes the key to the Storage client.
- Google serves the bytes, so this adds no Vercel bandwidth and the file never runs in the nubnb.ca origin.

**Accepted limitations:**
- Receipt bytes are not in the Firestore export.
- Soft delete gives only 7 days of recovery.
- A console re-upload could replace an object; the stored `sha256` detects it.

---

## 7. Rules files

These are file edits only. They are not deployed and change no behaviour.

**`firestore.rules`** gets this block before the catch-all (as amended in dispatch 18):
```
    // Cleaner cost logging: cleaner accounts, the code index, cost entries
    // and the one-time keys that stop a receipt being logged twice.
    // Server-only, through the Admin SDK, which bypasses these rules. Never
    // readable or writable from a browser: cleaner codes are stored readably
    // (the code is the `cleaner_codes` document ID, and each cleaner holds
    // their current code), so a browser read of either collection would hand
    // out working codes.
    //
    // These blocks add no protection on their own: rules are OR-combined, so
    // an `if false` here cannot cancel an `allow` elsewhere. The invariant is
    // that NO allow rule may ever match these paths. The catch-all below
    // already denies them.
    match /cleaners/{cleanerId} { allow read, write: if false; }
    match /cleaner_codes/{code} { allow read, write: if false; }
    match /cost_entries/{entryId} { allow read, write: if false; }
    match /cost_entry_submissions/{submissionId} { allow read, write: if false; }
```

**`storage.rules`** gets a comment paragraph only; the logic stays deny-all. It says:
- receipts under `receipts/<entryId>/<uuid>.<ext>` are written by `POST /api/cleaner/entries` through the Admin SDK with **no download token**, so they have no public URL;
- admins will read them through short-lived V4 signed URLs;
- receipts must never be opened in the Firebase console, because that can mint a permanent public token.

**Production is already protected without a deploy.** The deployed Firestore catch-all `match /{document=**} { allow read, write: if false; }` and the deployed Storage deny-all already cover the new paths. Verification tests the deployed rules.

---

## 8. Scope, files and what is deferred

**New files in dispatch 17 (18):**
- **`app/lib/cleaners/model.ts`** (client-safe). It holds:
  - collection names and status lists;
  - `LIMITS`: `NAME_MAX` 80, `LINE_NAME_MAX` 120, `LINES_MAX` 100, `NOTE_MAX` 500, `LINE_TOTAL_MAX_CENTS` 99_999_999, `ENTRY_JSON_MAX_CHARS` 32_768, `RECEIPT_MAX_BYTES` 4_194_304, `REQUEST_MAX_BYTES` 4_300_000, `RECEIPT_TYPES`;
  - types: `Actor`, `HistoryEvent`, `CleanerSummary`, `CostEntryView`;
  - defensive readers `readCleanerSummary` and `readCostEntryFields`, labels, and `formatCents`.
- `app/lib/cleaners/secrets.ts`
- `app/lib/cleaners/codes.ts`: `CODE_LENGTH`, `generateCandidate`, `reservedReason` (dispatch 18; the digest functions and labels are gone).
- `app/lib/cleaners/session.ts`: cookie constants, `createCleanerToken`, `parseCleanerToken`, `verifyCleanerSession`, `setCleanerSessionCookie`.
- `app/lib/cleaners/request-guard.ts`: `refuseCrossSite`, `requireMediaType`.
- `app/lib/cleaners/receipts.ts`: `sniffReceiptType`, `extensionFor`, `saveReceipt`.
- `app/lib/firebase/server-cleaners.ts`: `listCleaners`, `issueCleaner`, `setCleanerStatus`, `setCleanerCode` (dispatch 18), `findCleanerByCode`, `readSessionCleaner`.
- `app/lib/firebase/server-cost-entries.ts`: `lookupPropertyName`, `newEntryRef`, `findSubmission` (dispatch 18), `createCostEntry` (transactional), `listCostEntries`, `SessionRevokedError`, `DuplicateSubmissionError` (dispatch 18).
- `app/lib/cleaners-client.ts`
- `app/api/admin/cleaners/route.ts` (GET, POST)
- `app/api/admin/cleaners/[id]/route.ts` (PATCH)
- `app/api/admin/cost-entries/route.ts` (GET)
- `app/api/cleaner/session/route.ts` (POST, GET)
- `app/api/cleaner/entries/route.ts` (POST)
- `app/admin/cleaners/page.tsx`
- `app/admin/cleaners/page.module.css`
- `app/admin/cleaners/NewCleanerCode.tsx` (removed in dispatch 18)
- `scripts/check-admin-pin-vs-cleaner-codes.mjs`

**New files in dispatch 18 (13):**
- `app/api/admin/cleaners/[id]/code/route.ts` (POST: change a code)
- `app/api/cleaner/start/route.ts` (GET)
- `app/lib/firebase/server-cleaner-start.ts`: `readCleanerStart`
- `app/lib/cleaners/text.ts`: `fold`, `matchRank` (client-safe)
- `app/lib/cleaner-client.ts`, `app/lib/cleaner-draft.ts`, `app/lib/receipt-photo.ts` (client)
- `app/cleaner/page.tsx`, `CleanerApp.tsx`, `CodeScreen.tsx`, `PropertyScreen.tsx`, `PhotoScreen.tsx`, `ItemsScreen.tsx`, `DoneScreen.tsx`, `cleaner.module.css`

**Dispatch 18 also changed:** `codes.ts`, `secrets.ts`, `model.ts`, `session.ts` (sign-out cookie), `request-guard.ts` (comment), `server-cleaners.ts`, `server-cost-entries.ts`, the cleaner session and entries routes, both admin cleaner routes, the admin page, its styles and client, the PIN-check script, `firestore.rules`, `app/robots.ts` (`/cleaner` disallowed), this document and `CLAUDE.md`.

**Modified files in dispatch 17 (4):**
- `CLAUDE.md`: one bullet appended to "Accepted risks" (4-digit cleaner codes), on Kian's instruction. Kian's own uncommitted edit is untouched.
- `app/admin/page.tsx`: the header link.
- `firestore.rules`: explicit blocks and comment.
- `storage.rules`: comment only.

**Not touched:**
- `verify-admin.ts`, `/api/admin-auth` and `PinGate`. Admin auth is settled.
- `upload-image`.
- `leads-client.ts` and `server-leads.ts` (`isDocumentId` is imported as is).
- `scripts/export-firestore.mjs`, including `EXPECTED_COLLECTIONS`. New collections are exported anyway and flagged "beyond the expected set".
- `app/layout.tsx`, Providers, every public page and component, and `sitemap.ts`. (`robots.ts` gains `/cleaner` in dispatch 18.)
- `.env.local`. Verification injects its secrets through the process environment.

**Nothing new is added to public page views.** No public file, layout or middleware changes. `/admin/cleaners` and `/cleaner` are static (○) pages. The new functions run only on admin or cleaner actions, and nothing new is read at build time.

**Deferred:**

| Item | Where it goes |
|---|---|
| ~~The `/cleaner` page: code gate, property search, entry form, client shrink, logout~~ | Built in dispatch 18 (§10) |
| ~~"My entries" for a cleaner (their own, never another's)~~ | Built in dispatch 19 as "My receipts" (§11.6) |
| ~~`robots.ts` disallow plus `noindex` for `/cleaner`~~ | Done in dispatch 18 |
| A non-secret "has session" hint cookie at `Path=/cleaner`, so an anonymous view makes no function call | Not done: the page makes one call on opening. Only cleaners open it. |
| Property list from a static or CDN list | Not done: `GET /api/cleaner/start` reads the property names (about 44 reads) once per opening, not per search. The search runs on the phone. |
| ~~Approve and reject routes (appending `history` with the admin Actor), the admin entries screen, the signed-URL receipt view with the token flag~~ | Built in dispatch 19 (§11) |
| List pagination | Not needed yet: the page reads the collection whole; revisit near 1,000 entries |
| ~~Code reissue~~ | Done in dispatch 18 as the admin's code change (§3.12) |
| Cleaner rename | Later |
| ~~Idempotent submission~~ | Done in dispatch 18 (§1d) |
| Orphan-receipt audit, public access prevention `enforced` on the bucket (verify property token URLs first), temporary holds on receipts | Later |

---

## 9. Verification summary

**Dispatch 17** was verified on 2026-09-28 against a local production build reading production data. Its steps are recorded here only where they still apply:
- Receipt storage (VS).
- Browsers denied every new collection (V4).
- No new function call on a public page view (V5).
- Existing documents byte-identical and the Storage count unchanged (V6).

Its code-issuance steps (V1 and V1-dup: the one-time panel, the exhaustive hash search, the pepper mismatch) and its in-app Back guard check tested what dispatch 18 removed, and are retired with it. The repo has no automated test suite; there were no test files to remove.

**Dispatch 18 ground rules** are those of dispatch 17:
- A **local production build reading production data**, never the live admin panel.
- `next start` with a **throwaway 4-digit `ADMIN_PIN`** (checked to differ from production) and a throwaway `CLEANER_SESSION_SECRET`, injected into the process environment.
- Output pasted raw, with tokens masked. Every printed code is checked against the production PIN first; the PIN is never printed.
- `scripts/export-firestore.mjs` runs first, before any write.

| Dispatch bullet | Steps |
|---|---|
| An admin can read every code and change one; the old code stops working; entries keep their name and history | The list with codes; a code change (typed and generated) through the real route; the old code's login 401 and the new one's 200; the old session cookie 401; the raw cleaner and code documents; an entry written before the change still names the cleaner, unchanged |
| A duplicate code, the admin PIN and a reserved code are each refused | 409 `CLEANER_CODE_TAKEN` (in use, and replaced), 422 `CLEANER_CODE_IS_ADMIN_PIN`, 422 `CLEANER_CODE_TOO_EASY`, each with the documents unchanged |
| A cleaner's code opens nothing in /admin; the admin PIN opens nothing on the cleaner route | `POST /api/admin-auth` with the code 401, PinGate "Incorrect PIN", the admin-route matrix with the cleaner cookie 401; the throwaway and production PINs (the latter read by script, never echoed) 401 at `POST /api/cleaner/session` and on the `/cleaner` code screen |
| The full cleaner flow on a phone-sized viewport | `/browse` at phone size: code, property search, photo, two itemised lines, send, confirmation; the raw entry, its submission document and its receipt object; then deletion by ID |
| A dropped connection mid-entry loses nothing | The same build stopped mid-entry and after a send; reload; the draft and photo come back; a repeated send answers `alreadyReceived` |
| Every existing document byte-identical; Storage count unchanged | Cleanup by exact ID and path after asserting each target is `__TEST__`; closing export; per-document compare against the opening export (KiKi's two documents excepted, deleted by Kian's ruling); full Storage listing compare |

**Deleted test objects stay soft-deleted for 7 days.**

---

## 10. The cleaner app: `/cleaner` (dispatch 18)

**Route and page.** `app/cleaner/page.tsx` is a static page (○), separate from /admin.
- It exports `robots: { index: false, follow: false }`, and `robots.ts` disallows `/cleaner`.
- It holds no data. Everything comes from `/api/cleaner/*` behind the cleaner cookie (path `/api/cleaner`), which the browser sends nowhere else.
- The page links nowhere in /admin.

**Built for** someone of 50 or more, on a phone, possibly one-handed, in a hallway:
- one task per screen, few words, no jargon;
- body text at 20px, and targets at least 48px, the main ones 60–64px;
- one light theme whatever the phone's setting;
- the main button at the bottom, within reach of a thumb;
- the phone's Back button goes to the step before.

**Screens** (Kian chose the photo before the items):
1. **Code.** Four boxes and the number pad, nothing else.
   - One real input lies over the boxes, so typing, deleting and pasting behave normally. The fourth digit sends it.
   - A wrong code shakes and clears the boxes and shows "Code not recognised"; the keyboard stays up.
   - Failures read "No connection. Try again." or "Something went wrong. Try again."
2. **Property.** "Hi {first name}" and "Sign out"; "Which property?"; a search box; then one big row per property (name, city).
   - The properties this cleaner logged against come first, most recent first, marked with a clock. Then all the rest, A to Z.
   - Search matches the name or the city, ignoring capitals and accents.
3. **Photo.** "Photo of the receipt": a big "Take photo" (camera) and "Choose from phone".
   - The photo is shrunk on the phone (§6), then shown with "Next" and "Take again".
4. **Items.** "What did you buy?", with a "See the receipt" thumbnail that opens full size.
   - One card per line: **Item** (suggestions as they type), **How many** (− value +), and **Amount on receipt** (the amount printed on that line, D1; `$`, number pad). Under the amount, a line that follows How many: "As printed on the receipt", or "For all 3 together, as printed" (dispatch 19; it read "Price paid" before, which could mean per item).
   - Then "Add item" and "Start over". The bar at the bottom holds "Total $…" and "Send", with a progress bar while sending.
   - Anything missing is named under its field ("Type the item", "Type the price", "Check how many"), and the first one is scrolled into view.
5. **Sent.** A green check, "Sent", the property, "{n} items · $…", and "Log another receipt".

**Defaults (reported before the build, not overruled):**
- No purchase date or note on screen; both are stored as `null`, and the photo shows the date.
- Positive prices only: an iPhone's number pad has no minus key, so a receipt's discount line is left to the admin, who has the photo.
- English only.

**Nothing typed is lost** (`app/lib/cleaner-draft.ts`):
- **Where it is kept.** The draft (property, lines, step, one-time key) is written to localStorage on every change, under the cleaner's ID. The prepared photo goes to IndexedDB under the same ID, tagged with a `photoKey` the draft names.
- **When it is cleared.** Both are cleared only when the server confirms the entry.
- **What survives.** A dropped signal, a closed page, a flat battery or a sign-out keeps them. A session that ended (a code change, a deactivation, 12 hours) brings back the code screen, and after the code the receipt as it was.
- **Other cleaners on the same phone** get their own draft and never see this one.
- **If the phone refuses storage,** the screen says "This phone can't keep a copy. Keep this page open until it is sent."
- **Sending.** It uses the draft's one-time key (§1d).
  - No answer, a timeout, or a server failure: "Not confirmed. Tap Send again — it won't be counted twice."
  - No signal: "No signal. Your receipt is saved on this phone. Send it when you have signal."
  - A refusal that means the photo must be retaken goes back to the photo; a property that no longer exists goes back to the list.

**Suggestions and what a cleaner sees.** `GET /api/cleaner/start` (`readCleanerStart`) returns:
- the cleaner's own ID and name;
- every property's ID, name and city (the public site shows these anyway);
- the properties this cleaner logged against, most recent first, from their own entries;
- item names from everyone's 300 newest entries — **words only: no cleaner, property, date, quantity or amount**.

Names that differ only in capitals, accents or spacing are one name, offered in the spelling used most, most used first (up to 500). No other cleaner's entry reaches a cleaner.

**Costs.** Opening the app is one function call:
- The start read costs about 45 reads today (1 session + 44 properties) and grows with entries, but is capped for everyone's entries at 300.
- A send is one call: 3 reads, a transaction of 2 reads and 2 writes, and one Storage upload of a photo of about 1–2 MB.
- Signing in is one call and 1–2 reads.
- Nothing is read per keystroke or per search.

---

## 11. Review, receipts and reports (dispatch 19)

**Kian's decisions (2026-09-29), all as recommended:**
- **D1:** `lines` stays exactly as the cleaner sent it. A correction is a history event carrying the line before and after; the lines that count are computed on read and never stored.
- **D2:** an admin can add a line — above all the discount or return a phone's number pad cannot enter. Dropping a line is correcting it to $0.00.
- **D3:** reports hold approved entries only; the page asks first when pending entries fall in the period. The table shows pending apart.
- **D4:** the PDF adds "What was bought" and a 6-character reference, and names no cleaner.
- **D5:** "per-house inventory" is an **Items bought** tab for one property: every line that counts, in the range.
- **Defaults kept:** the receipt link lives 60 seconds; a rejection needs a reason, which the cleaner sees; dates are the day an entry was sent, in Toronto time; the page opens on all time.

### 11.1 Stored shape

- **Status** gains `removed`: `pending | approved | rejected | removed`. Approve, reject and remove each work from any other status (approving undoes a removal); nothing goes back to pending. **Counted:** approved and pending. **Not counted:** rejected, removed, and any unknown stored status.
- **Status events:** `{ at, action: 'approved' | 'rejected' | 'removed', from: <status before>, to, actor: admin, reason }`. `statusReason` holds a rejection's reason and is `null` otherwise; an earlier reason stays in its event.
- **Line events:** `{ at, action: 'line_corrected' | 'line_added', from: null, to: null, actor: admin, reason: null, line: { index, before, after } }`. `index` is the line's place from 0; added lines come after the sent ones; `before` is `null` on an added line.
- **The lines that count** (`readLinesNow` in model.ts): the sent lines with every line event applied in order, each corrected line keeping its earlier versions. A stored amount that is not whole cents, or a line event that cannot be applied, makes the entry **unreadable**: shown, flagged, never added into a total, and not correctable here.
- **New history words** (permanent): `approved`, `rejected`, `removed`, `line_corrected`, `line_added`. The actor is `{ role: 'admin', id: null, name: null }`: one shared PIN, so never which admin.
- **Every review is one transaction.** The page sends `seen`, the history length it shows; if the stored history is longer, nothing is written and the answer is 409 `ENTRY_CHANGED`. The history is read and written back whole (never `arrayUnion`). No `set()`, no `delete()`, no new collection, index or rules change.

### 11.2 Routes

| Route | Door | Request | Success | Refusals |
|---|---|---|---|---|
| `POST /api/admin/cost-entries/[id]/status` | admin | `{ status: 'approved' \| 'rejected' \| 'removed', reason?, seen }` | 200 `{ entry: CostEntryView, changed }` | 422 (a rejection without a reason; a reason on anything else); 404 `ENTRY_NOT_FOUND`; 409 `ENTRY_CHANGED`; 500 `ENTRY_RECORD_UNREADABLE`; 502 `ENTRY_REVIEW_FAILED` ("may or may not have been saved") |
| `POST /api/admin/cost-entries/[id]/lines` | admin | `{ index: number \| null, line: { name, quantity, lineTotal }, seen }` | 200 `{ entry, changed }` | 422 (the line, as the cleaner's is validated; `lineTotal` may be negative); 422 `ENTRY_LINE_NOT_FOUND` / `ENTRY_TOO_MANY_LINES` (120); 404, 409, 500, 502 as above |
| `GET /api/admin/cost-entries/[id]/receipt?i=0` | admin | none | 200 `{ url, expiresAt, seconds: 60, publicToken }` | 404 `ENTRY_NOT_FOUND` / `RECEIPT_NOT_ON_ENTRY` / `RECEIPT_OBJECT_MISSING`; 502 `RECEIPT_LINK_FAILED` |
| `GET /api/cleaner/entries` | cleaner | none | 200 `{ entries: CleanerEntry[] }`, newest first | 401 `CLEANER_SESSION_INVALID`; 503 `CLEANER_ENTRIES_UNAVAILABLE` |

- The two admin writes follow the admin route order of §4, `refuseCrossSite` and `requireMediaType` included. `GET /api/admin/cost-entries` now carries `linesNow` on each entry.
- **The receipt route** reads the path from the entry (field mask `receipts`) and accepts only a path under `receipts/`; the path is never taken from the request or returned. It reads the object's metadata, flags a `firebaseStorageDownloadTokens` without changing it, and signs a V4 read URL for 60 seconds, `inline`. The URL is never logged; failures log a code only.
- **The cleaner route** queries `where('cleanerId', '==', <session cleaner>)`, checks each document again, and returns per entry: when sent, the property's ID and recorded name, how many lines were sent, the total now and as sent, whether corrected, the status, and the reason only when rejected. No receipt, no history, nothing of anyone else's.

### 11.3 The costs page, `/admin/costs`

- Static, behind PinGate; a "Costs" link beside "Cleaners" in the /admin header. One call on opening (the list); a review is one call; a receipt is one call for its link; exports are none.
- **Filters:** property, status (with counts), From and To dates, and presets This month / Last month / This year / All time (the default). Mirrored into the URL with the view and the open entry.
- **Totals for what is shown:** one row per property, and all together: entries, approved, pending, counted, and what is not counted (rejected, removed, unknown status; unreadable entries said apart).
- **Table:** sent (Toronto time), property, cleaner, total (✎ when corrected), status, receipt. Rejected and removed rows stay, dimmed, their totals struck through.
- **Entry pane:** status and the actions (Approve; Reject… with a required reason; Remove… after a confirm); the receipt; the items with each earlier version struck through beneath its line, "Added by admin" on added lines, Correct under each line and Add a line; the cleaner's note and purchase date when present; the full history.
- **States:** "Could not load cost entries — It is not empty — it has not loaded." with no table, totals or export; "No cost entries yet"; "No entries match these filters"; "Could not load the receipt" with Retry, never "no receipt". An answer that does not say whether a review landed shows "The change may or may not have been saved. Refresh to see what is stored."

### 11.4 Receipts

- The page puts the signed URL straight into an `<img>` (`referrerPolicy="no-referrer"`) and keeps it nowhere else; "Full size" enlarges the same element, so the image is never fetched twice. GCS serves the bytes with the object's `Cache-Control: private, max-age=0, no-store`, so nothing costs Vercel bandwidth.
- **The limit, as reported to Kian:** a signed URL is a bearer link. Copied out of the page, it works until it expires — at most 60 seconds.

### 11.5 Reports

- **Built in the browser** from the page's data (`app/lib/costs/report.ts`), with no package: `xlsx.ts` writes the workbook (a stored ZIP, `zip.ts`, of seven XML parts with inline strings), `pdf.ts` writes PDF 1.4 with the built-in Helvetica faces and Adobe's metrics (text in WinAnsiEncoding: accents print; an emoji prints "?").
- **One property, one period, approved entries only**, oldest first. An open start is the property's first entry; an open end is today. A report is refused while an approved entry in it cannot be read.
- **PDF** (Letter, portrait; header row repeated per page; "Page n of m"): NUBNB · PROPERTY COSTS, the property, the period, "Approved costs, in Canadian dollars"; `#`, date, what was bought, ref, total (`*` when corrected); entries count and period total; the notes "* Corrected by Nubnb against the receipt.", "Amounts in brackets were taken off…" (when there are any) and "Each entry is one receipt…"; generated at, Toronto time. No cleaner's name.
- **What was bought** (Kian, 2026-09-29): the names of the lines that cost something, once each, then every discount or return with its amount — "Instant savings (-$5.00)" — so each total can be read from what is listed. A line of exactly $0.00 adds nothing and is left out. When the column is too narrow the item names are cut with "…"; the money taken off never is. The Excel Entries sheet lists the same, uncut.
- **Excel:** sheet Entries (date sent, ref, entry ID, cleaner, what was bought, lines, total, corrected; period total) and sheet Items (date sent, ref, item, quantity for reference only, line total as printed, corrected / added by admin; total). Real dates and numbers; totals written as values worked out in whole cents, not formulas.
- File names: `nubnb-costs-<property>-<from>-to-<to>.xlsx|pdf`.

### 11.6 The cleaner app

- **The amount's label:** "Amount on receipt", and under it a line that follows How many: "As printed on the receipt", or "For all 3 together, as printed". The error reads "Type the amount". The admin side says "Qty (reference)" and "Line total as printed", with "Each amount is what the receipt prints for that line, for all of that item together. Quantities are for reference and are never multiplied." Stored entries are untouched; the draft's field keeps its name, so drafts on phones survive.
- **My receipts:** a button beside Sign out and on the Sent screen. The cleaner's own receipts, newest first: property, total (struck through when rejected or removed), date, items, and "Waiting for review" / "Approved" / "Rejected" with the office's reason / "Removed"; "Changed by the office. You sent $X." when corrected. A list that did not load says so. It is a view over the steps, not a step: the draft is untouched, and Back returns.

### 11.7 Verification (2026-09-29)

Against a local production build reading production data (no `.env.local` in the build copy; throwaway `ADMIN_PIN` and `CLEANER_SESSION_SECRET`), with `__TEST__` cleaners and entries sent through the real cleaner route:
- the table, filters, presets, custom dates and totals, including rejected and removed rows left out of every sum and the Items tab adding up to the counted total;
- approve, reject, correct, add and remove through the page and the API, each recorded in the history with the line before and after, `lines` unchanged in the raw document; 409 `ENTRY_CHANGED` on a stale history, both from the API and from a real two-sided change in the page;
- a receipt shown through its link; the same link fetched with no cookie answered 200 with the stored SHA-256, and 400 `ExpiredToken` after its minute; the object's metadata showed no download token and was never updated;
- the Excel file opened in Microsoft Excel and the PDF in poppler and Quick Look, with the right numbers and period;
- each cleaner saw their own receipts and not the other's, in the API and on a phone-sized screen, and the new label and hint;
- genuine failures (a service-account key Google does not know): "Could not load cost entries", "Could not load the receipt", and a review reported as possibly unsaved while nothing was written;
- cleanup by exact ID and path after `__TEST__` checks; the closing export byte-identical to the opening one (49 documents), and Storage unchanged at 4,640 objects. Deleted test receipts stay soft-deleted for 7 days.

**Second round (Kian, 2026-09-29):** discounts shown in "What was bought", and the dates at a month boundary.
- Two `__TEST__` entries were written directly in the route's shape (the route stamps its own clock) at `2026-09-01T03:59:30.000Z` and `2026-09-01T04:00:30.000Z`: 23:59:30 on 31 August and 00:00:30 on 1 September in Toronto, both 1 September in UTC. The discount was added and both were approved through the real routes.
- In a browser running on Asia/Tokyo time (both instants on 1 September there), the page put the first in August and the second in September: Last month, This month, and single-day ranges either side of midnight. The August and September Excel files and PDFs, opened in Excel, poppler and Quick Look, held one entry each, dated 31 Aug and 1 Sep.
- The September PDF listed `__TEST__ Paper towel…, __TEST__ Instant savings (-$5.00)`: the item names cut, the discount whole. A $0.00 line stayed out of the summary.
- Deleted by ID; the closing export byte-identical to the opening one, and Storage unchanged.

---

## 12. Reading the receipt with Gemini (dispatch 20)

**Rulings (Kian, 2026-09-30):** the model is `gemini-3.8-flash` with thinking pinned low. The purchase date is never filled from the reading: the cleaner enters it, or it stays empty as today. A purchase date more than 12 months in the past, or any date in the future, is refused wherever one is entered. Manual entry is always the fallback; the reading fills the form and never blocks it, and what the cleaner confirms is what is stored. The raw reading is stored beside the entry so its accuracy can be measured. The receipt image is stored exactly as before.

### 12.1 What was measured first (2026-09-30)

Nine of Kian's receipt photos (Dollarama, Walmart ×5, Canadian Tire, Home Depot ×2), as WhatsApp-compressed copies at 1200×1600 or 739×1600, graded by eye before any result: six met the standard a cleaner can be asked for, three did not (a receipt small in a wide shot; one on a shiny wrinkled pack; one shot from far away). Each was hand-transcribed, the transcriptions checked by arithmetic (items = subtotal, 13% = tax, subtotal + tax = total) and two of them confirmed by Kian.

- **Amounts and totals:** right on every reading — 54 readings of the nine photos over three models (`gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`) and two passes. No line was ever dropped, invented or duplicated, including a 12-line receipt.
- **Names:** on the standard photos, verbatim on every model. On the poor photos, single-character garbles in product-code names (a 5 read as S, O as C): 3.8-flash 2 of 92 line-readings, 3.5-flash-lite 12, 3.1-flash-lite 18.
- **Dates:** unreliable with two-digit years. "20/09/26" came back as 2020-09-26, "26/09/14" as 2014-09-26, "09/14/26" once as 2024-09-14. Hence the two rulings above on the date.
- **What did not matter:** crumpling, wrinkles, glare, a busy background, and source pixels (a standard photo shrunk to 400×533 still read perfectly). **What did:** the receipt being small in the frame. Cropping the same pixels did not help. Gemini bills about 1,070 image tokens whatever the input size, so it works from a fixed-size rendition; framing decides how much of it is receipt.
- **Time and cost, thinking low:** 3.8-flash median about 2 s, slowest 3.1 s in the passes (one 6.3 s outlier when it chose to think); $0.0019 a receipt, $0.40 per 200 a month, $0.79 after the price change of 2026-12-31. With the default thinking level it spent 650–1,100 thinking tokens and 4–5 s.
- **Run to run:** 27 of 27 readings had identical amounts across the two passes; 23 were identical line for line.
- `gemini-2.5-flash-lite` is retired for new users (404 on every call).

The harness, raw output and photo grades are in the session scratchpad (`measure-receipts.mjs`, `compare-receipts.mjs`, `REPORT-step1-raw.md`), not in the repo.

### 12.2 The flow

1. **Photo.** Above "Take photo", three lines from the measurement: *Lay the receipt flat. Hold the phone straight above it. Get close, so the receipt fills the screen.*
2. **As soon as the photo is kept**, the app sends it to `POST /api/cleaner/read-receipt` and moves on. The cleaner never waits on a blank screen.
3. **Items.** Under the photo a quiet line: "Reading the receipt…"; then "*n* items read from the photo. Check each one." (and, when the receipt had lines the phone cannot take: "One line on the receipt (-$5.00) couldn't be added here, so the total below will differ from the receipt."); or "The receipt couldn't be read. Type the items."
   - Each line the reading filled carries **From the photo**; once changed, **Edited**. Every line can be changed, removed, or added to.
   - Lines the cleaner typed before the answer came stay exactly as typed; the reading's lines go **underneath** them, never over them. Blank lines nobody touched make way.
   - A line with no amount, a negative amount (discount, return), zero, or more than the form's maximum is not put on the form (the phone cannot enter it; the admin adds it with the photo in hand, §10). It is counted in the note and stays in the raw reading.
   - A retaken photo drops the reading and the lines it filled that were never touched; typed and changed lines stay.
4. **Send** carries the entry as before, plus the `reading` part when the photo had an answered reading. A reading still on its way when Send is pressed is simply not sent; nothing waits for it.
5. **The purchase date** is never filled: the form has no date field (§10), and the reading's `purchasedOn` is kept only in the raw record.

### 12.3 What is stored

- **The entry** (`cost_entries`) is unchanged in shape: the lines the cleaner confirmed, exactly as before. No field of it comes from the model.
- **The reading** goes to its own collection, **`cost_entry_readings/{entryId}`**, created in the entry's transaction, so an entry has its reading or has none, never half. It is evidence about the model, not a claim about the purchase; nothing in the review page, the reports or the cleaner's list reads it.

```json
{ "schemaVersion": 1, "entryId": "…", "cleanerId": "…", "createdAt": "2026-09-30T…Z",
  "reading": { "id": "<uuid>", "requestedAt": "…", "model": "gemini-3.8-flash", "modelVersion": "gemini-3.8-flash",
               "thinkingLevel": "LOW", "ms": 2086, "status": "ok", "reason": null,
               "usage": { "promptTokens": 1459, "outputTokens": 170, "thoughtsTokens": 0 },
               "output": { "store": "Walmart", "purchasedOn": "2026-09-20", "lines": [ { "name": "S/CURT LINER", "quantity": null, "amount": "3.97", "kind": "item" }, … ],
                           "subtotal": "21.38", "total": "24.16", "unreadable": false, "notes": null },
               "rawText": null },
  "lines": [ { "index": 0, "name": "S/CURT LINER", "quantity": null, "amount": "3.97", "kind": "item", "outcome": "unchanged", "entryLine": 0, "edited": [] },
             { "index": 2, "name": "LYS APC 950", "quantity": null, "amount": "6.47", "kind": "item", "outcome": "edited", "entryLine": 2, "edited": ["name"] },
             { "index": 4, "name": "HST", "quantity": null, "amount": "2.78", "kind": "tax", "outcome": "left_out", "entryLine": null, "edited": [] } ],
  "added": [4],
  "summary": { "modelLines": 5, "unchanged": 3, "edited": 1, "leftOut": 1, "added": 1, "sentLines": 5 } }
```

- `reading` is the model's answer as returned (`output`), with the model, version, thinking level, wall-clock milliseconds, token usage, and on failure a `reason` (`timeout`, `network`, `http_<status>`, `unparsable`, `no_output`, `blocked`, `over_limit_cleaner`, `over_limit_day`). A failed reading is recorded too, so the failure rate is measurable.
- `lines` is computed by the server when the entry is written, from the model's lines and the cleaner's: **`unchanged`** (sent exactly as read), **`edited`** (with the fields changed: `name`, `quantity`, `amount`), **`left_out`** (removed by the cleaner, or never put on the form). `added` lists the entry lines the cleaner typed themselves. A line the cleaner did not touch counts as confirmed by them: they pressed Send.
- **How the record travels.** The reading happens before the entry exists, so the read route returns the record as text and a signature (HMAC-SHA256 under a key derived from `CLEANER_SESSION_SECRET` with its own label), and the phone keeps both, verbatim, in its draft. The entry route accepts a reading only as the exact signed text, for the session's cleaner, with a `fromReading` map of the right length whose indexes are distinct and in range (`parseReadingPart`). Anything else is dropped, logged in one line, and the entry is written all the same with `readingStored: false`. The reading never blocks the entry.
- **Rules.** `firestore.rules` denies browser access to `cost_entry_readings` and `receipt_reading_quota` explicitly, as for the other cleaner collections. The export script exports every root collection, so both are in every backup, flagged "beyond the expected set" like the others.

### 12.4 Routes

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /api/cleaner/read-receipt` | cleaner | multipart, exactly one part `receipt` (JPEG/PNG/WebP, ≤ 4 MiB, sniffed) | 200 `{ readingText, signature }`; 503 `RECEIPT_READER_NOT_CONFIGURED` (no key), 503 `RECEIPT_READER_UNAVAILABLE` (no slot); the usual 401/403/413/415 |
| `POST /api/cleaner/entries` | cleaner | as before, plus an optional `reading` part (JSON ≤ 65,536 chars) | 201 as before, plus `readingStored` |

Order on the read route: cross-site, session (before the body), Content-Length, media type, the one part, declared type, real bytes, keys, the reading slot, then the model. It stores nothing of the photo; the entry's send stores the receipt as before. Nothing of the key, the photo or the reading is logged; only outcomes, milliseconds and status codes.

### 12.5 Cost and the runaway-bill guard

- **Per receipt:** about $0.0019 on the measured photos (1,459–1,473 input tokens, of which about 1,070 the image; 100–620 output tokens; thinking usually 0 at level low). **Per month at 200 receipts: about $0.40**, and about $0.79 once Google's price for 3.8-flash doubles on 2026-12-31. Worst case per reading with the output cap of 8,192 tokens: about $0.03.
- **Limits, in `READING_LIMITS`:** 40 readings per cleaner per Toronto day, 300 per day for everyone. Taken as a slot in a transaction on `receipt_reading_quota/YYYY-MM-DD` (`total`, `byCleaner`) before the model is called; over the limit the phone gets a signed `failed` record with `over_limit_cleaner` or `over_limit_day` and the form to type into. **At the limits, a day costs at most about $0.60 and a month about $18 even if every slot were taken;** with the output cap, at most about $9 a day. A slot that cannot be taken is no reading (fail closed on cost). One read and one write per reading.
- **Behind it,** Google's per-project quota for the Generative Language API, set in the Cloud console for the key's project by Kian, is the backstop this code cannot provide.
- **Time:** the server waits at most 20 s for the model (`READING_LIMITS.TIMEOUT_MS`), the phone 45 s for the whole call; `maxDuration` is 30 s.
- **Vercel:** one function call per reading, in addition to the send. The photo (about 0.1–1.5 MB) goes up once more than before. Nothing new at build time or on any public page.

### 12.6 The key and the environment

- **`GEMINI_API_KEY`** in Vercel Production and `.env.local`. Read inside the request (`getGeminiSecrets`), never at module scope, never logged, never in a `NEXT_PUBLIC_` variable; the module that reads it is imported only by the read route. Without it the read route answers 503 and the app types. It must belong to a Google Cloud project **with an active billing account**, for the reason in §12.7.
- **`GEMINI_API_BASE`** (optional) replaces the Google host; verification points it at a stub that answers slowly or not at all. Unset in production.

### 12.7 Privacy (recorded in CLAUDE.md as Kian's decision)

Receipt images leave Nubnb's systems and go to Google's Gemini API. A receipt shows what was bought, where, when, and sometimes a card's last four digits, and cleaners write the property's address on some. Google's Gemini API Additional Terms of Service (https://ai.google.dev/gemini-api/terms, effective 2026-03-23, read 2026-09-29) say, under "How Google Uses Your Data" for Paid Services: *"Google doesn't use your prompts (including associated system instructions, cached content, and files such as images, videos, or documents) or responses to improve our products"*, that Google *"logs prompts and responses for a limited period of time, solely for detecting and preventing violations of the Prohibited Use Policy"*, and that this data *"may be stored transiently or cached in any country in which Google or its agents maintain facilities"*. For Unpaid Services the same section says Google *uses* the content *"to provide, improve, and develop Google products and services and machine learning technologies"* and that *"human reviewers may read, annotate, and process your API input and output"*. The terms define the distinction: *"Your access to Gemini API is a 'Paid Service' only when accessing the API through a Cloud Project associated with an active billing account."* The key must therefore come from a billing-enabled project, and that is Kian's to confirm; nothing in the code can tell.

### 12.8 The date rule

`purchasedOnProblem` in `server-cost-entries.ts`: a real calendar day, no later than today and no earlier than the same day 12 months ago (`monthsBefore`, clamped to the month's end), both on the Toronto calendar (`ENTRY_TIME_ZONE`, the reports' zone). Every purchase date enters through `EntryInputSchema`, so the rule holds wherever one is entered; today the cleaner app has no date field and sends none. Entries already written keep their dates: validation runs only on a write, and there are no backfills.

### 12.9 Verification (2026-09-30)

Against the repo's production build (`next start` on 4620 and 4621) reading production data, with a throwaway `ADMIN_PIN` and `CLEANER_SESSION_SECRET` in the environment, the real `GEMINI_API_KEY`, and two `__TEST__` cleaners created through the admin route. Opening export `backups/2026-09-30T13-33-18Z` (49 documents, `contact_submissions` and `properties` only: production held no cleaner data).

- **The full flow on a 390×844 screen** (headless Chromium): code, property, the photo screen with its three lines, a photo chosen from the phone, "Reading the receipt…" the moment the items screen opened, then "5 items read from the photo. Check each one." with five lines tagged *From the photo* and the total $24.16 as on the paper. One name corrected (tag became *Edited*), one line added, Send. The stored entry `cost_entries/CHoaMHAYANmUuU7rRsw8` held the six lines exactly as on screen (397, 397, 647 "Lysol all-purpose cleaner", 697, 278, 10 "__TEST__ Bag fee"). `cost_entry_readings/CHoaMHAYANmUuU7rRsw8`, written in the same transaction (same `updateTime`), held the model's five lines and total, `ms` 4709, usage 1459/170/0, and outcomes `unchanged, unchanged, edited [name], unchanged, unchanged`, `added [5]`, summary `{modelLines 5, unchanged 4, edited 1, leftOut 0, added 1, sentLines 6}`.
- **A slow read** (a stub answering after 8 s through `GEMINI_API_BASE`): the cleaner typed "__TEST__ Typed first $1.00" one second after the items screen opened; eight seconds later the five read lines appeared underneath it, the typed line untouched and first, and the stub's discount line (−$1.00) reported as left out in the note.
- **A failed read** (the stub answering 500): "The receipt couldn't be read. Type the items." with the photo still shown; a typed line sent as entry `UJU30q97hvaLly5yzm5N`, whose reading document recorded `status failed, reason http_500, ms 4`, no lines, `added [0]`.
- **A hanging model:** the route answered in 20.3 s with a signed record `failed / timeout / 20009 ms`.
- **The limit:** through the real route, the 41st reading of the day for one cleaner came back `failed / over_limit_cleaner` and `receipt_reading_quota/2026-09-30` read `total 40, byCleaner {…: 40}`.
- **The date rule:** `purchasedOn` tomorrow → 422 "The date cannot be in the future"; 13 months ago and 2020-05-05 → 422 "The date must be within the last 12 months"; 11 months ago → 201 and stored.
- **A tampered reading part** (one amount changed in the signed text): 201 with `readingStored: false`, no reading document, one log line; the entry itself written.
- **Refusals on the read route:** no cookie 401, JSON body 415, cross-site 403, a JSON file declared as JPEG 415 `RECEIPT_NOT_AN_IMAGE`.
- **The key:** the browser's network log showed requests to `localhost:4620` only (start ×2, session, read-receipt, entries); the key's first 12 characters, the string `GEMINI` and the host `generativelanguage` occur in no file under `.next/static` (they occur in 2 server bundles); the read route's response body did not contain the key.
- **Cleanup** by exact ID and path: 13 documents (2 cleaners, 2 codes, 3 entries, 3 submissions, 2 readings, the day's quota) and 3 receipt objects, each confirmed gone. Closing export `backups/2026-09-30T13-42-28Z`: `contact_submissions.json` and `properties.json` byte-identical to the opening export; Storage 4,640 objects before and after (4,643 in between). Deleted receipts stay soft-deleted for 7 days.
- Cost of the verification's real readings: 2 calls to Gemini (about $0.004).

**Not exercised:** a real phone camera (the photo came from a file), a receipt photographed sideways, and the day limit of 300.

---

## 13. Tax apart, a locked read, a camera frame, cleaner-facing names, the queue and the ledgers (dispatch 21)

**Rulings (Kian, 2026-09-30):** tax is its own field on the entry, never a line among the items; the form is locked while the receipt is read; the camera shows a frame that never blocks a photo; each property may carry a name cleaners see; `/admin/costs` is the review queue, and each property's page is its ledger of approved entries. Delete keeps dispatch 19's behaviour: excluded, still visible, marked, prior state readable.

### 13.1 What the investigation found first

Kian reported that admins could not see or review cost logs. On production, `/admin/costs` answered 200, its API refused without a session, and the admin header carried the Costs link. On a local build of the deployed commit reading production, the page listed the one entry Kian had logged (pending, $110.47), rendered its receipt from Storage, showed Approve, Reject and Remove and the Correct buttons, and the Excel export downloaded once a property was chosen, after a confirm that the pending entry was not in it: "0 approved entries · $0". Nothing was broken. What the page did not do: open as a queue, hold anything in a report until an entry was approved, or keep the tax apart from the items (that entry stored "HST 13.0000 %" as line 8).

### 13.2 Tax is a field

- **New entries** (schemaVersion 2) carry **`taxCents`**: whole cents, or `null` when the cleaner gave none. Always present on the document. The entry rule is unchanged: the lines must add up to more than zero; the tax is never negative.
- **How the two shapes are told apart:** by the presence of the `taxCents` field on the document (`taxShape` in model.ts: `field` when present, even as null; `in-lines` when absent). Never by the schema version alone, and never by a line's name. An older entry keeps whatever tax the cleaner typed as a line among its items, exactly as sent; nothing is backfilled.
- **Totals** (`readLinesNow`): `itemsCents` is the lines added up; `taxCents` is the tax as it now stands; `totalCents` is the two together. On an `in-lines` entry the tax, if any, is already inside `itemsCents`, and `taxCents` is null.
- **Admins correct the tax** as a history event, `tax_corrected`, carrying `{ tax: { before, after } }` (`POST /api/admin/cost-entries/[id]/tax`, `{ tax: "12.71" | null, seen }`). `taxCents` itself is never rewritten. An `in-lines` entry refuses it with 409 `ENTRY_TAX_IN_LINES`: its tax line is corrected like any line.
- **The AI reading:** the model's lines of kind `tax` fill the tax field (`taxFromReading`: their amounts added up) and are never item lines; in the reading document they carry outcome `tax`, and `tax: { readCents, sentCents, edited }` records whether the cleaner changed it.
- **The cleaner form:** a Tax card under the items, "Tax on the receipt", optional; "From the photo" or "Edited" when the reading filled it. The bottom bar shows Items, Tax and Total.
- **The admin pane:** the receipt, then "Items bought", then a footer of Items, Tax (with Correct, or "sent before tax was its own field" on an older entry) and Total.
- **Excel:** the Entries sheet has Items (CAD), Tax (CAD) and Total (CAD) columns; an older entry's tax cell reads "in items"; the period total row carries all three; a note explains "in items". The Items sheet lists each entry's lines and then one "Tax" row per entry that keeps its tax apart, so its rows add up to the total.
- **PDF:** columns Items, Tax and Total; "in items" on an older entry; the period total for all three; the note.

### 13.3 The form is locked while the receipt is read

The items screen is `inert` from the moment the photo is kept until the answer comes, with a panel: "Reading the receipt… The items will appear here in a moment." Then the lines are there and the tax is in its field. A failed or timed-out reading unlocks the form with the quiet note from dispatch 20. Because nothing can be typed during a read, a reading now **replaces** the lines rather than merging underneath typed ones; a reading with nothing the form can take leaves the lines as they were. A retaken photo still drops the untouched read lines and the read tax, and keeps anything the cleaner typed or changed.

### 13.4 The camera frame

"Take photo" opens the page's own camera (`CameraScreen.tsx`): the back camera through `getUserMedia` on a secure page, which iPhone Safari and Android Chrome both give, at the largest size offered; a receipt-shaped frame in the middle with the rest dimmed and "Fit the receipt in the frame"; one shutter. The frame is a guide only: the whole picture is kept, nothing is detected, cropped or refused, and the photo goes through the same shrink as one from the phone's camera app. Where the page cannot have the camera (refused, none, an old browser) the screen offers the phone's camera app through the file input, as before. "Choose from phone" is unchanged.

### 13.5 Cleaner-facing property names

**Kian's ruling (2026-09-30, second round):** the name lives in its own server-only collection, never on the property document, because `properties` is world-readable through the client SDK and these names will sometimes be street addresses.

- **`property_cleaner_names/{propertyId}`**: `{ schemaVersion: 1, propertyId, name, setAt }`, one document per property that has a name. `firestore.rules` denies every browser read and write. The export script exports it like every root collection.
- **Admins set it** through `GET`/`PUT /api/admin/properties/[id]/cleaner-name` (`{ name: string | null }`; NFC, trimmed, 1–120 characters, no control characters; null or empty clears, which deletes the document, so "absent" stays the one way of saying "none"). The property must exist. The property form has "Name for cleaners": it loads the current name from that route when the form opens, and after the property itself is saved it saves the name through that route only when it changed, saying so apart if that write fails.
- **The property document never carries it.** `UpdatePropertySchema` refuses a body with `cleanerName` (422), and nothing writes such a field.
- **Cleaners see only that name:** `readCleanerStart` reads the collection once (one read per named property) and returns the cleaner-facing name in place of the real one for every property that has one; the property screen, its search and "My receipts" show what that route returns. A property without one shows its real name.
- **The public site never sees it:** no public page or route reads the collection, and the property document has nothing to strip.

### 13.6 The queue and the ledgers

- **`/admin/costs` opens as the review queue:** the status filter's new default, **Needs attention**, is everything not approved (pending, rejected, removed and any unknown status), over all time. "All statuses" is `?status=all` in the URL. A line above the filters says which it is showing.
- **Approving** an entry takes it out of the queue and into its property's **ledger**: the same page with the property chosen and the status set to approved (`/admin/costs?property=<id>&status=approved`), headed "Ledger", with the date range the admin picks, the totals ("of which tax" beside "Counted") and the Excel and PDF exports of dispatch 19. **Rejected and removed entries never reach a ledger**: they stay in the queue, marked, with their history readable.
- **Each property's page:** in the admin property list the property's name, and a receipt icon beside Edit, link to its ledger. (Kian could not find either; §14.2 replaces the icon with a labelled **Costs** control and makes the whole row open the ledger.)
- **Nothing is duplicated, copied or moved.** Queue and ledger are two filters over the one read of `cost_entries`. Dispatch 19 already had the property and status filters, the date range, the totals and the exports; dispatch 21 adds the default, the ledger heading and mode line, the links, and the tax columns.

### 13.7 Verification (2026-09-30)

Against the repo's build reading production data (`next start` on 4620, and on 4621 through a stub Gemini answering slowly or with 500), throwaway admin and cleaner secrets, one `__TEST__` cleaner. Opening export `backups/2026-09-30T14-35-41Z` (55 documents in 8 collections, Kian's own entry among them and left untouched).

- **Both tax shapes, everywhere.** A new-shape entry read by Gemini from the r08 photo stored `schemaVersion 2, taxCents 278` and four item lines with no HST line; the reading document marked the model's tax line `outcome: tax` and `tax: { readCents: 278, sentCents: 278, edited: false }`. An old-shape entry was written directly in the dispatch 17–20 shape (`schemaVersion 1`, no `taxCents`, "HST 13.0000 %" as line 3, $1.36). The cleaner's "My receipts" showed $24.16 (21.38 + 2.78) and $11.80; the admin pane showed Items $21.38 / Tax $2.78 / Total $24.16 and Items $11.80 / Tax "in items" / Total $11.80, each with its receipt rendered; the queue and ledger tables showed the same in their Items, Tax and Total columns, Kian's own entry reading "in items". Excel (opened in Microsoft Excel) row 7: `Lm1PTE … 3 | 11.8 | in items | 11.8`; row 8: `FJ7tts … 4 | 21.38 | 2.78 | 24.16`; period total `33.18 | 2.78 | 35.96`; the Items sheet listed the seven lines and one `Tax | 2.78` row for the new-shape entry. The PDF (pdftotext): the same two rows, `Period total $33.18 $2.78 $35.96`, and the "in items" note.
- **Locked while reading:** with the stub answering after 8 s, at 10:39:47.9 the items list and the tax card were `inert`, the first input could not take focus, and Send and Add item were disabled, under the panel "Reading the receipt… The items will appear here in a moment."; at 10:39:56.5 the lines were there, the tax field read 2.78, and everything was enabled. With the stub answering 500, the form was unlocked at once with "The receipt couldn't be read. Type the items.", the photo still shown; a typed line and a typed tax ($5.00 + $0.65) sent as a version 2 entry with `taxCents 65`, its reading document `failed / http_500`.
- **The camera frame** on a 390×844 viewport, with `getUserMedia` replaced by a canvas stream that drew a receipt in the bottom-left corner, outside the frame: the video played at 1080×1920, the frame and "Fit the receipt in the frame" showed, the shutter produced a 1080×1920 photo that was accepted with Next enabled, and the entry made from it sent.
- **Cleaner-facing name (first round, on the property document, since replaced):** the cleaner's list, search and "My receipts" showed the set name and never the real one, and the admin and the exports kept the real one. That design put the name on the world-readable property document; Kian ruled it into its own collection, verified below (§13.8).
- **Queue and ledger:** `/admin/costs` opened as "Review queue" with the status filter on "Needs attention (5)". Approving the two entries above took the count to 3 and the two out of the list; the property's name in `/admin` linked to `/admin/costs?property=…&status=approved`, headed "Ledger", listing exactly those two, totals $35.96 counted and $2.78 "of which tax"; a range of 29 Sep showed no rows and "Nothing to add up", 30 Sep showed both; the exports above came from that range. The tax on a third entry was corrected $2.78 → $3.00 (history: "Tax corrected by an admin: $2.78 → $3.00"), then the entry removed, and a fourth rejected with a reason; both stayed in the queue marked Removed and Rejected and never appeared in the ledger.
- **Cleanup** by exact ID and path: 13 documents and 4 receipt objects, each confirmed gone (one object, from the camera-taken photo, carried no `__TEST__` file name and was deleted after its metadata was checked against the deleted test entry and cleaner). Two documents the tests had changed were put back: the property (`cleanerName` removed) and the day's `receipt_reading_quota` (the test readings had raised it from 2 to 6; restored to the opening export's content). Closing export `backups/2026-09-30T14-48-56Z`: all eight files byte-identical to the opening one. Storage 4,641 objects before and after (4,640 plus Kian's receipt).

**Not exercised:** a real phone camera; iPhone and Android themselves (the camera path relies on `getUserMedia`, which both give on a secure page); the day limit of 300.

### 13.8 Verification of the cleaner-facing names in their own collection (2026-09-30, second round)

Opening export `backups/2026-09-30T14-59-05Z`, local build with throwaway secrets, one `__TEST__` cleaner.

- **The route:** no cookie 401 on GET and PUT; cross-site PUT 403; an unknown property 404 `PROPERTY_NOT_FOUND`; 121 characters 422 "At most 120 characters"; an extra key 400. `PUT { name: "  __TEST__ 53  Woodward main " }` answered `{ name: "__TEST__ 53 Woodward main", changed: true }`, the same again `changed: false`, and `property_cleaner_names/3dIaEHZuFzzgvy6Mbaq0` held `{ schemaVersion 1, propertyId, name, setAt }`.
- **The property document never takes it:** `PUT /api/properties/[id]` with `{ cleanerName }` answered 422 "Not a property field…", and the property document contained neither `cleanerName` nor the name.
- **Denied to browsers:** with the site's public web key and no sign-in, Firestore's REST API answered 403 `PERMISSION_DENIED` for the document and for listing the collection, while the same caller read `properties/3dIa…` with 200, and that document held no such name. (Production's deployed rules deny it through their catch-all; the explicit block in `firestore.rules` takes effect when the rules are next deployed.)
- **Cleaners:** `GET /api/cleaner/start` returned `{ id, name: "__TEST__ 53 Woodward main", city: "Toronto" }` for that property, the other 45 under their real names, and the renamed property's real name nowhere in the payload. On a 390×844 screen the property list, its search for "53 wood" and "My receipts" showed the cleaner-facing name and the real one 0 times.
- **Admins:** the property list showed the real name. The property form loaded the name from its own route into "Name for cleaners"; changing it and saving sent `PUT …/cleaner-name` after the property save and the stored name changed; emptying it and saving deleted the document, the route answered `{ name: null }`, and the cleaner's route fell back to "3 Bedroom 2 Bath Main Floor House". (In that browser the property PUT and the image mirroring were stubbed, so the real property document was never written.)
- **Only three places read the collection:** the admin route, `server-cleaner-start.ts`, and `server-property-names.ts` itself.
- **Cleanup:** the test cleaner, its code, one entry, its submission and its receipt deleted by exact ID and path; the name document was already gone. Closing export `backups/2026-09-30T15-02-26Z`: all eight files byte-identical to the opening one, no `property_cleaner_names` collection left behind, Storage 4,641 before and after.

A cleaner's own entries still carry `propertyNameAtEntry`, the real name recorded when the entry was written; "My receipts" shows it only for a property that no longer exists.

---

## 14. The ledger after approval: reached from the row, corrected and removed, and set beside the PDFs that went out (2026-09-30, third round)

**Rulings (Kian, 2026-09-30):** a property's ledger is reached the obvious way, from the property's name or a clearly labelled control on its row, not an icon, and lands on that property's costs with its date range and both exports, without further clicks; the edit form stays reachable. **Approved entries stay editable and removable:** a line corrected, the tax corrected, the entry removed, each recorded in the history as now. A removal takes the entry out of the ledger, its totals and its exports, and it stays in the queue, marked. Nothing is erased. If an entry is corrected after it appeared in an exported PDF, the ledger makes that visible: an admin can tell that what a co-owner already received no longer matches.

### 14.1 What the investigation found first

Kian reported that clicking a property gave its edit form, and that the receipt icon could not be found. Three builds existed at that moment, and only one of them held the dispatch 21 row:

| Build | Where | What a property row does |
|---|---|---|
| Production, commit `231e484` (dispatch 20) | www.nubnb.ca | The name is plain text. Edit and Delete are icons. Its `/admin` bundle contains neither "Costs ledger" nor "status=approved". |
| `RBFK6PGt4yZBnNSdbK9JJ`, built 29 Sep 01:49 from the dispatch 18 tree | `localhost:4500`, the server Kian tests on | The same row. No Costs link in the header; `/admin/costs` answers 404. |
| The working tree (dispatch 21, uncommitted) | served nowhere | The name is a link to the ledger, styled exactly as the plain text it replaced. A 31×31 receipt icon with no label sits beside the Edit and Delete icons. |

Exercised on copies of the second and third with a throwaway PIN: on the port 4500 build a click on the name, the picture or the row does nothing, and the pencil opens the edit form; on the dispatch 21 build the name and the icon both land on the ledger. The entry Kian approved at 14:54:07Z can only have been approved on production, the one build with an Approve button that his PIN opens. **So the dispatch 21 row had never been in front of him:** nothing served it. Dispatch 21's own investigation (§13.1) did not check which build port 4500 was serving.

Two real faults on the dispatch 21 build, besides: nothing showed that the name was a link; and the ledger of a property with no entry yet read "This property", showed "All properties" in its filter, and with no entry anywhere showed no filters and no exports at all.

An approved entry was already correctable and removable, in the pane and on the server: no review route looks at the status. What did not exist was any record of a PDF once it had been exported, so nothing could say that a PDF no longer matched.

### 14.2 The property row

- **Clicking a property opens its costs.** The picture and the name are one link to `/admin/costs?property=<id>&status=approved`; a click anywhere else on the row, outside the actions, goes to the same place (the pointer shows it, the name underlines, and a click that ends a text selection is ignored).
- **Actions say what they do:** **Costs** (the same link) and **Edit** (the edit form), each an icon with its word. Delete keeps its icon, with its name for screen readers. A click in the actions cell that misses a button does nothing: it is beside Delete.
- The list scrolls sideways on a window narrower than the table. Before, its container cut the table off, so at 768 px the Edit and Delete icons could not be reached at all.
- **The row's links are not prefetched** (`prefetch={false}`). Each row in view otherwise asked the server for the costs page before anyone clicked: 13 requests on opening the list at 1440 px, measured on the local build; none now. On Vercel those are requests this page has no need to make.

### 14.3 The ledger of any property

- `GET /api/admin/cost-entries` now answers `{ entries, exports, properties }`: every entry, every recorded PDF, and every property's ID and current name (one read per property, its name alone; null if the names could not be read, which fails nothing). Still one call on opening.
- So a ledger opens for a property **whether or not it has an entry**: the page is headed with the property's name, the property filter shows it (properties with entries first, then "No cost entries yet"), and the date range and both exports are there at once. With no approved entry it says "No approved costs in these dates" and how many are waiting in the queue. "No cost entries yet" remains for the queue when there is no entry anywhere.
- With one property chosen, the counts beside each status are that property's, and the Property column is dropped from the entries table.
- The ledger and the property's queue link to each other, keeping the property.

### 14.4 After approval

Nothing in the review depends on the status, and the page now says so: the ledger's heading line and the pane of an approved entry state that it can still be corrected or removed, every change recorded in the history. A removal, or a rejection, of an approved entry takes it out of the ledger, its totals and its exports at once; it stays in the queue, marked, with its history. Approving it again counts it again. `lines` and `taxCents` are never rewritten (§11.1, §13.2): every change is a history event carrying the value before and after.

### 14.5 PDFs on record: `cost_report_exports/{exportId}`

An approved entry may already be in a PDF a co-owner holds. To say that such a PDF no longer matches, the PDF has to be on record.

- **One document per PDF**, written once with `create()` and never changed or deleted: `{ schemaVersion: 1, kind: 'pdf', propertyId, propertyNameAtExport, from, to, createdAt, actor: admin, entries: [{ entryId, historyLength, itemsCents, taxCents, totalCents }], itemsCents, taxCents, totalCents }`. `from` and `to` are the period the PDF prints; `historyLength` is how many events the entry's history held; the amounts are the ones the PDF prints. They are a record of a document handed out: nothing reads them back into an entry, a total or a report. Server-only: `firestore.rules` denies it, as the deployed catch-all already does.
- **Recorded before it is downloaded.** The page sends `POST /api/admin/cost-reports` with `{ propertyId, from, to, entries: [{ id, seen }] }` and downloads the PDF only on a 201; the PDF carries the record's `createdAt` as its "Generated" time. No amount and no name is taken from the browser: the body is strict.
- **The server works the report out again**, in one transaction: the property's entries, those approved and sent in the period, each as it now adds up. It records the PDF only if that is exactly what the page built it from — the same entries, each with the history length the page saw. Otherwise nothing is written and the page downloads nothing: 409 `REPORT_CHANGED` ("An entry in this report changed since the page loaded"). So a PDF is never made from a page that has fallen behind.
- **An open-ended period ends today, but never before its last entry** (`buildReport`). On a computer whose clock is behind, "today" would otherwise end the period before its own entries, and the period is what the server checks the entries against.
- **The Excel file is not recorded.** It is the admins' own working copy and names the cleaners; the PDF is what goes to co-owners.

**What the page compares** (`comparePdf`, `entryPdfState` in `costs/report.ts`; reading only):

- An entry beside a PDF that lists it: **same**; **corrected** (a line or the tax corrected since, the amounts as printed); **amount changed**; **left** (rejected or removed since); or cannot be added up.
- A PDF beside the ledger over the PDF's own period: **Matches**, **Amounts match** (only corrections that changed no amount), or **No longer matches**, with each reason: an entry's amount then and now, an entry removed or rejected since, an entry approved since that the PDF does not list. It also says what the period now adds up to.
- **The newest PDF covering an entry's day is the one to go by.** The mark under an entry's total in the table, and the alert in its pane, compare the entry with that PDF. So exporting the PDF again for the same dates settles it: the older PDF is still listed as no longer matching, with "the PDF exported … covers them and replaces this one".

**Where it shows:**

- **The ledger, "PDFs exported for this property":** each PDF with when it was exported (to the second), its period, entries and total, and how it stands now. An alert heads the list while a PDF no longer matches and no newer PDF replaces it. The newest PDF and every PDF needing attention are always listed; the rest fold away behind "Show all".
- **Each entry's row**, under its total: "in PDF", "corrected since PDF", **"changed since PDF"**, and in the queue **"still in a PDF"** on a removed or rejected entry the newest PDF still lists, or "in an earlier PDF".
- **The entry pane, "PDFs it went out in":** what each PDF printed for the entry and how it stands now, an alert when the PDF to go by no longer says what the entry says, and each PDF set in the history at the point it was made, so what came after it is plain. Removing or rejecting an approved entry that a PDF lists says first that the PDF will no longer match.

**Limits, as reported to Kian:**

- A PDF exported before this was built is not on record; nothing can be said about it.
- The record says a PDF was made, not that it was sent. Every PDF exported is treated as one a co-owner may hold.
- If the answer to the recording is lost after the write landed, a record exists for a PDF nobody downloaded. The page says the record may or may not have been made; the record is harmless and stays.
- A PDF now needs the server: with an expired session it is refused, where before it was made wholly in the browser.

### 14.6 Routes

| Route | Door | Request | Success | Refusals |
|---|---|---|---|---|
| `GET /api/admin/cost-entries` | admin | none | 200 `{ entries: CostEntryView[], exports: ReportExportView[], properties: { id, name }[] \| null }` | 401; 500 `COST_ENTRIES_READ_FAILED` if the entries or the PDF records cannot be read (never "no PDF was exported") |
| `POST /api/admin/cost-reports` | admin | `{ propertyId, from, to, entries: [{ id, seen }] }` | 201 `{ export: ReportExportView }` | 401; 403 `CROSS_SITE_REFUSED`; 415; 422 (a key the schema does not name, a day that is not one, a period that ends before it starts, an entry twice, `seen` below 1, more than 5,000 entries); 404 `PROPERTY_NOT_FOUND`; 409 `REPORT_CHANGED`; 409 `REPORT_ENTRY_UNREADABLE`; 502 `REPORT_RECORD_FAILED` ("may or may not have been recorded") |

Reads: opening the costs page is one read per entry, one per recorded PDF, one per property (name only) and one per distinct cleaner. Recording a PDF is the property's name and one read per entry of that property, and one write.

### 14.7 Verification (2026-09-30)

Against local production builds of this tree reading production data (`next start` on 4632, throwaway admin and cleaner secrets, no `.env.local` in the build copy), in a real browser. Opening export `backups/2026-09-30T15-44-35Z` (55 documents in 8 collections, byte-identical to the second round's closing export). The pass recorded below ran on build `H4nSkL4ywNhuZAfRs6a8z`: one `__TEST__` cleaner; four entries for "3 Bedroom 2 Bath Main Floor House", three sent through the cleaner route (tax as its field) and one written in the dispatch 17–20 shape (tax typed as line 3), the shape Kian's own approved entry has. Two small changes followed it (the row's links not prefetched; an open end never before the last entry), and a last round ran on the final build, `VJF_7BH45k1Yb9yBd-JeK`.

- **The row, before and after.** Before, on the dispatch 21 build: the name `<a>` with no underline (white, weight 600, as the plain text was), a receipt icon with no text, then Edit and Delete icons; the name and the icon landed on the ledger, the picture and the rest of the row did nothing. After: the name and picture one link, the row's pointer a hand, "Costs" and "Edit" with their words. Name, picture, row and Costs each landed on `/admin/costs?property=1VpX0wMpaUkbFwkULD8P&status=approved`, headed "Corner Penthouse l Tall Ceiling", the filter on that property, From and To and the four presets, Excel and PDF present, "No approved costs in these dates" (that property has no entry). The actions cell beside the buttons did nothing; Edit opened "Edit Property" with that name. At 390 px the list scrolled sideways to Costs, Edit and Delete.
- **The ledger from the row.** Three entries approved from the queue; the property's name in `/admin` landed on its ledger: three rows, $50.71 counted. Excel and PDF exported (after the confirm that one pending entry is left out): PDF `$18.62 / $20.29 / $11.80 in items`, period total `$46.24 $4.47 $50.71`; the record held the same three entries with `historyLength 2` and those cents; the rows then read "in PDF" and the list "Matches".
- **Correct a line, on an approved entry already in that PDF:** line 2 $12.99 → $11.99. History: "Line 2 corrected by an admin: … $12.99 → … $11.99", after the PDF's own line in the history. The pane: "Changed since it went out in a PDF. The PDF exported … shows this entry at $18.62; it now adds up to $17.62." **Correct the tax:** $2.14 → $2.01, "Tax corrected by an admin: $2.14 → $2.01", total $17.49. The ledger row read `$15.48 | $2.01 | $17.49 · changed since PDF`, the totals $49.58, and the PDF list: "No longer matches — YhQs7u $18.62 in the PDF, now $17.49. These dates now add up to $49.58 over 3 entries", under the alert. On the older-shape entry the tax was corrected as its line (line 3, $1.36 → $1.30); the tax route, unchanged here, refused such an entry with 409 `ENTRY_TAX_IN_LINES` on the preceding build of this tree.
- **Exports follow.** Excel #2: `YhQs7u … 15.48 | 2.01 | 17.49 | Yes`, the Items sheet `Trash bags 40 ct | 11.99 | Corrected` and `Tax | 2.01`; PDF #2: `$15.48 $2.01 $17.49 *`, period total `$45.18 $4.34 $49.52`. The list then showed the new PDF "Matches" and folded the first away as replaced.
- **Remove it.** The confirm said: "It is in the PDF exported Sep 30, 2026, 12:04:23 p.m.: that PDF will no longer match the ledger." History: "Removed by an admin · was approved". The ledger showed two rows and $32.03; Excel #3 and PDF #3 held two entries and `Period total $29.70 $2.33 $32.03`, the removed entry in neither. In the queue for the property it stayed, "Removed", with "in an earlier PDF" once PDF #3 had been made, its pane listing both PDFs it went out in and its whole history.
- **The prior state, as stored.** The removed entry's document still held `lines` as sent (349 and 1299) and `taxCents 214`; its history held `submitted`, `approved`, `line_corrected` (before 1299, after 1199), `tax_corrected` (before 214, after 201) and `removed` (from approved). The three PDF records each had `createTime` equal to `updateTime`.
- **A page that has fallen behind.** With the ledger open, another entry was corrected through the API; PDF pressed on the stale page: "The PDF was not downloaded. An entry in this report changed since the page loaded." Nothing downloaded, the records still three. After Refresh the row read "changed since PDF". A pending entry approved afterwards showed on the newest PDF as "approved since, so not in the PDF ($5.11)".
- **The route:** no cookie 401; from another site 403; not JSON 415; an amount in the body 422 "Unrecognized key"; the period backwards 422; no such property 404; behind what is stored 409; nothing written by any of them.
- **Denied to browsers:** with the site's public web key and no sign-in, Firestore's REST API answered 403 `PERMISSION_DENIED` for `cost_report_exports` and for a document in it, as for `cost_entries`, while the same caller read a property's name with 200. (Production's deployed rules deny it through their catch-all; the explicit block in `firestore.rules` takes effect when the rules are next deployed.)
- **With no entry anywhere** (the list answer stubbed empty in the browser): a property's name still landed on its ledger with its name, dates and both exports; the queue said "No cost entries yet".
- **The last round, on the final build:** two entries approved; opening `/admin` made 0 requests for the costs page (13 before the links stopped prefetching); the property's name landed on its ledger; Excel and PDF exported and the PDF recorded; a line corrected ($12.99 → $11.99), the row "changed since PDF"; then, with the page's clock set two days behind (28 Sep), the PDF still printed "30 September 2026" and was recorded (without the change its period would have run from 30 Sep to 28 Sep, and the route refuses a period that ends before it starts); the entry removed, the queue showing it "Removed … still in a PDF".
- **The comparison, as pure functions** on made-up entries (the final `report.ts` and `model.ts` transpiled and run in node): 27 checks, among them a line renamed since a PDF with the amounts unchanged ("corrected"), a removal undone by approving again ("same"), a record with a field out of shape (counted apart, never compared), an older-shape entry beside a PDF that printed no tax of its own, and a newer PDF that does not cover an entry's day (it settles nothing).
- **Cleanup** by exact ID and path, in three rounds (a first pass on an earlier build of the same tree, the recorded one, and the last): 40 documents (three cleaners, their codes, ten entries, their submissions, fourteen PDF records) and ten receipt objects, each confirmed gone. Closing export `backups/2026-09-30T16-14-33Z`: all eight files byte-identical to the opening one, no `cost_report_exports` collection left behind, Storage 4,641 objects before and after. No existing document was written at any point.

**Not exercised:** the production admin panel (no production credentials are used there); a record-then-lost-answer (502); a PDF of more than a handful of entries.

## 15. The admin home: one header, four figures (2026-09-30)

**Kian's request.** The stats on the admin home were wrong, and the buttons' placement was wrong: propose strategic stats, and make the header's buttons follow the brand, placed, sized and spaced properly.

### 15.1 What was there

The header read `View Site | Properties` on the left and `Costs  Cleaners  [Add Property]` on the right. "Properties" was the page's title here and a back link on the other three admin pages; "View Site" sat where a back button goes; Leads had no link at all (the inbox was reachable only through its stat card); and two section links shared a cluster with the page's one action. Under it, five tiles: New leads, Total Properties, Avg. Price / Night, Total Bedrooms, Property Types. Only the first led anywhere or could be acted on. The average price was also a number computed from prices, which nothing in Nubnb is meant to do.

### 15.2 The header (`app/admin/components/AdminHeader.tsx`)

One header on all four admin pages, built from the public site's own nav on `/about`: the **NUBNB** wordmark (and an "Admin" tag; the logo mark was there first and Kian had it removed the same day), the four sections **Properties · Leads · Costs · Cleaners** as quiet 13 px pill links with the current one marked (`aria-current`, and the page's `<h1>` for a screen reader), then on the right **View Site ↗** and the page's own action, primary last: **Add Property** on the home as the brand's white pill (`.navCta` on `/about`: dark text on white, 999 px radius), **Refresh** on the others as the bordered dark pill the public site uses. Every control is 36 px tall; gaps are 4 px between sections, 8 px between actions, 28 px between groups; the bar is 64 px tall with 32 px side padding. Under 860 px the sections take their own row and scroll; under 640 px the "Admin" tag and the words of "View Site" go.

The admin now uses the brand face: `page.module.css` reads `--font-manrope` directly, because `--font-sans` on `:root` cannot see the variable next/font sets on `<body>` (the site-wide bug found in dispatch 18, still open elsewhere).

**Decisions of mine, not rulings:** View Site opens in a new tab (leaving the admin to check the site is the common case, and the ↗ says so); section links do not prefetch (an admin taps one on purpose, and no admin page is warmed for nothing); the old `.header` media rules, which targeted the wrong element, were replaced.

### 15.3 The four figures (`app/admin/components/DashboardStats.tsx`)

| Tile | Value | Detail | Leads to |
|---|---|---|---|
| **New leads** | leads with status `new` | how many of those may never have been emailed to the office (`mayBeUnnotified`), else "Waiting for an answer" / "Nothing waiting" | `/admin/leads?status=new` |
| **Leads, last 30 days** | leads created in the last 30 days, any status | the count for the 30 days before | `/admin/leads` |
| **Costs to review** | cost entries with status `pending` | their total, and how many are unreadable | `/admin/costs` (the queue) |
| **Cleaning costs, ‹month›** | the total of entries sent this Toronto calendar month that count in totals (approved and pending, as the ledger adds up) | the number of receipts, and how much of the total is still pending | `/admin/costs?status=all&from=‹1st›&to=‹today›` |

A tile with something to act on is brand blue; a read that failed shows "Unavailable" with the reason, in red, never 0. Two reads on opening, the same two the inbox and the costs page make (`fetchLeads`, `fetchCosts`); the cost read also brings the export records and the property names, which this page does not use — a lighter summary route is the obvious saving if the admin home is opened often.

**Decisions of mine, not rulings:** "to review" means pending only, not the queue's wider "everything not approved" (rejected and removed entries wait for nothing); the month runs by the day an entry was sent (`sentDay`), as the ledger does; the catalogue's count stays beside the list's filters ("46 of 46") rather than in a tile; the average nightly price, bedrooms and property types are gone.

**Alternatives considered:** a properties tile with listed/delisted split (there is no such field: "delisted" is an Airbnb-side fact); leads by source (recorded since 21f85bb, but a breakdown is the inbox's job); last month's cleaning costs beside this month's (one more number for a comparison the ledger already gives).

### 15.4 The filter controls (Kian, the same afternoon: "upgrade the date pickers and inputs, customized, cleaner")

Two controls of the admin's own, in `app/admin/components/`, on every admin filter bar, and one set of tokens they all draw from (`--ctl-*` and `--popover-*` on the admin container): 40 px tall, 12 px radius, a focus ring in the brand blue, one popover surface.

- **AdminSelect** replaces every native `<select>` outside the property form: a dark field with a chevron; a list under it with the chosen option marked; groups with headings; a search box at the top from nine options (the property list); keyboard as a native select (arrows, Home/End, Enter, Escape, typing the first letters); announced as a combobox with a listbox. Used for the property and status filters on Costs, type and sort on Properties, status and source on Leads.
- **DateRangeField** replaces the two `type="date"` inputs and the row of preset pills on Costs: one field that reads "Sep 1 – Sep 30, 2026" or "All time", opening a calendar — the same react-day-picker the public site's "When" filter uses, drawn the same way (white range ends, round days), two months side by side, one on a narrow screen — with the quick ranges (This month, Last month, This year, All time) down its left, "Clear dates" and the Toronto-day note at its foot. A quick range applies and closes; days picked apply as picked. Days after today cannot be chosen. The picker's code is fetched on demand through `app/lib/on-demand.ts`, as the public site does, when the field is first pointed at.
- The search fields and the cleaners page's two inputs use the same recipe. The property form's inputs and the entry pane's line editor are untouched.
- The property form keeps its own `CustomSelect`; folding it into `AdminSelect` is a separate job.

### 15.5 The "PDFs exported for this property" section is gone (Kian, the same afternoon)

Kian: "remove the PDFs exported for this property section fully, it's not needed in the property costs page." The section (§14.5's comparison table) is removed from the ledger, with its helpers and styles. What stays: each PDF export is still recorded in `cost_report_exports` when it is made (§14.5), and an entry's row in the ledger still carries its PDF mark — "in PDF", "corrected since PDF", "changed since PDF", "still in a PDF" — with the entry pane listing the PDFs it went out in. So the ruling that the ledger shows when a PDF a co-owner holds no longer matches still holds, on the entry's row rather than in a table of PDFs.

### 15.7 Search, filters and sort on Properties (Kian, the same afternoon: "redesigned on UI and even get perfected on UX for what parameters and how we are searching and filtering")

What there was: a search over the name and the location text, a Type select, a Sort select with "Default Order" first, and "46 of 46". What the data offers (46 properties, 2026-09-30): 9 cities (Toronto 31), 5 types, bedrooms 0–6, 24 areas too fine for a filter but good for search, no dates on the documents, and nothing missing on any document (so a "needs attention" filter would have nothing to show today).

- **Search** matches every word typed, in any order, against the name, the location line, the city, the area, the province, the type, the type tag and the slug, with accents and case set aside: "basement markham" finds a basement in Markham. "/" puts the cursor in the field (unless something else is being typed into, or the property form is open); Escape or the field's own × clears it.
- **Filters**: City, Type and Bedrooms (Studio, 1, 2, 3, 4+ — exact counts, the way an admin thinks of a property), each option with its count over the whole catalogue, each an `AdminSelect` with its icon.
- **Sort** stands apart at the right, with its own icon: default order, name, price low→high / high→low (on the nightly price, as before), bedrooms most first.
- **What is on** shows under the bar: "46 properties" or "9 of 46", then one chip per active search or filter (a press removes it), and "Clear all" once two or more are on. The empty state names what nothing matched and offers the same clearing.
- Everything is mirrored into the address bar (`?q=&city=&type=&beds=&sort=`), read back on opening, so a reload or a shared link keeps it, as on the costs and leads pages.
- The row's "Open the costs for …" is an `aria-label` now, not a `title`: the browser's tooltip floated over the toolbar on every hover.

**Decisions of mine, not rulings:** counts are over the whole catalogue, not faceted by the other filters; bedrooms are exact rather than "n or more"; no price-band or guests filter (sort covers price; guests would be a renter's filter, not an admin's).

### 15.8 The cleaner app's bar (Kian, the same afternoon: "a proper navigation branded for NUBNB … keep it simple")

`app/cleaner/CleanerBar.tsx`, at the top of every screen: a white bar with a hairline under it (Kian, on seeing the first version: "not dark mode, and black"), the **NUBNB** wordmark in the brand's navy blue (`--primary`, #153D6D) set as the public site's nav sets it, and a small "Receipts" tag beside it (hidden under 400 px). On the property screen the bar carries the two ways out of the flow, **My receipts** and **Sign out**, as navy-outlined pills with their icons, 40 px tall; "Hi Kian" moves under the bar as the page's first line, above "Which property?". On a step into the flow (photo, items, my receipts) the bar carries **Back** in the same blue on the left and the property's name on the right, as the old bar did. The code screen, the Sent screen and the loading and no-connection states carry the wordmark alone. The phone's browser chrome stays white (`themeColor`). Every screen's minimum height allows for the bar, so nothing scrolls that did not before. The old `.topBar`, `.topBarProperty`, `.topBarActions` and `.backButton` styles are gone; `.textButton` stays for "See my receipts" on the Sent screen.

**Decisions of mine, not rulings:** the wordmark on the code screen (the entrance said nothing about Nubnb before); pills rather than underlined links for the two actions; the greeting as an eyebrow rather than in the bar, so the bar fits a 360 px phone with both pills.

### 15.9 The cleaner app in Nubnb's language (Kian, the same evening: "keep the light mode and simplicity in design, but the UI and elements and some detailed UI design languages should match Nubnb's design language and style")

What the public site's language is, read off `globals.css` and the components: a warm pearl ground (`--bg-primary` #F9EBEA) with white surfaces; Manrope for everything read and Playfair Display for the titles (`.title` on the detail panel) and for the one big call to action (`.reserveBtn` is set in the serif); `--brand-dark-blue` #153D6D for depth and `--brand-blue` #6599CD for accents and badges (the card badge: brand blue, white capitals, 11 px, 0.06 em, a pill); text #1A1A1A / #5A5A5A / #8C8C8C; borders #E5E5E5 / #D0D0D0; cards at 16 px with `--shadow-sm` (0 2px 8px 4 %); inputs at 12–14 px; nav pills at 999 px.

Applied to `cleaner.module.css` through its tokens and thirty rule edits, with every size the cleaner's as before (nothing got smaller than it was):
- **Ground and surfaces:** the app sits on the pearl; rows, cards, the photo preview, fields, the code boxes and the bar are white with the soft shadow; card edges are 1 px `--line` at 16 px (they were 2 px grey at 14).
- **Type:** "Which property?", "Photo of the receipt", "What did you buy?", "My receipts", "Sent" in Playfair (32 px, 44 px for Sent); the big button (`.primary`: Take photo, Next, Send, Log another receipt) in Playfair too, as the site's own call to action; section labels ("Recent", "All properties", "Item 1", "Tax") as small tracked capitals (14 px, 0.1 em).
- **Colour:** the dark blue stays on buttons, Back and the wordmark; the brand blue takes the badges ("From the photo" is now the site's badge: blue with white capitals), the chosen row, the reading panel, the spinner, the progress bar, the "Waiting for review" pill and every focus ring. Fields keep their 4.5:1 border (#767676) because a hallway needs it.
- Untouched: the camera screen and the photo viewer (black, as a camera is), the offline bar, the greens and reds of the statuses, every target size.

**Decisions of mine, not rulings:** the serif on the primary button (it is the site's CTA signature; the secondary stays Manrope); the pearl ground rather than white (it is what makes the site look like the site); tracked-capital labels at 14 px rather than the site's 11 px, for the hallway.

### 15.10 Kian's corrections to 15.8 and 15.9 (the same evening)

Seen on his phone: "Why the background got pink a little bit, this is wrong, it should be white; also font size is a little bit too big; and also the sign out button is not needed; and the receipts button does not need an svg icon."
- The ground is white again: the pearl was my decision, and it is not the site's rule for an app screen. Rows and cards keep their hairline and soft shadow on the white.
- Every size one step down: body 20 → 18 px; titles 32 → 28 (Sent 44 → 40); the big button 23 → 21 px on 60 px instead of 64; fields 58 → 54 px at 18 px type; rows 74 → 68 px; labels 14 → 13; receipts, notes and hints one or two points each. Every target is still 48 px or more.
- Sign out is gone from the bar and from the app: `leave()` and its import are removed. `DELETE /api/cleaner/session` stays as a route; a session ends by itself after 12 hours, and a new code ends it at once.
- "My receipts" is a plain pill, no icon.

### 15.6 Verification (2026-09-30)

Against a local production build of this tree (`next build` in a scratchpad copy; `.env.production.local` with a throwaway PIN and keys, no mail, no Gemini), signed in through the PIN gate at `127.0.0.1:4620`, reading production data. Nothing was written.

- `tsc --noEmit`: clean. `eslint app/admin`: 4 errors, all pre-existing in `IconPicker.tsx`; nothing from the changed files.
- **Header** (DOM): h1 "Properties"; brand "NUBNB Admin"; nav Properties (`/admin`, `aria-current=page`) · Leads · Costs · Cleaners; actions "View Site" (`target=_blank`) and "Add Property"; every control 36 px; header 65 px; font `Manrope`.
- **Tiles against a recomputation from `/api/leads` and `/api/admin/cost-entries` in the page:** expected `{fresh 3, untold 0, last30 1, previous30 1, pending 0, pendingCents 0, monthCents 11047, monthEntries 1}`; the tiles read "3 · New leads · Waiting for an answer" (accent) → `/admin/leads?status=new`; "1 · Leads, last 30 days · 1 in the 30 days before" → `/admin/leads`; "0 · Costs to review · Nothing waiting" → `/admin/costs`; "$110.47 · Cleaning costs, September · 1 receipt" → `/admin/costs?status=all&from=2026-09-01&to=2026-09-30`.
- **AdminSelect.** Type, on `/admin`: opens with the list focused and six options; ArrowDown, Enter → "Apartment", "9 of 46", focus back on the field; Home, Enter → "All Types", "46 of 46". Property, on `/admin/costs`: opens with the search box focused, groups "With cost entries: 1" and "No cost entries yet: 45" (47 options with "All properties"); typing "loft" → no match, and Enter chooses nothing; picking the one property with entries → `?property=OXMh896XZf2RHIVckmsr`; Status → Approved → `&status=approved`, h1 "Ledger", headings "4 Bedroom Family Home in Ajax" and "Totals for what is shown", the Excel and PDF buttons, the row's "in PDF" mark, **and no "PDFs exported" text anywhere on the page**. Leads: status → "New (3)", "3 of 3".
- **DateRangeField.** Opens with two months (August 2026, September 2026), presets This month / Last month / This year / All time (active), three `.rdp-disabled` cells, the Toronto note. "This month" → the field reads "Sep 1 – Sep 30, 2026", the URL `?from=2026-09-01&to=2026-09-30`, the totals "1 Sep 2026 to 30 Sep 2026", the popover closed. Clicking 1 then 10 → "Sep 1 – Sep 10, 2026", `?from=2026-09-01&to=2026-09-10`, 12 middle days. "Clear dates" → "All time", no params. Escape closes.
- **Controls.** The three costs filters 40 px each; the cleaners page's name input 40 px with a 12 px radius; no native `<select>` left outside the property form.
- **Phone (390 × 844).** Header 99 px with the sections on their own row (brand at 14 px, nav at 52 px, scrolling sideways), tiles one per row, no horizontal overflow, the words of "View Site" hidden; the date popover one month wide with the presets in a row above it, its right edge at 374 of 390 px, no overflow.
- Console: no error beyond the PIN gate's own 401 before sign-in.
- **Properties toolbar (§15.7), same build method, 2026-09-30 later.** At rest: "46 properties", City = All cities, Type = All types, Bedrooms = Any bedrooms, Sort = Default order, the "/" hint in the search. "basement markham" → `?q=basement+markham`, "0 of 46" with the empty state (Markham's four are houses); the field's × clears and keeps the focus. City → Markham → `?city=Markham`, "4 of 46", chip "Markham"; Type → House and Bedrooms → 3 → `?city=Markham&type=House&beds=3`, "3 of 46", three chips and "Clear all"; removing the House chip → `?city=Markham&beds=3`; Clear all → "46 properties", no params. Sort → Bedrooms: most first → `?sort=beds-desc`, the beds column 6, 5, 4, 4. Opening `?q=condo&city=Toronto&sort=price-desc` → the search "condo", City "Toronto (31)", Sort "Price: high → low", "6 of 46", prices $599 → $119, types Apartment and Condo. "/" from the page body focuses the search; Escape empties it ("31 of 46"). "zzzz" → "No matching properties" with the clear button, which restores "46 properties" and leaves the sort. At 390 px: no horizontal overflow, the "/" hint hidden, chips "Toronto", "Basement" for `?city=Toronto&type=Basement` ("8 of 46"). No console errors.
- **Cleaner bar (§15.8), same build method, the stubbed cleaner flow at 390 × 844.** On every screen a `header` 56 px tall, background `rgb(26, 26, 29)`; no horizontal overflow; no page scroll on the code, property, photo, sent and my-receipts screens (the items screen scrolls by its own content, as before). Code screen: the wordmark "NUBNB Receipts", nothing else in the bar. Property screen: the wordmark, the pills "My receipts" and "Sign out" (40 px each), "Hi Sam" under the bar above "Which property?". Photo, items, my receipts: "Back" (48 px) on the left, the property's name on the right on the two steps. Sent: the wordmark alone. Sign out pressed in the bar → the code screen. At 360 × 780 the "Receipts" tag is hidden and the last pill ends at 344 of 360 px. No console errors. Screenshots: `shots-cleaner-bar/` in scratchpad 43983482.
- **The cleaner app in Nubnb's language (§15.9), same build method, the stubbed flow at 390 × 844.** On every screen the app's ground computes to `rgb(249, 235, 234)`; `document.fonts` reports Manrope and Playfair Display loaded; the h1 ("Which property?", "Photo of the receipt", "What did you buy?", "Sent", "My receipts") computes to `"Playfair Display"`, and so does the big button (Take photo, Next, Send, Log another receipt) at a 14 px radius; section labels 14 px with 1.4 px tracking; rows, item cards and receipt rows at 16 px with `0 2px 8px rgba(0,0,0,0.04)`; "From the photo" a brand-blue pill with white capitals; "Waiting for review" on the brand-blue tint. No console errors. Screenshots: `shots-cleaner-skin/` in scratchpad 43983482.
- **Kian's corrections (§15.10), same build method, the stubbed flow at 390 × 844.** The app's ground computes to `rgb(255, 255, 255)` on every screen (the only `f9ebea` left in the served CSS is `globals.css`'s own `--bg-primary`); body 18 px; h1 28 px Playfair (Sent 40 px); the bar on the property screen holds one button, "My receipts", 40 px, with no svg; Back 48 px; the big button 21 px on 60 px; the search field 56 px and the item fields 54 px at 18 px; rows 72 px. No sign-out anywhere in `app/cleaner`. No console errors. Screenshots: `shots-cleaner-fix/` in scratchpad 43983482.
- Screenshots (1440 and 390 wide): `shots-admin/` in scratchpad 43983482.

---

## 16. Auto-approval under $200, and handymen (dispatch 24, 2026-09-30)

**Kian's decision 1 (2026-09-30), as `FINANCIAL-MANAGEMENT-PLAN.md` §2.13 recommended it:** a cleaner's receipt entry strictly under $200.00 as sent, items plus tax, is written approved; it leaves the queue when an admin marks it Seen, and correcting, removing or rejecting it counts as seen. Work entries never auto-approve, whatever the amount. This section records what was built to the plan's §2.2 and §2.3, the decisions that are mine, and the verification. Nothing here is a ruling unless it says so.

### 16.1 Auto-approval (`createCostEntry`)

- **The rule** runs inside the entry's create transaction, on the entry as sent: the lines' amounts plus the tax, strictly less than `LIMITS.AUTO_APPROVE_UNDER_CENTS` (20,000). It tests the kind, not the role: only a receipt qualifies.
- **What is written** on a qualifying entry: `status: 'approved'`, `statusChangedAt` the entry's own `createdAt`, and a history of two events at the same instant — `submitted` (actor the cleaner, `to: 'pending'`) and `approved` (`from: 'pending'`, `to: 'approved'`, actor `{ role: 'system', id: null, name: 'auto-approval' }`, reason "Under $200.00: approved automatically") — and `autoApproved: { thresholdCents: 20000, totalCents: <as sent>, at }`. Every new entry carries `autoApproved` (the record or `null`) and `kind`. The threshold is a constant, not a setting: the record on each entry says which rule it met, so a later change confuses nothing.
- **The response** of `POST /api/cleaner/entries` gains `status` (`approved` or `pending`) and `autoApproved`. The cleaner app shows nothing different: "Sent".
- **Seen.** `POST /api/admin/cost-entries/[id]/seen` with `{ seen }` appends `{ action: 'seen', from: null, to: null, actor: admin }` through the same `review()` transaction as every other review, so a page that has fallen behind is refused with 409 `ENTRY_CHANGED`. It changes no status. An entry that was not approved automatically is refused, 409 `ENTRY_NOT_AUTO_APPROVED`; one an admin has already acted on answers `changed: false`.
- **"Awaiting a look"** is one pure function on both sides (`awaitingLook` in model.ts): approved, carrying the record, and no event in the history by an admin. So marking seen, correcting, removing or rejecting each takes the entry out of the group, and approving it again by hand after a removal does too. The queue's `NEEDS_ATTENTION` (`inQueue` in `costs/report.ts`) is now: not approved, or awaiting a look.
- **Where it shows.** The queue: a group "Approved automatically, not yet looked at (n)" at the top of the table, each row's status badge reading "Approved · auto" with a Seen button on the row, and "Mark all n as seen" on the group (one call per entry, stopping at the first failure and saying how many were done); under it, "Needs a decision (n)" for the rest. The pane: the badge, the note ("Approved automatically: under $200.00, and no admin has looked at it. It counts in the ledger now. Correct it, remove it, or mark it seen.") with the amount the rule saw, a Seen button, and "Approved automatically · was pending" in the history. The home tile "Costs to review" counts pending plus awaiting a look (my decision: the tile counts what the queue holds for an admin, so it cannot read 0 while automatic approvals wait), and its detail line says "n approved automatically, not yet seen · n cleaners worth a look". In the ledger, the PDF and the Excel file an auto-approved entry is an approved entry: the badge keeps "· auto" on the page, and nothing is printed for co-owners (my decision; one word to change).

### 16.2 The clustering is visible (`app/lib/costs/patterns.ts`)

Pure, over the entries the page already holds, receipt entries only, the last 90 Toronto days ending today, rejected and removed entries included (the pattern is in the sending), the amount the entry as sent:

1. **The distribution per cleaner, in words** (`distributionText`): "Last 90 days: 14 receipts · under $50: 2 · $50–100: 3 · $100–150: 1 · $150–200: 7 · $200 and over: 1 · approved automatically: 13 of 14". The $150–200 band is always named; an empty other band is left out; entries that cannot be added up are counted apart. Shown in a "Last 90 days" column on the Team page, and in the entry pane under the items ("<cleaner>, last 90 days").
2. **Same-day splits** (`sameDaySplits`): two or more receipts from one cleaner for one property on one Toronto day, each strictly under $200.00, adding up to $200.00 or more. "30 Sep 2026, Loft Plateau: $184.20 + $96.10 = $280.30 in two receipts".
3. **"Worth a look"** (`worthALook` on each `CleanerPattern`): three or more receipts in the $150.00–$199.99 band *and* the band holding 40 % or more of the cleaner's readable receipts, with five or more receipts in the window; *or* two or more same-day split sets, whatever the count. Under five receipts the distribution says "(too few to judge)" and only splits fire. The panel heads the queue only when the rule fires for someone, names each cleaner with the figures and their split sets, and links to the queue filtered to them (`?cleaner=<id>&kind=receipt`). The same words are on the home tile's detail line and in the entry pane. Nothing here blocks or writes anything.

The constants (`PATTERN`: 90 days, $150 band, 3, 40 %, 5, 2 sets) are mine and are not one-way doors.

### 16.3 Handymen

- **The role** is a field on the `cleaners` document, `role: 'cleaner' | 'handyman'`, written on every new account; absent means `cleaner`, for ever (`roleOf` in model.ts). `POST /api/admin/cleaners` takes `{ name, role? }`. Codes come from the one `cleaner_codes` index; a code change and a deactivation are unchanged. The role is read from the document on every request (`readSessionCleaner`, `findCleanerByCode` and the create transactions all read it); the session token carries none.
- **The doors.** `requireRole` (session.ts) answers 403 `ROLE_MISMATCH` — "Your account cannot log this kind of entry" — for a cleaner on `POST /api/cleaner/work` and for a handyman on `POST /api/cleaner/entries` and `POST /api/cleaner/read-receipt`; a stored role outside the two opens neither. `GET /api/cleaner/start`, `GET /api/cleaner/entries` and `GET /api/cleaner/session` serve either and now answer `role`. The create transactions check the role again, so a role changed mid-request leaves no entry behind.
- **A work entry** (`createWorkEntry`, `POST /api/cleaner/work`, JSON `{ submissionKey, propertyId, description, price }`): `kind: 'work'`, one line `{ name: description, quantity: 1, lineTotalCents }`, `taxCents: null`, `receipts: []`, `note: null`, `purchasedOn: null`, `status: 'pending'` always, `autoApproved: null`, the `submitted` event by actor role `handyman`. The description is NFC, runs of whitespace as one space, trimmed, 1–200 characters (`LIMITS.WORK_DESCRIPTION_MAX`); the price is `"185.00"`, positive. The send-once guard and the in-transaction re-read are the receipt route's; there is no upload, no reading, no orphan to log. 201 `{ id, status: 'pending', createdAt }`; 200 `alreadyReceived`.
- **The handyman's app** (`HandymanApp.tsx`, `WorkScreen.tsx`, `work-draft.ts`): the same `/cleaner` page; the start route's `role` hands over. Code → property (the same screen, the same cleaner-facing names, "My work" in the bar) → Work: "What did you do?" (one text area, 200 characters, with a count) and "Price" (`$`, the number pad; "185", "185,50" and "$185.5" all read) → Send → Sent ("Work · $185.00 · It waits for the office to approve it"). The draft is kept in localStorage under the account's ID with its own one-time key; the phone's Back and the step logic are the cleaner flow's. The bar's tag reads "Work". "My work" is the receipts list route with the description on each row. Item-name suggestions are drawn from receipt entries only (`readCleanerStart` selects `kind` and skips work).
- **The admin's view.** A "Work" badge beside who logged it, on the row and in the pane; the row's Receipt column reads "No receipt: handyman work"; a Kind filter ("Receipts and work / Receipts (n) / Work (n)") and a "Logged by" filter beside Status, both in the URL (`?kind=`, `?cleaner=`). The pane says "Work done" in place of "Items bought", with Description and Price as the column heads, and the description in full. **Correct** changes the description or the price as a `line_corrected` event; the lines route's schema now allows a 200-character name and `changeEntryLine` holds a receipt line to 120 (422 `ENTRY_LINE_NAME_TOO_LONG`); no line is added to a work entry (422 `ENTRY_WORK_ONE_LINE`, my decision: a work entry is one description and one amount). The tax can be corrected (an invoice may carry it). Approve, reject, remove: unchanged. In the Excel file a `Kind` column and "Logged by" in place of "Cleaner", and "What was bought / work done"; in the PDF the column reads "What was bought / work done", a work entry's description wraps to a second line rather than being cut, and a note says what a work entry is. Every work entry needs an admin's approval regardless of amount (Kian's ruling); the queue shows them beside pending receipts.
- **The header** reads **Team** for the cleaners page (my decision; "Cleaners" is one word to restore), which gains a Role column, a role choice on the create row and the 90-day column.

### 16.4 Stored shapes: what is new, and what is untouched

On new documents only: `cost_entries` gains `kind` and `autoApproved`, may have `receipts: []` on a work entry, and history gains the word `seen` and the actor roles `system` and `handyman`; `cleaners` gains `role`. No collection is added, `firestore.rules` and the export script are unchanged, and no existing document is written. Readers keep absent as `receipt` and `cleaner` for ever. Nothing about income, statements, the tracker, the backup, property management records or co-owners (parts B and C) is here.

### 16.5 Routes

| Route | Door | Request | Answer |
|---|---|---|---|
| `POST /api/cleaner/work` | handyman | JSON `{ submissionKey, propertyId, description, price }` | 201 `{ id, status: 'pending', createdAt }`; 200 `alreadyReceived`; 403 `ROLE_MISMATCH` for a cleaner; 415, 400 `ENTRY_BAD_REQUEST`, 422 (schema, `ENTRY_PROPERTY_NOT_FOUND`), 502 (`SUBMISSION_CHECK_FAILED`, `PROPERTY_LOOKUP_FAILED`, `ENTRY_WRITE_FAILED`) |
| `POST /api/cleaner/entries` | cleaner | as before | 201 with `status` and `autoApproved`; 403 `ROLE_MISMATCH` for a handyman |
| `POST /api/cleaner/read-receipt` | cleaner | as before | 403 `ROLE_MISMATCH` for a handyman |
| `GET /api/cleaner/start`, `GET /api/cleaner/entries`, `GET /api/cleaner/session` | either | none | as before, plus `role`; each entry carries `kind` and, on work, `description` |
| `POST /api/admin/cleaners` | admin | `{ name, role? }` | as before; each row carries `role` |
| `POST /api/admin/cost-entries/[id]/seen` | admin | `{ seen }` | 200 `{ entry, changed }`; 409 `ENTRY_CHANGED`; 409 `ENTRY_NOT_AUTO_APPROVED` |
| `POST /api/admin/cost-entries/[id]/lines` | admin | as before; a name up to 200 | 422 `ENTRY_LINE_NAME_TOO_LONG` on a receipt line over 120; 422 `ENTRY_WORK_ONE_LINE` on adding to a work entry |

### 16.6 Verification (2026-09-30)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4650, throwaway admin and cleaner secrets, no `.env.local` in the build copy; builds `rmbcg6qWdXqvI96FWy9Q_` and, after a one-word change to the month tile, `zNrD8tmGDTV2DUvHFxgAz`), through the real routes and in a real browser. Opening export `backups/2026-09-30T23-33-41Z` (66 documents in 11 collections). Every write named a `__TEST__` account and the property "Corner Penthouse l Tall Ceiling", which had no entry.

- **Accounts.** `POST /api/admin/cleaners` with `{ name, role: 'cleaner' }` and `{ name, role: 'handyman' }`: 201, each answer carrying `role`; the stored handyman document holds `role: 'handyman'` beside its code. Both signed in at `POST /api/cleaner/session` (200, the cookie as before).
- **$199.99 as sent** (176.99 + tax 23.00) through `POST /api/cleaner/entries`: 201 `status: 'approved', autoApproved: true`. Stored: `kind: 'receipt'`, `status: 'approved'`, `statusChangedAt` equal to `createdAt`, history `submitted` (cleaner) then `approved` (`from: 'pending'`, `to: 'approved'`, actor `{ role: 'system', id: null, name: 'auto-approval' }`, reason "Under $200.00: approved automatically"), both at the same instant, and `autoApproved: { thresholdCents: 20000, totalCents: 19999, at }`. **$200.00 as sent** (177.00 + 23.00): 201 `status: 'pending', autoApproved: false`; stored pending, one history event, `autoApproved: null`.
- **The queue** (status "Needs attention (3)", "3 of 5"): the group "Approved automatically, not yet looked at (1)" with "Mark all 1 as seen" at the top, the $199.99 row reading "Approved · auto" with a Seen button; then "Needs a decision (2)": the work entry (badge "Work", "No receipt: handyman work") and the $200.00 receipt, both Pending. The pane of the $199.99 entry: the note "Approved automatically: under $200.00, and no admin has looked at it. It counts in the ledger now. Correct it, remove it, or mark it seen. The rule saw $199.99.", the buttons Seen, Reject…, Remove…, the history "Approved automatically · was pending", and "Last 90 days: 2 receipts (too few to judge) · $150–200: 1 · $200 and over: 1 · approved automatically: 1 of 2". **Seen** on the row: "Marked as seen", the group gone, "Needs attention (2)", "2 of 5"; the entry still approved with a third event `seen` by the admin. The seen route afterwards with the current history length: 200 `changed: false`; on the pending entry: 409 `ENTRY_NOT_AUTO_APPROVED`; with a stale length: 409 `ENTRY_CHANGED`; without a session: 401. Nothing written by any refusal.
- **The work entry** through `POST /api/cleaner/work`: 201 `{ id, status: 'pending', createdAt }`. Stored: `kind: 'work'`, one line `{ name: <description>, quantity: 1, lineTotalCents: 18500 }`, `taxCents: null`, `receipts: []`, `status: 'pending'`, the `submitted` event by actor role `handyman`, `autoApproved: null`. **The doors:** the cleaner's session on the work route 403 `ROLE_MISMATCH`; the handyman's on the receipt route and on the read-receipt route 403 `ROLE_MISMATCH`, before any body was read. **The admin's view:** the pane headed "Work done", columns Description and Price, "No receipt: handyman work. The description and the price are what the handyman logged." **Correct** with a 149-character description: 200, a `line_corrected` event with the line before and after, `lines` untouched; a 130-character name on a receipt line: 422 `ENTRY_LINE_NAME_TOO_LONG`; adding a line to the work entry: 422 `ENTRY_WORK_ONE_LINE`. Approved from its pane.
- **The ledger** of the property: two rows, the work row marked "Work" with "No receipt: handyman work", the $199.99 row "Approved · auto"; totals `2 | $384.99 | $0.00 | $384.99 | $23.00`. **Excel:** the Entries sheet's heading `Date sent | Ref | Entry ID | Kind | Logged by | What was bought / work done | Lines | Items (CAD) | Tax (CAD) | Total (CAD) | Corrected`, the receipt row `Receipt | __TEST__ Dispatch 24 cleaner | … | 176.99 | 23.00 | 199.99`, the work row `Work | __TEST__ Dispatch 24 handyman | <the 149-character description in full> | 1 | 185.00 | none | 185.00 | Yes`, period total `361.99 | 23.00 | 384.99`; the Items sheet with the description and "Corrected". **PDF** (recorded, one page): the column "What was bought / work done", the work row's description on two lines ("__TEST__ Replaced the kitchen / faucet cartridge, resealed the sink…"), `$185.00  none  $185.00 *`, period total `$361.99 $23.00 $384.99`, and the note "An entry marked as work is a handyman's work done for the property, at the price logged: no receipt, and Items is that price."
- **The handyman's app**, in the browser with the test handyman's code: the bar "NUBNB · Work · My work", "Hi __TEST__", "Which property?"; the property tapped; "What did you do?" with Work done and Price; Send with nothing typed: "Say what you did", "Type the price"; "95" read as $95.00; Send: "Sent · Corner Penthouse l Tall Ceiling · Work · $95.00 · It waits for the office to approve it."; "My work": both entries with their descriptions, "Sep 30 · work", "Waiting for review" and "Approved · Changed by the office."
- **The pattern rule, pure**, on made-up entries (the three modules transpiled and run in node, `pure/check-patterns.mjs`): 38 checks, 0 failed — the window's edges (89 days in, 90 out, tomorrow out), the band's edges ($149.99 out, $150.00 and $199.99 in, $200.00 out), 3 of 5 fires and 2 of 5 does not, 40 % exactly fires and 37.5 % does not, 3 of 4 is too few, rejected and removed receipts count, work entries never, splits at $199.99 (no) and $200.00 (yes), across two properties or two days (no), one split set does not fire and two do even with four receipts, the plan's example sentence word for word, and `awaitingLook` after seen, a correction, a removal and a manual approval.
- **The pattern rule, in the browser**, with a made-up 90 days stubbed into the page's one read: on the firing set the panel named "Bea Stub: 7 of 14 receipts in the $150–200 band (50 %)" and "Cal Stub: 2 same-day splits that add up to $200 or more" with both sets listed; "Al Stub" (2 of 6) was not named; the link set the queue to `?kind=receipt&cleaner=bea`, "14 of 24", her pane reading the distribution and "Worth a look". On the quiet set (3 of 8 at 37.5 %; one split set; 3 of 4, too few) the panel was absent and each pane read its distribution with "(too few to judge)" where it applied. **On real data**, after three more receipts at $160, $170 and $180 (each 201, approved automatically): the panel read "__TEST__ Dispatch 24 cleaner: 4 of 5 receipts in the $150–200 band (80 %)" with the day's split of four; the home tile read "5 · Costs to review · 2 entries pending, $295.00 · 3 approved automatically, not yet seen · 1 cleaner worth a look" in the alert tone, and the month tile "9 entries"; the Team page's row read the distribution and "Worth a look".
- **Written before this:** the two production entries read through the admin route as `kind: 'receipt'`, `autoApproved: null`, history `approved/admin`, out of the queue; the two production cleaners as `role: 'cleaner'`. Neither document was written: the closing export is byte-identical.
- **Cleanup** by exact ID and path: 19 documents (two accounts, their two codes, six entries, six submissions, one PDF record) and five receipt objects, each confirmed gone; the leftovers scan found no `__TEST__` in any collection. Closing export `backups/2026-09-30T23-44-50Z`: all 11 files byte-identical to the opening one, 66 documents. Storage holds 4,642 objects, `receipts/` exactly the two production receipts. No count was taken before the writes (an omission): the five objects created are each confirmed deleted, and 4,642 is the third round's 4,641 plus the receipt of the production entry sent since.

**Not exercised:** the production admin panel; a `Mark all n as seen` that fails midway (the code stops and reports the count); the header's Team link is a full navigation on the local build, so the home tile was shown on real data only.
