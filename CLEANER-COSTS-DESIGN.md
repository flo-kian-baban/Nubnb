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

---

## 17. Monthly statements: income, the live PDF, finishing and superseding, the tracker (dispatch 23B, 2026-09-30)

Part B of the financial engine, built to `FINANCIAL-MANAGEMENT-PLAN.md` §2.4, §2.5, §2.6 and §2.9, with the PDF core lifted per §1.2. **Kian's decisions (2026-09-30):** the fee is an amount typed on each statement, prefilled from a per-property default, with a free-text label; code never multiplies. Co-owners are a server-only per-property record: names, optional emails, the month statements start from (default October 2026) and optionally the month they stop; without it a statement reads "Prepared for the owners of <property>". Late entries and later changes are carried into the next statement under "From earlier months" and "Adjustments to earlier statements"; superseding is reserved for a mistake in the statement itself. My decisions of §2.8 and §2.13 stand: the real PDF as the live preview, the draft saved in place with a revision check, the PDF bytes stored with their SHA-256, downloads recorded, work entries in `cost_entries`, the header pill Team. The Drive backup (part C) is not here: no backup column, panel or tile.

### 17.1 The stored shapes (reported before building)

Four server-only collections and one Storage prefix, all denied in `firestore.rules` and listed in `scripts/export-firestore.mjs`. No field is added to any existing collection and no existing document is written.

- **`monthly_report_drafts/{propertyId}_{YYYY-MM}`** `{ schemaVersion: 1, propertyId, month, income: IncomeRow[], fee: { label, amountCents } | null, notes, supersedes: { reportId, reason } | null, revision, createdAt, updatedAt, finishedAs: string | null, finishedRevision: number | null }`. Created on the first save (`revision` 1), then updated in place, each save naming the revision it loaded. Never deleted. `finishedAs` names the report it was finished as; a correction sets it back to null with `supersedes` set.
- **`monthly_reports/{autoId}`** `{ schemaVersion: 1, propertyId, propertyNameAtFinish, month, ownersAtFinish: [{ name }], income, incomeCents, costs: [{ entryId, ref, day, kind, description, itemsCents, taxCents, totalCents, corrected, historyLength, receiptSha256, group: 'month' | 'earlier' }], adjustments: [{ entryId, statementId, printedCents, nowCents, deltaCents, historyLength }], costsCents, fee, feeCents, payableCents, pendingLeftOut, notes, entryIds, finishedAt, actor: admin, supersedes, draftRevision, pdf: { path, bytes, sha256 } }`. Created once with `create()`, never updated.
- **`report_downloads/{autoId}`** `{ schemaVersion: 1, reportId, propertyId, month, at, actor }`, create-only, one per download link minted.
- **`property_management/{propertyId}`** `{ schemaVersion: 1, propertyId, owners: [{ name, email | null }], statementsFrom, statementsUntil | null, defaultFee: { label, amountCents } | null, setAt }`, set whole on save; cleared by deleting, so absent stays the one way of saying "none".
- **Storage `monthly-reports/<reportId>.pdf`**, create-only (`ifGenerationMatch: 0`), private, `no-store`, with `{ reportId, propertyId, month, sha256, finishedAt }` in its metadata.
- `IncomeRow` is `{ id, source: 'airbnb' | 'vrbo' | 'private' | 'other', label, reference | null, from | null, to | null, amountCents }`, non-zero, negative for a refund.

The new collections are written only by this code, so they are read strictly (`readMonthlyReport`, `readStatementDraft`, …): a document not in the written shape is left out and counted, never re-rendered or added up.

### 17.2 The arithmetic (`app/lib/reports/statement.ts`, pure, on both sides)

`buildStatement` takes the property's entries, its finished reports, the draft and the management record, and returns the statement and the page's claim. An entry belongs to the Toronto month it was sent in (the ledger's rule). The month's approved entries are its cost rows; approved entries sent in an earlier month, on or after the first statement month, that no current report lists are the "From earlier months" rows; every entry a current report printed whose amount now differs from the most recent printing (a cost row's total or an adjustment's "now"), or which has left the ledger, is an adjustment, carried once. A report is current unless a newer one names it in `supersedes`; the report being superseded is treated as not current, so its entries come back into the correction. An entry of the month that another current report already lists (after a correction) is left out and said. Income − costs − fee = payable; costs include the adjustments' differences, so a month's costs can be negative. The closing line reads "Payable to the owners" or, below zero, "Balance owed to Nubnb". "Nothing to report" is a statement with no rows and no fee, finished like any other.

`sameClaim` compares the page's claim with the server's rebuild in any order; `trackerRows`, `trackerCounts` and `looseEnds` are the tracker's and the tile's.

### 17.3 The writer (`app/lib/pdf/core.ts`, `app/lib/reports/statement-pdf.ts`)

The primitives of `costs/pdf.ts` (metrics, encoding, measuring, `Page`, `assemble`) moved to `pdf/core.ts` with one addition, a filled rectangle (`re f`); `pdfFor` is unchanged byte for byte (checked on a 43-entry report: 18,925 bytes, the same SHA-256 before and after). The statement: the head (property, month, "Prepared for …", the ref or "Draft", the superseding line), income rows and total, the recorded costs on a grey band under their caption, the earlier rows and the adjustments under their own headings, the fee, the boxed closing figure with the four lines above it, the notes, the standard notes and "Statement finished … · ref …", and on every page the property and month and "Page n of m"; the running head from page two. The same bytes for the same frozen object: the finish step stores what the writer makes, and the page proves it after finishing by hashing the writer's output on the returned object against the stored SHA-256.

### 17.4 The server (`server-reports.ts`, `server-management.ts`)

- `GET /api/admin/monthly-reports/draft?property=&month=` answers the bundle: the property's name, the draft (or null), every entry of the property, every finished report of the property, the management record.
- `PUT /api/admin/monthly-reports/draft` saves the draft whole in a transaction: 409 `DRAFT_CHANGED` when the stored revision is not the one sent (the hint names the stored revision); 409 `DRAFT_FINISHED` on a finished month unless `supersedes` names the report it was finished as (422 `REPORT_NOT_FOUND` otherwise), which reopens the draft as a correction.
- `POST /api/admin/monthly-reports` finishes: reads the bundle, refuses a draft at another revision or already finished (409 `DRAFT_CHANGED`), rebuilds and compares the claim (409 `STATEMENT_CHANGED`, 409 `STATEMENT_ENTRY_UNREADABLE`), allocates the report's ID, runs the writer with the ref and the finish time, stores the PDF create-only (502 `STATEMENT_PDF_FAILED`, nothing written), then in one transaction re-reads the draft, the entries and the reports, rebuilds, compares again, `create()`s the report and marks the draft finished (502 `STATEMENT_RECORD_FAILED`, may or may not have landed; an orphaned PDF is logged by path). 201 `{ report }`.
- `GET /api/admin/monthly-reports/[id]/pdf` answers a 60-second V4 signed link and creates one `report_downloads` record. `GET /api/admin/monthly-reports` answers the tracker's data, read whole.
- `GET`/`PUT /api/admin/properties/[id]/management` read and set the record (null clears it).

### 17.5 The screens

- **`/admin/reports`**, the Reports section's home: the month with ‹ › (opens on the last closed month; `?month=`), the line "September 2026 · n of m statements finished · n outstanding · n drafts in progress", the table (Property · Statement · Income · Costs · Fee · Payable · Exported · Open / Download PDF), outstanding first in the alert tone and in that word, a replaced statement listed under its row with the reason, and the loose ends (pending entries sent in the month, late approved entries in no statement, adjustments waiting).
- **`/admin/reports/edit?property=&month=`**: the fields on the left (Income rows with ↑ ↓, source, description, reference, stay dates, amount; the fee, prefilled from the property's default; the recorded costs on their grey band with Open entry, the earlier rows and adjustments marked, the pending warning; the notes; Finish and freeze…) and the PDF on the right, redrawn 300 ms after the last change into two swapped iframes. The head says "Draft · saved …", "Saving…", "Not saved: …" or "Finished … · ref … · Download PDF · Correct this statement…". Saves go 800 ms after the last change; `DRAFT_CHANGED` reloads the draft and says so. After finishing, the page hashes the writer's bytes on the returned report and shows "Stored PDF verified: SHA-256 matches".
- **The property form**: a "Co-owners and statements" block (names and optional emails, statements from and until, the default fee), loaded and saved apart from the property through its own route, as the name for cleaners is.
- **The admin home**: a seventh tile, "Statements outstanding, <last closed month>", with "n of m finished · n drafts in progress", in the accent tone while any is outstanding; the grid goes to four columns at 1,200 px.
- **The header** gains **Reports** between Costs and Team.

### 17.6 Verification (2026-09-30, evening)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4660, throwaway admin and cleaner secrets, no `.env.local` in the build copy; builds `VXpfkHS4TBAoIMPAvm8yD`, then `9rnhCeNfgMtXblrnxT4AR` after the preview's fallback swap, then `MpDMGAPHp_mfJ-8el0_zA` after the tracker learned to show a statement outside a property's scope), through the real routes and in a real browser. **Storage counted before the first write: 4,642 objects.** Opening export `backups/2026-10-01T00-35-04Z` (66 documents, 11 collections). The test property was "Corner Penthouse l Tall Ceiling" (no entries), with two more properties that had no record.

- **The ledger PDF after the lift:** `pdfFor` on a 43-entry report before and after moving the core: 18,925 bytes, SHA-256 `52d51323…`, byte-identical.
- **The arithmetic, pure** (`pure-b/check-statement.mjs`, the modules transpiled and run in node): 36 checks, 0 failed — the window and the band of months, a September statement with a late August entry and a pending one, the claim, "Prepared for Ann Lee and Bo Chen" and "Prepared for the owners of", the closing words either side of zero, an October statement carrying a late September entry and two adjustments (a correction and a removal), a November statement with nothing to report, an entry approved again carried once from its last printing, superseding September (the old statement not current, its entries back, no adjustment against October), `currentReports`, `sameClaim` in any order, the writer deterministic on the same frozen object and different between a draft and a finished one, the tracker's order and counts, replaced ×1, and the loose ends.
- **The record** (`PUT /api/admin/properties/[id]/management`): two `__TEST__` owners, statements from 2026-09, default fee 150.00: 200, read back the same; `2026-13` as a month: 422. The property form loaded the block with both owners, the months and the fee.
- **The draft, in the browser:** the editor opened with the fee prefilled "__TEST__ Management fee / 150.00" from the record, the two approved entries recorded ($590.00) and "Balance owed to Nubnb: $740.00" before any income. Two rows typed: "Draft · saved 8:36:51 p.m.", the stored draft at revision 1 with `amountCents 123450` and `40000`. Row 1 moved down: saved, revision 2, the stored order swapped. **A second tab** (the API) saved October's draft at the revision the page held: 200, revision 2; the same save again at the stale revision: 409 `DRAFT_CHANGED`, "It is at revision 2", nothing written; the first tab then typed into the notes and its save was refused: the page showed "This draft was changed elsewhere — another tab or another admin. Your last change was not saved. The draft is reloaded as it is stored." with the second tab's rows and notes, revision still 2.
- **Finished, in the browser:** the confirm ("Closing figure: Payable to the owners $894.50 … never edited") accepted; "Finished Sep 30, 2026, 8:36:58 p.m. · ref cagTIh", "✓ Stored PDF verified: SHA-256 matches", Download PDF and Correct this statement… in the head, the Finish block gone. **The proof outside the browser:** the returned frozen object through the writer in node, 5,145 bytes, SHA-256 `9caf3e14…`, equal to `report.pdf.sha256`; the stored object fetched through the 60-second link, 5,145 bytes, the same SHA-256, byte-identical to the writer's output; one `report_downloads` record. The PDF read back: "Prepared for __TEST__ Ann Lee and __TEST__ Bo Chen", the two income rows, the two cost rows on the band, Total costs $590.00, the fee, "Payable to the owners $894.50", "Statement finished 30 Sep 2026, 8:36 p.m., Toronto time · ref cagTIh".
- **The live PDF:** this headless Chromium has no inline viewer (`navigator.pdfViewerEnabled` false), so a PDF iframe never fires `load` there; the swap now happens on `load` or after 1.5 s, and the page says "This browser does not show PDFs inline" with the PDF offered in a tab. After that, the shown frame held the blob, and its bytes hashed in the page were 5,145 bytes, SHA-256 `9caf3e14…`: the preview is the stored object. Inline rendering by a real viewer was not exercised here.
- **A late entry and a correction:** a third September receipt approved after the statement, and line 1 of a printed entry corrected 250.00 → 230.00. October's draft (the route's bundle through `buildStatement`, and the editor) showed "From earlier months, not previously reported: 30 Sep 2026 · __TEST__ Late supplies · $210.00" and "Adjustments to earlier statements: FmdmKx · Printed $260.00 in ref cagTIh, now $240.00 · ($20.00)", costs $190.00, the claim naming both.
- **Superseding, in the browser:** Correct this statement… took the reason in the prompt; "Correction · saved", the income, fee and notes copied, the costs read fresh (now three rows, the corrected entry at $240.00 marked *, the late entry among them); the fee changed to 120.00; finished: "ref c5qiJN · replaces ref cagTIh", the SHA-256 verified again (5,858 bytes, `d9835d17…`, the stored object byte-identical). The tracker for September: "Finished … ref c5qiJN · replaced ×1 · $1,634.50 · $780.00 · $120.00 · $734.50 · downloaded once", and under it "Replaced · ref cagTIh, finished 8:36 p.m., replaced on 8:42:48 p.m. by ref c5qiJN: “__TEST__ Wrong fee…”" with its own Download PDF. The PDF read "Replaces the statement finished 30 Sep 2026 (ref cagTIh). Reason: …". **Neither written again:** every `monthly_reports` document's `updateTime` equalled its `createTime`, the replaced one included. October's draft afterwards: no costs and no adjustment, the late entry now in September's correction.
- **No record:** "Private Basement Near Yonge St" finished with no rows: the PDF reads "Prepared for the owners of Private Basement Near Yonge St", "Nothing to report this month.", every total $0.00. "3 Bedroom 2 Bath Main Floor House" with income $10.00 and a fee of $100.00: "Balance owed to Nubnb $90.00"; the tracker row "($90.00) owed to Nubnb". Both writers' SHA-256 equal to the stored. A second finish of a finished draft: 409 `DRAFT_CHANGED`; a save of a finished month without `supersedes`: 409 `DRAFT_FINISHED`.
- **The tracker against a hand count** from the mid-run export `backups/2026-10-01T00-43-45Z` (85 documents): by hand, September 3 in scope · 3 finished · 0 outstanding · 0 drafts (Corner Penthouse replaced ×1, downloaded once), August 0 of 0; `trackerRows` on the tracker route's data: the same; the page: "September 2026 · 3 of 3 statements finished · 0 outstanding · 0 drafts in progress" and "August 2026 · 0 of 0". (The first build showed "1 of 1": the two no-record properties fell outside the default scope although they had statements; a property with a statement or a draft for the month is now a row whatever its scope.) **The tile against the tracker:** "0 · Statements outstanding, August 2026 · No property expects a statement for this month yet", the same words as the tracker's August; seven tiles in four columns at 1,280 px; the header "Properties · Leads · Costs · Reports · Team · Availability".
- **Cleanup** by exact ID and path: 19 documents (the record, the cleaner and its code, three entries, three submissions, four drafts, four reports, two downloads) and seven objects (three receipts, four statement PDFs), each confirmed gone; the four collections empty; no `__TEST__` anywhere. Closing export `backups/2026-10-01T00-46-26Z`: all 11 files byte-identical to the opening one, 66 documents. **Storage 4,642 before the first write and after cleanup**, `monthly-reports/` empty. One draft made in the browser had not been put in the cleanup ledger and was deleted by ID in a second pass, after which the export was taken again.

**Not exercised:** the production admin panel; inline rendering of the preview by a browser with a PDF viewer; `STATEMENT_CHANGED` from an entry changed between load and finish (the server's rebuild-and-compare is exercised by the pure checks and the second-finish refusal, not by a race); a statement of more than a few rows through the route (the writer's four-page case ran in node only).

## 18. Income rows simplified, the property page as the place of work, the current month reportable, costs added by the office (dispatch 23D, 2026-09-30)

Kian's rulings of 2026-09-30 (dispatch 23D), built on `e81aafa`: an income row is a description and an amount; everything for a property is on its page (its costs, its income, its statements), reached from the admin list as before; a statement can be finished for a month that has not ended, "outstanding" is a closed month with no finished statement, and the current month reads "open, not yet due"; an admin can add a cost on the property page, with no receipt, approved on creation; and no page in the flow is a dead end. Nothing in `CLAUDE.md` is mine.

### 18.1 The stored shapes (reported before building)

- **An income row** written from now is `{ id, label, amountCents }`. A row written before carries `source`, `reference`, `from` and `to` as well; `readIncomeRow` keeps each of the four on the row exactly when it is present in the stored object (`'source' in value`), so a draft from before round-trips unchanged through a save and a finished statement from before prints as it did. The draft and report `schemaVersion` go to 2, saying only that rows may lack the four fields. `IncomeRowInputSchema` takes the four as optional and writes them only when sent; the editor and the property page send them back on a row loaded with them and never on a new row. No existing document is written.
- **An office cost** is one `cost_entries` document: `kind: 'office'`, `cleanerId: null`, `cleanerNameAtEntry: null`, `receipts: []`, `lines: [{ name: description, quantity: 1, lineTotalCents }]`, `taxCents` as typed or null (the field present, so tax is apart), `status: 'approved'`, `autoApproved: null`, and two history events at one instant, `submitted` and `approved`, both by the admin actor, the approval's reason `Added by the office: approved on entry` (the shape an automatic approval already has, so every reader of history keeps working). Told from a receipt by the word and by having no receipt object and no account; from work by the word and by the actor on its first event. No one-time submission key: the admin page sends once and says when an outcome is unknown. `ENTRY_KINDS` gains `office`; `isOneLineKind` names work and office as one description and one amount; `LIMITS.OFFICE_DESCRIPTION_MAX` is 200.
- **No new collection.** `firestore.rules` and the export script are unchanged.

### 18.2 What was built

- **`app/lib/reports/model.ts`**: the row shape and reader above; `incomeRowHasDetails`; `isClosedMonth`, `monthsBetween`.
- **`app/lib/reports/statement.ts`**: the tracker state `open` ("Open, not yet due") for a month that has not ended with nothing started, with `today` an input; `STATEMENT_STATE_LABELS`; `trackerCounts.open`; `propertyMonths` for the property page (the months from the first statement month, or the current month, or an earlier month with a statement, to the current month or later; each month's state; the closed in-scope months with no finished statement as `outstanding`, a month with only a draft included, the current month never); `incomeDetailsOf` / `incomeDetailsText` for a row written before; and the fix in 18.4.
- **`app/lib/reports/statement-pdf.ts`**: income rows print as description and amount; a statement holding any row written before keeps the earlier five-column layout for every row, the newer rows' extra columns blank. The standard note now reads "Each cost is one receipt, one piece of work, or one cost Nubnb recorded directly."
- **`app/lib/costs/pdf.ts`**: a work entry prints "Work: …" and an office entry "Office: …" in the ledger PDF, each with its note; the general sentence names the three. `cleanerLabel` reads "Nubnb office" on an office entry, so the Excel "Logged by" and the queue say it; the Excel "Kind" column reads "Added by the office".
- **`server-cost-entries.ts`**: `OfficeInputSchema`, `createOfficeEntry` (one `create()`); `changeEntryLine` lets an office description run to 200 and refuses adding a line to a work or office entry. **`server-reports.ts`**: `readPropertyStatements` (one property's reports whole, drafts whole, downloads, management record).
- **Routes**: `POST /api/admin/cost-entries` `{ propertyId, description, amount, tax }` → 201 `{ entry }` (422 `ENTRY_PROPERTY_NOT_FOUND`, 502 `PROPERTY_LOOKUP_FAILED` nothing written, 502 `ENTRY_WRITE_FAILED` unknown); `GET /api/admin/properties/[id]/statements` → `{ propertyName, reports, drafts, downloads, management, unreadable }` (404 `PROPERTY_NOT_FOUND`).
- **The property page** (`/admin/costs?property=&status=approved`, the ledger), laid out for clarity after Kian's first look the same night ("clarity is the key, not a lot of descriptions, but clear and smart layout"): the title and one short line ("Costs ledger · approved entries · Review queue (n waiting)"); then `PropertyPanel` — a month control on the left ("September 2026 · open, not yet due"), the one line "Nothing outstanding · statements from October 2026" or "Outstanding: July 2026, August 2026 (draft)" on the right, and two blocks: **Income** (the rows, a row written before with its details under it, and the add form: description, amount, Add income; frozen once the month is finished, with "Correct the statement") and **Statement** (the state once, as a badge; one line of fact — "Sep 30 · ref ykHRE5 · Payable to the owners $470.95" or "Saved …"; Create statement / Continue draft / Open statement; Download PDF, its download count in the tooltip; and "All statements" under it). Then a **Costs** block head with its one action, **Add a cost** (`AddCostForm`: description, amount, optional tax); the filters; one summary line ("2 approved entries · $221.05 · tax $24.05", or "No approved costs in these dates") with Excel and PDF beside it; the Entries / Items bought tabs; the list and the pane. No explanatory paragraph anywhere on it; the earlier design had the state said three times and six sentences of prose. The Kind filter gains "Added by the office"; the receipt column reads "No receipt: added by the office".
- **The entry pane**: "Nubnb office · Added by the office"; "Cost" with Description and Amount; no Add a line; no 90-day section; and a new section **Property and statement**: the link to the property's page, and the statement the entry went into (the current one that printed it, with any replaced one counted; else "Not yet in a finished statement: it belongs to <month>'s, or to a later one as a late entry" with the link; "In no statement until it is approved"; or not in any) plus any adjustment printed for it. The page reads each property's statements once (the ledger's property, and the open entry's).
- **The editor**: rows are a description and an amount (↑ ↓, Remove); a row written before shows its details line and is saved back as loaded; the one line about an open month ("September 2026 has not ended. It can be finished now; entries approved after that go into October 2026's statement, under 'From earlier months'", or, once finished, "…and this statement is finished: entries approved from now on go into…"); **Property** beside Tracker in the header; a cost row of kind office reads "· added by the office".
- **The tracker**: "open, not yet due" rows and count (outstanding first, then open, then drafts, then finished); the note beside the month reads "the current month: open, not yet due" / "not started yet"; a **Property** link on every row. The home tile is unchanged (it reads the last closed month).

### 18.3 My decisions, not rulings

The day of an office cost is the day it was added; its amount is positive and one line, correctable and removable through the existing actions, with no line added (as work); in the co-owner statement PDF its row prints like any other, while the ledger PDF marks it "Office:" and gives work entries the matching "Work:" (the ledger PDF's note already spoke of entries "marked as work" while nothing marked them); on the property page a closed month with only a draft is listed as outstanding with "(draft in progress)", because the ruling defines outstanding as no finished statement, while the tracker keeps its three-way count from 23B; the current month is always in the property page's month list, whatever the property's scope, so a statement can be made for it; the "open" state applies to a future month too; the property page reads full reports for one property (a few KB each) rather than widening the cost-entries answer.

### 18.4 A defect of 23B found while verifying, and fixed

The tracker's "adjustments" loose end could never fire: `looseEnds` compared what each statement printed through `lastPrinted`, which read `costs` and `adjustments`, and the tracker handed it summaries with those arrays emptied. The summary now carries `printed: { entryId, cents }[]` (`printedBy`), `lastPrinted` reads that, and `looseEnds` takes the summaries as they are (`LooseEndsReport`). Four pure checks cover it.

### 18.5 Observed, not changed

Finishing an older month after a newer one carries the newer month's later changes into the older statement: August 2026, finished after September's, printed the adjustment for a September entry removed in between ("ref ykHRE5 · no longer in the ledger"), and October's draft then no longer did. That is 23B's rule (each change carried once, by the next statement finished) applied in finish order rather than month order; a co-owner reading August sees a September correction. Left as it is; Kian's to rule on.

### 18.6 Verification (2026-09-30, late evening)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4500, throwaway admin secret, no `.env.local` in the build copy; builds `bqwqG58NJVjet_nDylyTm`, then `_FurGRTo6_7evcc8peL2k` after the loose-ends fix of 18.4), through the real routes and in a real browser. **Storage counted before the first write: 4,642 objects.** Opening export `backups/2026-10-01T02-26-12Z` (71 documents, 12 collections). The test property was "Corner Penthouse l Tall Ceiling" (`1VpX0wMpaUkbFwkULD8P`, no entries), with a `__TEST__` management record from 2026-07. The opening export held two October 2026 drafts Kian had saved himself that evening, with rows in the earlier shape; they were read on the page and never written.

- **Pure** (`pure/check-23d.mjs`, 48 checks; `check-loose-ends.mjs`, 4): both row shapes read and refused as designed; details text; closed vs open months; the tracker's `open` state, order and counts; a property's months (the current month always listed, a range with a statement before it, a draft counted outstanding, a replaced month); the statement writer's plain and five-column layouts, the office row plain in the co-owner statement, the reworded note; an old-shape-only statement through the new writer and the 23B writer differing only in that note; the ledger PDF's "Work:"/"Office:" marks and notes; the Excel "Added by the office"/"Nubnb office"; a late entry after an early finish; the loose ends from summaries.
- **A simplified row stored and printed:** on the property page, "Add income" twice for September (800.00; −20.00): the stored draft `monthly_report_drafts/…_2026-09` at revision 2, `schemaVersion 2`, rows `{ id, label, amountCents }` and nothing else, the default fee copied in as the editor does; finished later, the PDF printed each row as description and amount ("__TEST__ Airbnb payout, 12-15 Sep … $800.00", "($20.00)").
- **An old-shape row still displaying and printing:** an August draft written exactly as 23B wrote it (schemaVersion 1; rows with `source`, `reference`, `from`, `to`): the editor showed the three rows with "Airbnb · ref HMTEST01 · 12 Aug 2026 – 15 Aug 2026 · recorded before", "Private · recorded before", "Other · ref DEP-7 · recorded before"; a note typed there saved the draft whole and the stored rows kept all four fields; finished, the PDF printed the five-column layout ("12 Aug 2026 – 15… Airbnb __TEST__ Airbnb payout, stay 12–15 Aug HMTEST01 $1,234.50"). Kian's October draft read "bye 10.00 · Airbnb · recorded before" on the page.
- **The current month from the property page:** September 2026 (today 30 Sep) read "Open, not yet due" on the page and the tracker ("1 open, not yet due"); the panel's "Continue the draft" opened the editor with the line "September 2026 has not ended. It can be finished now; entries approved after that go into October 2026's statement…"; Finish and freeze: ref ykHRE5, "Stored PDF verified: SHA-256 matches", the writer in node on the returned object 4,436 bytes `0c30f6fb…` equal to the stored object through the link; the line then read "…and this statement is finished: entries approved from now on go into October 2026's statement". An office cost added afterwards (12.00) appeared in October's draft under "From earlier months, not previously reported", and in the tracker's loose ends as "1 approved entry … in no current statement". July, outstanding, was created from the panel's month control ("Create the statement for July 2026") and finished with nothing to report (ref JgFckF).
- **A cost added by the office:** "Add a cost…" on the property page (description, 185.00, tax 24.05): 201, the stored document exactly as 18.1 (kind `office`, `cleanerId` null, `receipts` [], approved, two admin events, reason "Added by the office: approved on entry"); the ledger row "Nubnb office · Added by the office · $185.00 · $24.05 · $209.05 · Approved · No receipt: added by the office"; the pane "Cost", no Add a line, "Property and statement: … Not yet in a finished statement: it belongs to September 2026's…"; the Excel row Kind "Added by the office", Logged by "Nubnb office"; the ledger PDF "Office: __TEST__ Plumber call-out, kitchen sink" with its note; the statement editor's row "· added by the office"; the co-owner PDF's row plain. Corrected through the pane (185.00 → 180.00: "Line 1 corrected", "changed since PDF", "Entered by the office as $209.05"), removed ("Removed … was approved", out of the ledger and its totals, "in a PDF" said in the confirm), approved again through the status route (409 `ENTRY_CHANGED` first on a wrong `seen`, then 200): the tracker's loose ends then read "1 adjustment for Corner Penthouse…" (the 18.4 fix) and October's draft "FEAD17 · Printed $0.00 in ref 9dFnAw, now $204.05".
- **The tracker:** July 2026 "0 of 1 … 1 outstanding", the row "Outstanding"; August "1 draft in progress"; September "1 open, not yet due", the row "Open, not yet due"; October "0 of 46 … 44 open, not yet due · 2 drafts in progress" (Kian's two). The home tile: "0 · Statements outstanding, August 2026 · 0 of 1 finished · 1 draft in progress".
- **Every link in item 5 walked, with where each landed:** property page → Download PDF (`window.open` captured, the signed link fetched: 4,436 bytes, the September sha256); → Open the statement (the September editor); statement → Open entry (the ledger with the pane open on FEAD17); pane → "Open Corner Penthouse l Tall Ceiling's page" (the ledger); statement header → Tracker (`/admin/reports?month=2026-08`); tracker row → Property (the ledger) and the name (the editor); the editor without a property or month → "Which statement?" → Go to Reports; the home list's Costs control → the ledger; the review queue holding the removed office entry → its pane → "Open the statement" (September) and "Open it" (the August adjustment). The Kind filter read "Every kind | Receipts | Work | Added by the office".
- **Cleanup** by exact ID and path: 14 documents (the record, three drafts, three reports, four downloads, two entries, one PDF export record) and three statement PDFs, each confirmed gone; no `__TEST__` in any collection touched; `monthly-reports/` empty. Closing export `backups/2026-10-01T02-45-22Z`: all 12 files byte-identical to the opening one, 71 documents. **Storage 4,642 before the first write and after cleanup.**

**Not exercised:** the production admin panel; inline PDF rendering by a browser with a viewer; `DRAFT_CHANGED` between the property page and an editor open in another tab (the server's revision check is 23B's and was exercised then); the Excel export with a work entry beside an office one (the pure check covers the three kinds together).

## 19. The Payment Summary: the statement rebuilt to match the reports NuBNB sends (dispatch 23E, 2026-10-01)

Kian's rulings of 2026-10-01 (dispatch 23E), built on `e81aafa` plus the uncommitted dispatch 23D: the monthly statement is rebuilt to match NuBNB's existing Payment Summary reports in substance and wording — six real ones were read: August, July and June of 321 John, July and June of 19 Tannery, July of 3289 Flemming — and never says "co-owner" where a user can see it; a line is a description, a quantity, a rate and an amount, and **the code multiplies quantity by rate** (Kian's ruling: the one place code computes money); an amount may be negative; an income line may carry a date range; recorded cost entries appear as lines like any other, still not editable in the statement; the management fee is a rate the admin picks, the code computes the amount from the sum of the revenue lines and shows it, the admin can overwrite the amount and writes the label, and the rate, the final amount and whether it was overwritten are stored; the carried balance is an optional typed amount with its own label, suggested from the previous month's closing figure and never written automatically; "Report For" (the name and postal address printed) lives on the per-property record, editable in the unit's info and while writing a report, server-only, never on the property document; notes are free text at the foot; statements and drafts written before this still display and print, with no backfill. Nothing in `CLAUDE.md` is changed: the rulings are quoted here from the dispatch.

### 19.1 The stored shapes (reported before building)

No new collection. The draft and the report go to **schema version 3**; the per-property record gains two fields. No existing document is written; a document of an earlier version is read as it is and drawn as it was.

- **A line**, typed on a draft and frozen on a report: `{ id, description (1–160), from: yyyy-mm-dd | null, to: yyyy-mm-dd | null, quantity: integer 1–9999, rateCents: integer, non-zero, either sign, amountCents }` with `amountCents = quantity × rateCents`, computed in `app/lib/reports/statement.ts` (`lineAmount`) and checked again by the server, which refuses a line whose amount is not that product. A line loaded from a row written before (`{ id, label, amountCents, source?, reference?, from?, to? }`) becomes `{ id, description: label, from, to, quantity: 1, rateCents: amountCents, amountCents }` and keeps `source` and `reference` exactly when the row had them, as dispatch 23D kept them; they are shown under the line in the editor ("Airbnb · ref HMABC123 · recorded before") and not printed, since the Payment Summary has no column for them.
- **The fee** (v3): `{ label (1–120), rateBasisPoints: integer 0–10000 | null, baseCents: integer ≥ 0, computedCents: integer | null, amountCents: integer ≥ 0, overwritten: boolean }`. `computedCents = round(baseCents × rateBasisPoints / 10000)`, half up to the cent, null when there is no rate; `overwritten = amountCents !== computedCents`; both are worked out by the server from the rate, the base and the amount sent, never taken from the page. The base is prefilled from the sum of the revenue lines (the lines with a positive amount) and may be edited: the six examples compute the fee on "Net of $9,539.78", revenue less some expenses, so an editable base keeps the code doing the multiplication where a fixed base would have the admin overwrite every month by hand. My extension of the ruling, reversible. **Reversed 2026-10-03 by Kian's ruling (dispatch 26): the fee base has no default.** It starts empty on every new statement and is stored null until typed (`baseCents: integer ≥ 0 | null`; `computedCents` null too); a draft with a rate and no base saves, and finishing it is refused, 422 `STATEMENT_INCOMPLETE` with evidence `missing: feeBase`, in the page first. Drafts already saved keep the base they hold. "Use the revenue sum" is gone. A fee of the earlier shape `{ label, amountCents }` reads as rate null, base 0, computed null, overwritten true.
- **The carried balance**: `{ label (1–120), amountCents: integer, either sign, fromReportId: string | null }` or null. The amount is what is deducted from the total: "Balance From June: $359.96" is 35996. `fromReportId` names the previous month's statement when the suggestion was accepted, null when typed by hand. The suggestion is offered when the previous month has a current finished statement whose revenue share is below zero: label "Balance From <Month>", amount the share negated. A previous month that closed above zero was paid out and suggests nothing.
- **Report For**: `property_management/{propertyId}.reportFor: { name (1–120), address (0–300, line breaks kept, at most 6 lines) } | null`. Set from the property form with the whole record, or from the statement editor through `PUT /api/admin/properties/[id]/report-for` `{ name, address } | null`, which merges the one field into the record (creating the record with its defaults when the property has none). The record also gains `defaultFeeRateBasisPoints: integer | null`, the rate the editor starts a new statement from; `defaultFee` (an amount, dispatch 23B) stays readable and is sent back as loaded, no longer shown. `owners` stays as it is, shown as "Owners".
- **The draft** (v3): `monthly_report_drafts/{propertyId}_{YYYY-MM}` `{ schemaVersion: 3, propertyId, month, reference (0–60), reportDate: yyyy-mm-dd, lines: Line[], fee: Fee | null, carried: Carried | null, notes, supersedes, revision, createdAt, updatedAt, finishedAs, finishedRevision }`. A draft of version 1 or 2 is read with its `income` rows as lines and its fee as above; once the admin saves it, it is written in version 3 (`lines`, no `income`): a draft is a working copy nothing was issued from. Kian's two October drafts are read that way and never written by this work.
- **The report** (v3): `monthly_reports/{autoId}` `{ schemaVersion: 3, propertyId, propertyNameAtFinish, month, reference, reportDate, reportFor: { name, address } | null, lines, costs, adjustments, fee, carried, incomeCents, expensesCents, recordedCents, costsCents, feeCents, totalCents, carriedCents, payableCents, pendingLeftOut, notes, entryIds, finishedAt, actor, supersedes, draftRevision, pdf }`. `incomeCents` is the sum of the positive lines (the revenue), `expensesCents` the negative lines negated, `recordedCents` the recorded cost rows plus the adjustments' differences (as before), `costsCents = expensesCents + recordedCents`, `feeCents` the fee's amount, `totalCents = incomeCents − costsCents − feeCents` (the printed Total), `carriedCents` the carried amount, `payableCents = totalCents − carriedCents` (the printed "Your Revenue Share"). The field names the tracker and the tiles read are unchanged, so a report of any version shows in them. `ownersAtFinish` is not written on a v3 report. A `StatementAdjustment` written now also carries `description: string | null` and `printedMonth: string | null`, so its line can say what it is.
- **The reader** (`readMonthlyReport`, `readStatementDraft`) accepts every version written so far and says which: `legacy: true` on a report of version 1 or 2, whose statement is drawn by the writer of dispatch 23B/23D kept verbatim as `app/lib/reports/statement-pdf-legacy.ts`, so the editor's preview of such a statement is the bytes that were stored. `statementPdf` dispatches on it.

### 19.2 The document

US Letter, the writer of `app/lib/pdf/core.ts`, which gains an image: `assemble` takes optional images (width, height, Flate-compressed RGB) as XObjects numbered after the pages, so with none the ledger PDF's bytes are unchanged; `Page.image` draws one. **The logo** is the repo's own `public/logo-nubnb.png` (1384 × 1912, the same mark the six PDFs carry at 675 × 937), scaled to 400 × 553, flattened on white, deflated once by `scripts/make-pdf-logo.mjs` into `app/lib/pdf/logo.ts` as a base64 constant (21.7 KB binary in each PDF). Nothing is extracted from the PDFs. `winAnsi` learns the katakana middle dot (U+30FB, "Resolution Payout・Jul 28–29") as the middle dot, so such a description prints as it did.

Top left, the logo (84 pt wide), then "NuBNB Suites", "www.nubnb.ca", "416-738-1850", "647-500-8043" (the numbers as the six reports print them), then "Report For:" with the name in bold and the address lines; the block is omitted when the record has none. Top right, "Payment Summary", "# Aug-321-John" (a draft adds "Draft · not yet issued" under it; a correction adds "Replaces the report dated …; reason: …"), "Date: Sep 1, 2026", then the shaded band "Your Revenue Share: $8,232.17" — the headline figure at the top. One table, a dark header bar with Description · Transaction · Rate · Amount, the typed lines in the admin's order, then the recorded costs of the month as "Expense - <what was bought>", then earlier-month entries as "Expense - … (from June 2026)", then adjustments as "Adjustment - … (reported in June 2026 as -$260.00, now -$240.00)" with the difference as the amount, then the fee as its label with the amount negative. A negative amount prints "-$1,140.00". A date range prints "Aug 9–13, 2026", "Aug 29–Sep 3, 2026" or "Dec 30, 2026–Jan 2, 2027" after the description: "Revenue - Aug 9–13, 2026". Then "Total:", then the carried balance under its own label, then "Notes:" and the free text. Every page carries "# reference · Page n of m"; later pages repeat the header bar. The PDF's title is "Payment Summary <reference>".

### 19.3 The screens

The editor keeps its two columns. Left, in the document's order: **Report** (reference, date, Report For name and address — saved to the property record 800 ms after the last change, as the draft is); **Lines** (description, dates, quantity, rate, the amount computed, ↑ ↓, remove, Add line); **Recorded costs** (read-only lines with Open entry); **Management fee** (rate %, base prefilled from the revenue lines with "Use the revenue sum" — empty until typed since dispatch 26, §19.1 —, the computed amount shown, the amount editable with "overwritten" said when it differs and "Use the computed amount", the label prefilled "NuBNB 20% Net of $9,539.78" until the admin edits it); **Carried balance** (the suggestion as one button when there is one, or label and amount); **Notes**; Finish. The property form's block reads "Statements": Report For name and address, Owners, statements from and until, default fee rate. The tracker's figure column reads "Revenue share"; a report of version 3 is named by its reference ("# Aug-321-John") wherever a report is named, an earlier one by its six-character ref as before. "Co-owner" is gone from every label, placeholder, prompt, notice and API message a user can see.

### 19.4 My decisions, not rulings

The fee's base is editable and prefilled from the revenue lines (§19.1; no default since dispatch 26); the fee prints last in the table, after the typed lines and the recorded costs, where three of the six examples place it among the lines; a carried balance is offered only when the previous month closed below zero; the reference is offered from the previous month's with the month word swapped ("June-321-John" → "July-321-John"), else typed; a draft of version 1 or 2 that an admin continues is saved in version 3, its rows' `source` and `reference` kept on the lines and shown, not printed; a finished statement of version 1 or 2 is drawn by the 23D writer kept verbatim, so its preview is its stored bytes, and its read-only Report block is blank; the "Owners" list stays on the property form and the record; the default fee amount of 23B stays on the record, sent back as loaded, not shown; the katakana middle dot prints as the middle dot; a recorded cost of an earlier month prints "(from June 2026)" and an adjustment prints what it is, where it was reported and what it is now; finishing refuses a draft with no reference or no date (422 `STATEMENT_INCOMPLETE`).

### 19.5 Verification (2026-10-01, early morning)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4500, throwaway admin secret, no `.env.local` in the build copy; build `qLIYBYhOXaxkrxEDMRX4P`), through the real routes and in a real browser, with the six reports NuBNB sent read from Kian's Downloads. **Storage counted before the first write: 4,642 objects.** Opening export `backups/2026-10-01T05-13-01Z` (71 documents, 12 collections; no `property_management`, `monthly_reports` or `report_downloads` existed). Test properties, none with an entry, a draft or a record: Corner Penthouse l Tall Ceiling (`1VpX0wMpaUkbFwkULD8P`, as 321 John), Family Home in the Heart of Thornhill (`2uOz2IFFHZO6StZRBBTG`, as 19 Tannery), Private Basement Near Yonge St (`37L8ri0iao2pIjkeKcQR`, as 3289 Flemming). The Report For name carried the `__TEST__` mark; everything else was typed as printed.

- **The acceptance test: each of the six rebuilt from its own figures, through `PUT …/report-for`, `PUT …/draft` and `POST /api/admin/monthly-reports`, the stored PDF fetched through its 60-second link and read back with `pdftotext`, every text line of the original looked for in it and the reverse.** Every Total and every Your Revenue Share equal to the original's: June-321-John $1,974.59 / $1,974.59; July-321-John $4,650.61 / $4,650.61; Aug-321-John $8,232.17 / $8,232.17; June-19-Tannery $4,055.59 / −$359.96; July-19-Tannery $5,465.02 / $5,105.06; July-3289-Flemming $6,348.33 / $6,348.33. Every stored PDF byte-identical to the writer's output on the returned frozen object (26,257; 30,093; 31,111; 27,345; 28,063; 28,002 bytes), its SHA-256 equal to the record's. **Every difference found:** (1) the Report For name carries `__TEST__`; (2) the three 321 John originals print "Your Revenue Share :" with a space before the colon and June-19-Tannery "Debt Balance from May :", ours "…Share:" and "…May:" throughout; (3) the katakana middle dot in "Resolution Payout・Jul 28–29" prints as the middle dot "·" (three lines, July-321-John and July-3289-Flemming); (4) two long descriptions wrap at a different word than the originals ("Revenue - Resolution Adjustment・Jul 23–24, 2026 ($267.85-$213.0)" and "Revenue - July PTT Difference …"); (5) every page carries a foot "NuBNB Suites · www.nubnb.ca … # ref · Page n of m" and a later page the running head, which the originals lack; (6) **row order:** the fee prints last, where July-321-John places it before "Expense - Cleaning", Aug-321-John before "Revenue - July PTT Difference" and July-19-Tannery before "Expense - Costco" and the valve repair; every other row in the originals' order; (7) in July-321-John the fee's amount was typed over the computed one (see below), so its base is the revenue sum rather than the printed "Net of $5,471.31" — the label, typed, still reads as the original. Nothing else differs: the reference, the date, the company lines, the address lines, every row's description, quantity, rate and amount, Total, the balance lines and every Notes line are found verbatim. The same six through the pure writer alone (`tools/rebuild.mjs`, the exact names) differ from the originals only in (2)–(6).
- **Quantity × rate, negative lines:** the stored Aug-321-John cleaning line `quantity 19 × rateCents -6000 = amountCents -114000`, printed "Expense - Cleaning 19 -$60.00 -$1,140.00"; June-321-John `5 × -6000 = -30000`; July-19-Tannery `9 × -15000 = -135000`; July-3289-Flemming `7 × -20000 = -140000`. A line sent with an amount is refused by the schema, which computes it; a stored line whose amount is not quantity × rate is not read (pure check 35).
- **The fee computed from the rate, then overwritten, both stored:** July-321-John sent rate 15, base 7,523.70 (the revenue sum) and amount 820.70: stored `{ rateBasisPoints: 1500, baseCents: 752370, computedCents: 112856, amountCents: 82070, overwritten: true }`, frozen the same on the report, printed −$820.70. The other five sent the base as printed and no amount: `computedCents` equals `amountCents`, `overwritten: false` (Aug-321-John `2000` on `953978` → `190796`). The editor showed "fee-rate 20 · fee-base 7206.28 · fee-amount 1441.26 · computed from the rate" on July-19-Tannery, and "overwritten · computed $1,128.56 · Use it" is the editor's word for the other case.
- **The carried balance:** June-19-Tannery typed by hand: stored `{ label: "Debt Balance from May", amountCents: 441555, fromReportId: null }`, printed "Debt Balance from May: $4,415.55", the share −$359.96. July-19-Tannery saved without one; the editor then read "June 2026 closed at -$359.96. Carry it: Balance From June $359.96 · Type a balance"; the button pressed, "Draft · saved 1:19:45 a.m.", the stored draft at revision 2 with `{ label: "Balance From June", amountCents: 35996, fromReportId: "bbMjIwHQ8GLAAAMQwsAP" }` (June's report), frozen the same, printed "Balance From June: $359.96", the share $5,105.06. The 321 John months closed above zero and offered nothing.
- **Report For, both ways:** typed in the August editor of Private Basement ("…L9S 2Y9\nCanada"): `GET …/management` read the record with that address; the property form, opened from the admin list with Edit, showed "Report For name=__TEST__ Essy Adloo address=…Canada · Default fee rate= · labels: Report For | Address | Statements from | until (optional) | Default fee rate (%)". The address changed there to "3289 Flemming Blvd, Unit 2…" and Save Property pressed: the record read back with it, and the editor reloaded with it. The property document was not written: its `updateTime` is 2026-09-21T05:03:04Z and its 31 fields equal the opening export's.
- **A statement written before this still displays and prints:** a report written exactly as dispatch 23D wrote it (`schemaVersion 2`, income rows with `source`/`reference`/stay, a fee that is an amount, `ownersAtFinish`), its PDF from the legacy writer (4,150 bytes, sha256 `533a4317…`), stored for Corner Penthouse, May 2026. The editor opened it read-only ("Finished … · ref p1NFFV", the rows as lines "__TEST__ Airbnb payout, stay 2–6 May 1 × 980.00", the fee "120.00" with no rate, Download PDF, Correct this statement…), and the live preview's blob hashed in the page to **4,150 bytes, sha256 `533a4317…`: the stored bytes.** The property page and tracker name it "ref p1NFFV". A draft written as dispatch 23B wrote it (`schemaVersion 1`, three rows) for Family Home, May 2026, opened as three lines with "Airbnb · ref HMTEST01 · recorded before || Private · recorded before || Other · ref DEP-7 · recorded before", its fee "100.00" with no rate; a note typed there saved it: the stored document is `schemaVersion 3`, revision 2, no `income` field, `lines` carrying `source` and `reference` exactly as the rows had them, the fee `{ rateBasisPoints: null, baseCents: 0, computedCents: null, amountCents: 10000, overwritten: true }`. **Kian's own October draft** (`VAVoKTjCpg5YDS22eSw6_2026-10`, version 2) opened as "bye 1 × 10.00 · Airbnb · recorded before", "hi 1 × 20.00", nothing typed, its `updateTime` still 2026-10-01T03:16:47Z.
- **A recorded cost as a line:** an office cost (`__TEST__ Furnace filter, Home Depot`, $42.50 + $5.53 tax) added for Private Basement; October's editor listed it under Recorded costs as "Expense - __TEST__ Furnace filter, Home Depot | 1 | -$48.03 | -$48.03 | Open entry" with no input in the block; one revenue line typed (500.00); Finish refused with "Give the report a reference, like Aug-321-John" until "Oct-3289-Flemming" was typed; then the confirm "Finish and issue # Oct-3289-Flemming … Your Revenue Share: $451.97" accepted, "✓ Stored PDF verified: SHA-256 matches"; the frozen report `costs [[8eTA4LbTlRopATn4vDc8, office, …, 4803, month]]`, `recordedCents 4803`, `payableCents 45197`; the stored PDF (25,084 bytes, equal to the writer) read "Revenue 1 $500.00 $500.00 / Expense - __TEST__ Furnace filter, Home Depot 1 -$48.03 -$48.03 / Total: $451.97". The August editor of the same property, a new month, opened with the reference "Aug-3289-Flemming" and the rate 15 offered from July's statement.
- **The screens:** the tracker for July 2026 read "3 of 3 statements finished · 0 outstanding · 0 drafts in progress" with the column "Revenue share" and each row "Finished … · # July-321-John / # July-19-Tannery / # July-3289-Flemming" and its four figures; the property page's Statement block "ALL STATEMENTS · July 2026 # July-19-Tannery · $5,105.06 · June 2026 # June-19-Tannery · -$359.96". The editor's head after finishing showed the live rebuild's figure rather than the frozen statement's ($500.00 for $451.97) and now shows the frozen one; the final build carries that fix and a tighter line grid.
- **Pure** (`pure/check-23e.mjs`, 71 checks, 0 failed): the six fee computations and rounding half up; the range and date words; the readers for every version and their refusals; the printed lines' order and words; the sums; the suggestions; `buildStatement` with a cost row and an adjustment carrying its description and printed month; the writer deterministic, the draft line, no Report For, nothing to report, pagination with the header bar repeated and the Total on the last page; one image XObject; **the legacy writer byte for byte the 23D writer** on a legacy statement (the transpiled module of session f8cb36d9 against this tree's); **the ledger PDF byte for byte before and after the core's image support.** `tsc` and `eslint` clean on every changed file.
- **Cleanup** by exact ID and path: 28 documents (three records, nine drafts, eight reports, seven downloads, one entry) and eight statement PDFs, each confirmed gone, none refused; no `__TEST__` in any collection touched; `monthly-reports/` empty; Kian's two October drafts untouched. Closing export `backups/2026-10-01T05-29-02Z`: all 12 files byte-identical to the opening one, 71 documents. **Storage 4,642 before the first write and after cleanup.** The final build (`-tvuQSAb_MCd5Eq3S-0K6`, then rebuilt with the read-only dates) was checked on 4500 with the throwaway secret: the head of a finished statement reads the frozen figure, a legacy statement's Report block is blank.

**Not exercised:** the production admin panel; inline PDF rendering by a browser with a viewer (this headless Chromium has none; the preview's bytes were hashed instead); a correction of a version-3 statement through the browser (the correct flow is 23B's and its draft now copies lines, fee and balance); a statement with an earlier-month entry or an adjustment through the routes (both covered by the pure checks and the writer); `STATEMENT_INCOMPLETE` from the route itself (the page refuses first).

## 20. The property page as the one place of work; the Reports section gone; the statements panel on the home (dispatch 23F, 2026-10-01)

Kian's rulings of 2026-10-01 (dispatch 23F), built on `b546044` (dispatches 23D and 23E, committed): a property's page holds everything about it, bound to a month the admin picks — back for past months, forward to the current one — with four tabs on the left (Costs: log a cost and the month's approved entries; Income: the month's lines; Details: Report For, the fee and its rate, the carried balance, notes; Finish: finish the statement and download this month's PDF and any earlier version) and the statement preview on the right, always visible on every tab; before anything is created the preview shows what the statement would be (the approved costs already recorded, nothing typed, the totals), there is no Create button, and a draft is created when the admin first types something, saving itself as before; the Reports section leaves the header and its cross-property view becomes a panel on the admin home opened from the Statements tile, one row per property with its status for the month (finished, draft, outstanding, and past due for closed months), each row a link into that property's page for that month, the tracker's data unchanged; the layout must hold at desktop width. Nothing in `CLAUDE.md` is changed.

### 20.1 What was built

- **`/admin/property?id=&month=`** (`app/admin/property/page.tsx`, `CostsTab.tsx`, `IncomeTab.tsx`, `DetailsTab.tsx`, `FinishTab.tsx`, `statement-form.ts`, `AddCostForm.tsx` moved from the costs folder, `page.module.css`): the head — the property's name, ◀ a month control ▶ whose entries read "October 2026 · open, not yet due", "September 2026 · past due", "October 2026 · finished · # Oct-321-John", the state once as a badge, and "Past due: August 2026, September 2026" as links when closed months in scope have no finished statement; the tabs; the preview (the editor's two swapped frames). Two reads on opening: every cost entry with the recorded cost PDFs (`GET /api/admin/cost-entries`) and the property's statements (`GET /api/admin/properties/[id]/statements`); every month is worked out from those two answers in the browser, so moving between months costs no call. Each month's typed state lives in its own mounted component (keyed by month), and a save still pending when the admin moves on is sent as it leaves. The address bar carries `?id=&month=&tab=&entry=`.
- **Costs**: one line (n approved entries · total · tax) with the month's Excel and PDF beside it (the dispatch-21 ruling: a property's costs with both exports, here for the month; the PDF recorded before download as before) and **Log a cost**; a warning when entries sent in the month are pending; the entries newest first — sent, logged by, what, total, "✎" when corrected, "changed since PDF" beside the newest cost PDF for its day, and "statement says $X" once the month's statement is finished and the entry no longer adds up to what it printed; under them "Also in this statement": earlier-month entries and adjustments as the statement prints them. A click opens the entry in place — the costs page's pane with its receipt, lines, corrections and history — with "← October 2026's costs" to return; a correction there redraws the preview. "Ledger: all dates, Excel and PDF" links to `/admin/costs?property=&status=approved`.
- **Income**: the editor's lines block (description, dates, quantity, rate, the computed amount, ↑ ↓, remove, Add line). **Details**: Report For (name and address side by side, saved to the property record 800 ms after the last change), the management fee (rate, base, amount, label), the carried balance, notes. **Finish**: the reference and the date; the state line ("Nothing saved yet" / "Draft · saved …" / "Finished … · # ref"); Finish and issue… with the revenue share beside it; once finished, Download PDF, Correct this statement…, the SHA-256 line; and "Earlier versions" with a PDF button each when a statement of the month was replaced. The one line about an open month ("October 2026 has not ended. Entries approved after finishing go into November 2026's statement.") sits under the button.
- **The home** (`components/DashboardStats.tsx`, `components/StatementsPanel.tsx` + its CSS): the Statements tile is a button; clicking it opens the panel under the tiles at the last closed month, with ◀ month ▶, the line ("1 of 46 statements finished · 42 open, not yet due · 3 drafts in progress", "1 past due" in the alert tone), the table (property · statement · income · costs · fee · revenue share · exported · PDF), the replaced rows and the loose ends, from the same one read and the same pure functions as the tracker (`trackerRows`, `trackerCounts`, `looseEnds`). Each row's name is a link to `/admin/property?id=&month=`, and a click anywhere on the row goes there. The panel's month is kept in the address bar (`?statements=2026-09`) so a reload keeps it open; the tile keeps the last closed month's figures whatever the panel shows, and now reads "Statements past due, September 2026".
- **Removed**: `app/admin/reports/` (the tracker page and the statement editor), `app/admin/costs/PropertyPanel.tsx`, the Reports pill in `AdminHeader`, the property panel and the add-cost head on the costs page's ledger view (which keeps the queue, the ledger for any dates, its exports and the pane, and gains a "Property page" link in its head). `GET /api/admin/monthly-reports/draft` is no longer called by any page and is left in place. Every link that pointed at the editor or the tracker now points at the property page on the month (the entry pane's "Open October 2026's statement", the admin list's rows and their "Open" control, the Statements tile).
- **`reports/statement.ts`**: `STATEMENT_STATE_LABELS.outstanding` reads **"Past due"**; `propertyMonthState` (one property-month's state and reports, the same reading the tracker makes). The shared admin CSS gains the state badges (`stateBadge`, `stateOutstanding` …) and the button tile.

### 20.2 My decisions, not rulings

- **"Past due" is the word for the tracker's `outstanding` state** — a closed month in scope with nothing finished and nothing started — on the panel, the property page and the tile. I read the ruling's "finished, draft, outstanding, and past due for closed months" with "outstanding" as the category (dispatch 23D's definition: a closed month with no finished statement) and "past due" as its label; the current month keeps dispatch 23D's "Open, not yet due". One word to change if Kian wants "Outstanding" back.
- **The reference and the date are on the Finish tab**, not Details: they name and date the issue, the Finish button needs both, and Details already holds four blocks. The month's Excel and PDF are on the Costs tab, for the month, so the dispatch-21 ruling (a property's costs with both exports, without further clicks) still holds; the ledger keeps any other date range.
- **A property's page defaults to the current month**, as the 23D panel did; the ◀ button goes back without limit, the ▶ button stops at the current month; a month before the property's statements began reads "no statement expected" and carries a quiet badge.
- **The entry pane opens in place on the Costs tab** rather than a third column: the page has no room for one beside the preview, and the preview redrawing as a cost is corrected is the point of the one page. The entry's "Property and statement" links land on the property page.
- **Logging a cost does not open the entry** (the 23D ledger did): the list and the preview change, and the notice says what was logged.
- **Nothing is saved until the admin types** in a line, the fee, the balance, the notes, the reference or the date; the preview's suggestions (the reference from the previous month, the fee rate from the previous statement or the record) are shown, not stored. Typing Report For saves the property record, not a draft.
- **The panel's rows carry only Download PDF** as an action; Open / Continue / Start are gone because the row itself is the way in. **The panel refreshes from its own button**; the home has no other refresh.
- **The property page reads every cost entry** (the costs page's read) rather than a per-property route, so the cost-PDF marks and the cleaner patterns the pane shows need no second shape; the statements read is the 23D one.

### 20.3 Verification (2026-10-01, early morning)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4651, throwaway admin secret, no `.env.local` in the build copy; builds `-L2L0IsQ_OtRj5cEkSxTa`, then `Mu4FliQ79a13YSbumeLXo` after the line-row fix below), through the real routes and in a real browser. Kian's browser held two connections to port 4500 throughout, so the throwaway server ran on 4651 and 4500 was swapped to the final build only at the end. **Storage counted before the first write: 4,642 objects.** Opening export `backups/2026-10-01T06-33-54Z` (73 documents, 12 collections; `monthly_report_drafts` held Kian's three October drafts, one saved at 06:21 Z that night, and `cost_entries` an office cost he removed at 06:22 Z). Test property: Corner Penthouse l Tall Ceiling (`1VpX0wMpaUkbFwkULD8P`), no entry, draft, report or record before; its `__TEST__` management record put statements from August 2026 at a 20 % default rate so a closed month in scope existed. Raw outputs in the scratchpad `out/` (00–21), screenshots in `shots/`, tooling in `tools/`, `run/` and `js/` (session 0441455b; a reboot wipes it).

- **Pure** (`pure/check-23f.mjs`, 15 checks, 0 failed): the state words ("Past due", "Open, not yet due"); `propertyMonthState` for a closed month with nothing, the current month, a future month, a draft, a finished draft, a replaced statement (newest first, `replacedBy` set), a correction in progress, another property's report; the tracker on the last closed month (September 2026 for today 2026-10-01) with a property in scope and nothing → `outstanding`, its counts; a property's months with August and September past due and October open, newest first.
- **Each tab, with the preview visible and updating from every one.** On arrival (`/admin/property?id=…`, October 2026, nothing stored): the four tabs Costs · Income · Details · Finish; the badge "Open, not yet due"; the header Properties · Leads · Costs · Team · Availability; the preview 598 × 790 px on the right at 1,440 px, drawn 300 ms later into the hidden frame and swapped (24,388 bytes, sha256 `517de7f5…`); after the record (fee rate 20 %) 24,562 bytes `5f7221c2…`. Costs: "Log a cost" (`__TEST__ Furnace filter, Home Depot`, 42.50, tax 5.53) → "Logged $48.03, approved.", the row "1 Oct 2026 · Nubnb office · Added by the office · $48.03", the line "1 approved entry · $48.03 · tax $5.53", the preview 24,837 bytes `b3ffa5b1…` reading "Expense - __TEST__ Furnace filter, Home Depot 1 -$48.03 -$48.03 / NuBNB 20% Net of $0.00 1 $0.00 $0.00 / Total: -$48.03", and **no draft created** (`drafts 0`). Clicking the row opened the pane in place (`?entry=`), its "Property and statement" links `/admin/property?id=…` and `…&month=2026-10`; "Correct line 1" to 40.00 → the stored entry `[["__TEST__ Furnace filter, Home Depot",1,4000]] tax 553 total 4553 corrected true history 3`, the list "✎ $45.53", the preview "Expense … -$45.53 / Total: -$45.53". The month's cost PDF: recorded (`cost_report_exports/rUY8FV7qn6qHlbHUQhBJ`) then downloaded, 3,209 bytes, "Office: __TEST__ Furnace filter, Home Depot · zAeYEg · $40.00 · $5.53 · $45.53 *". Income: "Add line", rate 500.00, description `__TEST__ Revenue - Airbnb` → **the draft created**: `1VpX0wMpaUkbFwkULD8P_2026-10` v3 rev 1, `lines [["__TEST__ Revenue - Airbnb",1,50000,50000]]`, `fee { label "NuBNB 20% Net of $500.00", rateBasisPoints 2000, baseCents 50000, computedCents 10000, amountCents 10000, overwritten false }`; the preview 25,098 bytes `d83b8957…` reading "__TEST__ Revenue - Airbnb 1 $500.00 $500.00 / Expense … -$45.53 / NuBNB 20% Net of $500.00 1 -$100.00 -$100.00 / Total: $354.47"; the Finish tab "Draft · saved Oct 1, 2026, 2:44:46 a.m.". Details: Report For `__TEST__ Owner Name` with a two-line address → `property_management.reportFor` set at 06:45:29 Z; the fee fields `rate 20 · base 500.00 · amount 100.00 · computed from the rate`; notes → the draft at rev 2 with `notes "__TEST__ Thank you for your business."`; the preview 25,458 bytes `7a7e23b9…` with "Report For: / __TEST__ Owner Name / 1 Test Street, Unit 2 / Toronto, ON [postal code removed]" and "Notes: / __TEST__ Thank you for your business.". Finish: the reference `Oct-__TEST__-Corner` saved (rev 3's predecessor), the confirm "Finish and issue # Oct-__TEST__-Corner for Corner Penthouse l Tall Ceiling, October 2026? Your Revenue Share: $354.47. …" accepted; "Finished Oct 1, 2026, 2:45:45 a.m. · # Oct-__TEST__-Corner", "✓ Stored PDF verified: SHA-256 matches", Download PDF and Correct this statement… offered, the reference field disabled; the badge "Finished", the month entry "October 2026 · finished · # Oct-__TEST__-Corner"; the report `OA7X0MgVEv5PmCyc4fDR` (`costs [[zAeYEgCaKzV7bVx58ACG, …, 4553, month]]`, income 50000, recorded 4553, fee 10000, total 35447, payable 35447, `pdf { monthly-reports/OA7X0MgVEv5PmCyc4fDR.pdf, 25444, 08c83de7… }`), the draft `finishedAs` set at rev 3. **The frozen preview: 25,444 bytes, sha256 `08c83de7…`, the stored object's.** Download PDF opened `https://storage.googleapis.com/…/monthly-reports/OA7X0MgVEv5…`; fetched in node: HTTP 200, 25,444 bytes, the same sha256; the record `report_downloads/azPOL4AoEej5K0jkH8Dh`.
- **Back a month and forward, with the costs, income and statement following.** ◀ September 2026: "September 2026 · past due", the badge "Past due", "Past due: August 2026, September 2026" beside it, "No approved costs in September 2026.", no lines, the Finish tab "Nothing saved yet", the preview 24,794 bytes `f90379ba…` ("Your Revenue Share: $0.00", the Report For block, no rows). ◀ August 2026: "past due". ▶ ▶ October: "Finished", the furnace filter row, the preview `08c83de7…` again, the ▶ button disabled at the current month. Moving months made no draft: still the one.
- **The home panel.** The tile "1 · Statements past due, September 2026 · 0 of 1 finished"; clicked, the panel opened at September 2026 (`?statements=2026-09`): "0 of 1 statements finished · 1 past due", one row "Corner Penthouse l Tall Ceiling · Past due" with href `/admin/property?id=1VpX0wMpaUkbFwkULD8P&month=2026-09`; the tracker's counts in node by the same pure function `{ inScope 1, finished 0, outstanding 1, open 0, drafts 0 }`. ▶ October: "1 of 46 statements finished · 42 open, not yet due · 3 drafts in progress" (`{ inScope 46, finished 1, outstanding 0, open 42, drafts 3 }`); 46 rows, Kian's three drafts "Draft · saved …", the test property "Finished · Oct 1, 2026, 2:45 a.m. · # Oct-__TEST__-Corner · $500.00 · $45.53 · $100.00 · $354.47 · downloaded once, last …"; **every row's href `/admin/property?id=<its id>&month=2026-10`, every name and badge the tracker's, the same ids in the same order** (`tools/compare-panel.mjs`, both months). A reload kept the panel open on October; the test property's row landed on its page at October, "Finished".
- **Nothing reachable only from the removed Reports section.** `/admin/reports` and `/admin/reports/edit?…` answer 404; no client chunk in `.next/static` mentions `admin/reports`; the only mention in `app/` is the comment in `property/page.tsx`; the header lists five sections. The admin list's row (its name, its "Open" control and a click on the row) → `/admin/property?id=…`; the ledger's head "Costs ledger · approved entries · Review queue · Property page" → the property page, with the income panel and the add-cost button gone from it; the entry pane in the queue → "Open Corner Penthouse l Tall Ceiling's page" and "Open the statement" (`…&month=2026-10`).
- **The layout at 1,280 × 800** (every tab): no horizontal overflow (`scrollWidth 1280`); the tabs and the form at x 40–692, the preview at x 712–1,240 (528 px wide, 690 tall), all within the viewport. The Details tab's body was 675 px tall, its last block (Notes) below the fold at 800 px height; **on Kian's instruction (2026-10-01) Report For's name and address sit side by side**, and the body measured 488 px after the rebuild (build `I_Vo-Zokhcx8F4nrYlEin`), its four blocks ending at y 346, 443, 540 and 695 of 800: the tab fits without scrolling. **Found and fixed:** the line row at widths below 1,300 px put the rate box under the ↑ ↓ buttons and the amount in the description's column (the editor's responsive rule, inherited, placed seven items in six columns); it is now two named rows — description, quantity, rate, amount, remove; the dates under the description — measured after the rebuild at description x 95–383, quantity 391, rate 449, amount 545, remove 641, the dates at y 304 across the width.
- **Cleanup** by exact ID and path, each confirmed gone: `property_management/1VpX0wMpaUkbFwkULD8P`, `cost_entries/zAeYEgCaKzV7bVx58ACG`, `cost_report_exports/rUY8FV7qn6qHlbHUQhBJ`, `monthly_report_drafts/1VpX0wMpaUkbFwkULD8P_2026-10`, `report_downloads/azPOL4AoEej5K0jkH8Dh`, `monthly_reports/OA7X0MgVEv5PmCyc4fDR`, the object `monthly-reports/OA7X0MgVEv5PmCyc4fDR.pdf`; no `__TEST__` in any collection; `monthly_reports`, `report_downloads`, `property_management` empty, `monthly-reports/` empty. Closing export `backups/2026-10-01T06-51-22Z`: **all 12 files byte-identical to the opening one, 73 documents** (Kian wrote nothing in the window). **Storage 4,642 before the first write and after cleanup.** `tsc` and `eslint` clean on every changed file.

**Not exercised:** the production admin panel; inline PDF rendering by a browser with a viewer (this headless Chromium has none; the preview's bytes were hashed in the page); a correction through the property page (the flow is the editor's, lifted; the pure checks cover the state); the month select's own list (the ◀ ▶ buttons were used); the Excel export from the Costs tab (the PDF was); `DRAFT_CHANGED` from a second tab (23B's server check); a month with earlier-month entries or adjustments on the Costs tab's "Also in this statement" group (covered by `printedLines`' pure checks of 23E).

### 20.4 The polish pass (2026-10-01, after the commit)

On Kian's note that the layout is right but the spacing, the preview's frame and the sizing wanted perfecting, across every tab: the preview is a card in a Letter page's proportions (`aspect-ratio: 8.5 / 11`, at most the window's height), so the page fills it with no band under it, with a soft shadow; the month select's trigger fills its box (the box was wider than the pill, which left a gap before ▶) and the ◀ ▶ buttons are the select's 40 px; every button on the page is 36 px tall with a 10 px radius (small ones 30 px), every input 36 px with the same radius; the log-a-cost form draws from the page's own styles; the Costs tab's empty state is the one line, and its Excel · PDF · Log a cost sit on one height; the prose under the preview and the "never edited" sentence beside Finish are gone (the confirm says it); the open entry's card is the blocks' 14 px. Measured on the rebuilt copy at 1,700 × 1,000 and 1,440 × 900 on every tab, with no horizontal overflow: the preview 598 × 774 (ratio 1.294, Letter's), the select 250 px wide and its trigger the same, 6 px to ▶, the arrows 40 px, the three buttons 36 px. Uncommitted; 4500 serves it.

On Kian's request the same morning ("bring the date picker for the month on top of the tab picker"): ◀ the month control ▶, the state badge and the "Past due" links leave the head, which keeps only the property's name, and sit in the left column directly over the tabs, with the preview's top level with them. The bar stays the page's, outside `MonthWork`, which is remounted with each month, so ◀ ▶ keep keyboard focus while stepping through months; the page's grid holds the bar (column 1, row 1), and `MonthWork`'s box is dropped (`display: contents`) so its tabs column (row 2) and preview (column 2, both rows) sit in the same grid. The second row is `1fr`, so a preview taller than the left column grows that row, never the bar's. A long "Past due" line wraps under the control, and the badge stays beside ▶. Measured at 1,440 × 950 and 1,700 × 1,000 on every tab: the bar 14 px over the tabs, the preview's top level with the bar and its bottom inside the window, no horizontal overflow; at 1,100 and 1,000 px wide, one column, with the preview under the tabs as before. The "Past due" line was seen only with a statement start month stubbed in the browser, since no property has a past-due month; nothing was written.

### 20.5 The tab order and the release status (2026-10-01, late morning)

Kian's request: "reorder the tabs; first it should be Income, then costs, then details, and finally finish; the finish should also have the status of the past 4 months and next two months report release statuses so that the admins can keep track of what reports have they completed as part of the finish tab."

- **The tabs** read Income · Costs · Details · Finish.
- **Release status**, the last block on the Finish tab: one row a month, the month, its badge and, for a finished statement, its reference and when it was finished, or for a draft, when it was saved. A month that has begun is a link that opens it on the Finish tab; the page's month is shaded. The states are the month control's: Finished, Draft (or Correction in progress), Past due, Open, not yet due, No statement expected, and Upcoming for a month after the current one. Worked out in the browser from the two reads the page already makes (`propertyMonthState`, `inStatementScope`, `propertyMonths().outstanding`); no new call.

**My decisions, not rulings:** the seven months are counted from the current month, not the month the page shows, so the list stays the same while the admin moves between months: four before it, it, and two after (June to December 2026 today); Income, now first, is also the tab a property opens on, and the address bar leaves out `tab=income` instead of `tab=costs`; the costs ledger's "Property page" link adds `&tab=costs`, so it still lands on Costs; a month after the current one reads "Upcoming", since "Open, not yet due" would say it had begun; a draft in an ended month in scope adds "· past due" in the alert tone, matching the bar's "Past due" list, which counts a draft as not released.

**Verified** against a local build of this tree reading production data, with a throwaway PIN, at 1,440 × 950 and 1,000 × 900, with no horizontal overflow: a property opened with no tab lands on Income with the four tabs in the new order; on Finish the list reads June to September "No statement expected", October "Draft · saved Oct 1, 2026, 10:48 a.m.", November and December "Upcoming", with production data as it is; clicking August opened August on the Finish tab; the ledger's link reads `/admin/property?id=…&tab=costs`. Every other state was seen only with the statements read stubbed in the browser (a statement start month of May, a finished June statement, a September draft): Finished with "# Jun-Ajax · finished Jul 3, 2026, 11:12 a.m.", Past due for July and August, "saved Sep 29, 2026, 3:05 p.m. · past due" for September. Nothing was written: afterwards the property still has no statement record, no statement, and its October draft at revision 3, saved 14:48:01 UTC.

### 20.6 The dates of an income line over the quantity (2026-10-01, midday)

Kian's report, with a screenshot of his September draft: the dates field of an income line ("Sep 7 – Sep 17, 2026") ran over the quantity field, and should never do so again. The cause: `DateRangeField`'s trigger never wraps and had no width limit, so it took its text's width (127 px) plus 74 px of border, padding, calendar icon and chevron, 201 px in all, while the line gave its column 172 px. It was also 40 px tall beside 36 px inputs.

- **The field keeps to its box, wherever it is used** (`components/DateRangeField.module.css`, `.tsx`): the root is at most its container's width and may shrink, the trigger fills the root, and a range longer than the room it is given ends in an ellipsis, with the whole range as the trigger's `title` (it was already in its label). Where the field sits at its own width (the costs filter, Availability), it measures what it did: text plus 74 px, 40 px tall, nothing cut.
- **The income line is sized from what it holds, and from its block, not the window** (`property/page.module.css`, `IncomeTab.tsx`): the dates column is 212 px, the widest range within one year (138 px of Manrope 13 px) plus the 74 px; 250 px when the block is at least 860 px wide, enough for the widest range across a new year (176 px). The line is one row while the block leaves the description 140 px, two rows below that (dates under the description, at their own width). Both switches are container queries on the Lines block, replacing the viewport `@media (max-width: 1300px)`, so the preview, the window or a layout change around the tab cannot narrow the column under its contents. The dates are 36 px tall with a 10 px radius, as the inputs beside them.

**Accepted:** at 1,440 px the description is 158 px wide (it was 198 px while the dates spilled), and a range across a new year ends in an ellipsis there ("Dec 28, 2026 – May 2…", whole on hover); it shows whole in the two-row layout and in a wide block.

**Verified** on a local build of this tree reading production data, with a throwaway PIN: Kian's September line at 1,440 × 950, the dates 212 × 36 and 8 px clear of the quantity; then five lines stubbed in the browser (Sep 7 – Sep 17, May 28 – May 28, Dec 28, 2026 – May 28, 2027, From Sep 17, no dates) at 1,700, 1,440, 1,300, 1,100 and 1,000 px wide: no overlap and no horizontal overflow at any width; one row with the header at 1,440 and 1,700 (block 704 px), two rows at 1,300 (block 625 px), one row with 250 px dates at 1,100 and 1,000 (one column, block 982 and 914 px), where the cross-year range is whole. Nothing was written: the September draft (Kian's) stayed at revision 2 and October's at revision 3.

### 20.7 The preview drawn by PDF.js (2026-10-01, afternoon)

Kian's note, with a screenshot of the preview in Chrome: the edges of the preview document were not clean. The preview was the browser's own PDF viewer in an iframe (`#toolbar=0&navpanes=0&view=FitH`), which paints its background, margins, page shadow and scrollbar round the page: dark bands of uneven width inside the rounded card, and no way to remove them that holds across browsers or Chrome versions.

- **`property/PdfPages.tsx`** draws the statement's pages with PDF.js (`pdfjs-dist`, pinned at 5.5.207: releases from 5.6.83 up to 6.2.108 carry GHSA-hq66-cqwq-w95j, arbitrary JavaScript on opening a malicious PDF, and 6.2.108 and later need Node 22, while this machine builds on 20.19; `npm audit` lists nothing for 5.5.207) from the same bytes as before (`statementPdf`), so the preview is still what Finish stores. Each page is a canvas exactly the card's width, at the screen's pixel density (drawn again when the card's width or the density changes), with the page's own proportions; a statement of several pages scrolls inside the card, the pages 8 px apart. The new drawing replaces the old pages only once every page is drawn, so the card is never blank while typing. If PDF.js cannot draw, the card says so with a button that opens the PDF in a tab.
- **PDF.js is loaded on demand**, the first time a property page draws a preview, and its worker code runs on the page's thread (`globalThis.pdfjsWorker`): a statement is one or two pages, so no worker file is served from a URL of its own. The browser chunks are about 400 KB and 1,140 KB before compression. The server build carries the PDF.js chunks in the property page's function (never run there: the import sits in an effect) but not its optional native canvas package, which PDF.js only requires under Node.
- **The card** has no border and no padding: the white page is its edge, cut by the 14 px corners. The preview column is a whole multiple of 17 px (`round(down, 44%, 17px)`, 408 px at least) so the Letter-shaped card is whole pixels both ways (595 × 770 at 1,440 px); the property's title has a 28 px line (it was 1.25 × 22 = 27.5 px), so the card's top is a whole pixel too. "This browser does not show PDFs inline" and the two swapped iframes are gone: every browser draws the preview, headless ones included.

**Verified** on a local build of this tree reading production data, with a throwaway PIN, at 2× density, with 5.5.207: Kian's September statement drawn as one 1,190 × 1,540 px canvas covering the 595 × 770 card at (805, 141) at 1,440 px exactly, no scroll (first measured on 5.6.205 before the column change: 598.39 × 774.38, the page's rectangle the card's to the hundredth of a pixel, the pixels white to the right and bottom edge); the card and whole pixels at 1,700, 1,300, 1,250 and 1,150 px, its right edge 40 px from the window's as before, no horizontal overflow; 46 stubbed lines drawn as two pages of 770 px, 8 px apart, scrolling inside the card. The console showed no error. Nothing was written: the September draft (Kian's) stayed at revision 2 and October's at revision 3.

### 20.8 Spacing and alignment across the tabs; a cost named by its day (2026-10-01, afternoon)

Kian's notes, with screenshots of the Income and Costs tabs: "columns and inputs are too tight and not perfectly aligned, also make sure some columns are not taking too much space, for example data range selectors are taking too much space in column width"; then, of the Costs tab's What column: "it should not be a list of items, just the date that the cost was submitted is enough as the WHAT (description) no need for a full breakdown".

- **Income lines.** One grid for the head and the lines, 12 px apart (it was 8): order 20 px, the description what is left (355 px of the 707 px block at 1,440 px; it was 158), quantity 56, rate 96, amount 92, remove 28. The dates are no longer a column (it was 212 px): they sit under the description as a smaller field (30 px high, transparent, its icon under the description's text) exactly as wide as its range, so a range across a new year shows whole; an empty one reads "Add dates". Every head label stands over the text of its field (12 px in from the field's edge: 1 px border and 11 px padding), right-aligned labels over right-aligned numbers, "Add line" under the description field. Below a 492 px block the description takes a row of its own (container query). `DateRangeField` gains size tokens (`--ctl-pad-l`, `--ctl-pad-r`, `--ctl-gap`, `--ctl-font`), defaults unchanged.
- **Costs.** The table is Submitted · Logged by · Total: an entry is named by the day it was submitted, and what was bought is in the entry it opens (Kian's ruling). The day and the total keep to one line and to their own width; the table keeps to the block's content edges, so the day stands under the summary line and the total under the buttons' right edge; a row's hover underlines the day. **The statement itself is unchanged**: its recorded cost lines still print "Expense - " and the items (`statement.ts`, `whatWasBoughtText`), and the Excel export still lists them; whether the PDF line should also be named by its day is Kian's to say.
- **Details.** The fee's rate, base and amount are 96, 180 and 180 px (the base and amount were half the block each); the carried balance's amount 180 px.
- **Finish.** The release status is one grid whose rows share its columns (subgrid): each column is as wide as its widest entry, and a month's details stand in one column.

**Verified** on a local build of this tree reading production data, with a throwaway PIN, at 1,440 × 950 and 2× density: on Kian's September statement, every head label against its field's text 0 px off (description left, quantity, rate and amount right), the dates' icon 0 px from the description's text, "Add line" 0 px from the description field, 12 px between fields; on Costs, the summary, the head and the first cell 0 px apart on the left, the Total head, the total and the buttons' right edge 0 px apart, the table's edges on the content edges, one line per header; five stubbed ranges (Sep 7 – Sep 17, 2026 at 189 px up to Dec 28, 2026 – May 28, 2027 at 236 px, "Add dates" at 126 px) whole and clear of every field at 1,440 and 560 px wide, no horizontal overflow. Nothing was written by the checks: October's draft stayed at revision 3; September's went from revision 2 to 5 at 1:02 p.m., Kian's own edits (the 600.00 rate and the 20 % fee in his screenshot), before this round began.

### 20.9 The Team page: two columns gone, a dialog to add someone (2026-10-01, evening)

Kian's notes, with a screenshot of the Team table: "Created and status changed at column does not need to be on the table", then "the UI UX of creating a new team member is not good, it looks like a search bar and not a serious thing."

- **Table.** Name · Role · Code · Status · Last 90 days · ID · Actions. Created and Status changed are gone from the table; both fields are still stored and still in the API's rows. With the room back, names and IDs keep to one line at 1,700 px.
- **Adding someone** is a primary **Add team member** in the header, as Add Property is on Properties, shown only once the list has loaded (a failed read still offers no create). It opens a dialog, **New team member**: the role as two cards (Cleaner, "Logs receipts"; Handyman, "Logs work and its price"), which replace the line of prose under the old row; then Name; then Cancel and **Create cleaner** / **Create handyman**. A refusal stays in the dialog with the name kept; a create closes it and the page's notice gives the code, as before; an unknown outcome closes it and leaves the "may have been created" warning, as before. Escape and Cancel close it, and it opens empty, on Cleaner, every time. The call and its handling are unchanged (`createCleaner`). My decisions: the dialog over an inline panel, the cards' wording, and no "Created" anywhere on the page.

**Verified** on a local build of this tree reading production data, with a throwaway PIN, at 1,700 × 1,000 and 2×: the head reads the seven columns; the dialog opens with the cursor in Name, Cleaner chosen and the button disabled; clicking the Handyman card, or Shift+Tab then →, chooses it and the button reads "Create handyman"; with `fetch` stubbed for the POST only, a 422 left the dialog open with "Jordan P" and Handyman kept and the refusal inside it; a network failure closed it and showed "The cleaner may have been created … 'Sam T'"; a 201 closed it and showed "Created Riley K as a cleaner." Each POST body was `{name, role}` as chosen. Nothing was written to production.

### 20.10 The Leads search icon below its field (2026-10-01, evening)

Kian's screenshot: the magnifier sat about 120 px under the Leads search field. Cause: 98027f8 made the shared `.toolbar` a column of `.toolbarRow`s; Properties and Availability were given rows, Leads kept its search and filters straight in `.toolbar`, so the wrapper's `flex: 1 1 280px` became a 280 px height and the icon, centred on the wrapper, fell to 140 px. Fix: Leads' search and filters in one `toolbarRow`, as on the other pages; no CSS changed. **Verified** at 1,700 and 600 px wide on a local build: wrapper 40 px tall, icon centre 0 px from the field's centre; with the old structure rebuilt in the page, wrapper 280 px and icon 120 px off, which matches the screenshot. Properties and Availability measured the same, 0 px off.

### 20.11 The property list's columns (2026-10-02, night)

Kian's note, with a screenshot of Location · Type · Beds · Price / Night · Actions on `/admin`: "Column alignment of these couple columns … should get perfected on the spacing."

- **What was off.** The table spread its spare width over every column, so the gaps between columns ran 52–66 px (Beds a single digit in an 83 px column). The Actions head was meant to be right-aligned but `.table th { text-align: left }` outranks `.actionsHeader`, so it stood 170 px left of the buttons it names. Beds and prices sat left-aligned, so $89 and $439 did not line up.
- **Now.** The name takes what is left; Location, Type, Beds, Price and Actions are each as wide as their widest entry (`colFit`: `width: 1%`, no wrap), so every column stands 40 px from the next (the cells' existing 20 px either side). Beds and Price are right-aligned under right-aligned heads with tabular figures; the Actions head ends at the delete button's right edge. Scoped to this table (`.propertyTable`): Team and Availability share `.table` and `.actionsHeader` and are unchanged. My decision: the right alignment of the two number columns.

**Verified** on a local build reading production data (46 properties), throwaway PIN, at 1,700, 1,440, 1,280, 1,100 and 1,024 px: every head 0 px from its column's entries (left edges for Location and Type, right edges for Beds, Price and Actions), no spare width in the five fitted columns, 40 px between each of them, no horizontal scroll; the name column 648 px at 1,440 and up, 264 px at 1,024 (rows at most 69 px). Before, measured the same way at 1,700: gaps 66, 61, 52, 60 px; Beds' head 26 px and Price's 30 px off their entries, Actions' 170 px.

### 20.12 The admin home: four tiles (2026-10-02, night)

Kian's ruling (in `CLAUDE.md`, Admin home): "This stat containers on top should be only 4, the first one on the left should be number of total unites that we have on the platform. the second one from the left should be costs to be reviewed (just number of the costs not the price on them), the third one should be Leads coming in (only the new leads number) and the last one (the 4th one) past due reports to be generated."

- **The four**, left to right: **Units** (every property document the page holds, delisted ones included; a link to the top of the list below), **Costs to review** (pending + approved automatically and not yet seen, as before; the detail line now counts only: "1 pending · 2 approved automatically, not yet seen · 1 cleaner worth a look", never an amount), **New leads** (unchanged), **Statements past due, <last month>** (unchanged; still opens the statements panel). Gone: Leads in the last 30 days, Cleaning costs this month, Empty nights next 30 days, Free this weekend. Four columns from 1,200 px, two even rows below, one column under 640.
- **Reads.** The home no longer reads `/api/admin/availability`; it reads leads, cost entries and monthly reports, plus the property list it always read. A failed property read shows "Units could not be read", never 0.
- **What stayed in code.** `homeFigures` (`app/lib/availability/attention.ts`) is no longer called; left in place so the two availability tiles can come back. `ageText` moved from `DashboardStats.tsx` into the Availability page, its only user.
- **`CLAUDE.md`.** His ruling is recorded in his words under *Admin home*; the Availability ruling's "plus stats on the admin home page" carries a pointer that they were withdrawn on 2026-10-02.
- **My decisions:** the label "Units", the Units tile leading to the list, and keeping each tile's detail line (counts only).

**Verified** on a local build reading production data, throwaway PIN: the tiles read `46 | Units`, `2 | Costs to review | 2 approved automatically, not yet seen`, `3 | New leads | Waiting for an answer`, `0 | Statements past due, September 2026 | 0 of 2 finished · 2 drafts in progress`; recomputed in the page from `/api/leads` (3 new of 3), `/api/admin/cost-entries` (0 pending, 2 auto-approved unseen) and the list (46 rows, "46 properties"). The page's API reads were admin-auth, cost-entries, monthly-reports and leads, one each. One row of four 328 px tiles at 1,700; two rows at 1,199 and 1,024; four rows at 600. Units scrolls the list's toolbar to 24 px from the top (`/admin#properties`).

## 21. The reporting cycle's status, and deleting a finished statement (dispatch 23G, 2026-10-02)

Kian's rulings of 2026-10-02 (dispatch 23G, in `CLAUDE.md` under *Statements*): admins write the previous month's statements between the 1st and the 10th of the current month; a property's status is read from the previous month — finished is done, not finished is a warning (from the 1st to the 10th, and unchanged after the 10th), any month two or more months back with no finished statement is a problem that outranks the warning, and the current month is never counted; the status is a column on the property list, in the admin's tones, readable at a glance, linking to the property's page at the month in question; the property page's head, the home panel and the Statements tile use the same rule and the same words, decided by one function. An admin can delete a finished statement, downloaded or not, and continue the month as a draft — against the earlier rule that a finished statement is never changed; once deleted there is no record of what an owner received. Built on `902945a` plus the uncommitted polish pass of §20.4–§20.12 (the dispatch's precondition said the tree was clean; it was not, and 23G was built on top, kept separable).

### 21.1 What was built

- **The rule, once** (`app/lib/reports/statement.ts`, "Nubnb's reporting cycle"): `monthStanding` (one property-month: `finished`, `due`, `pastDue`, `open`, `notExpected`), `reportingStatus` (one property: its tone — done, warning, problem, none —, the month in question, every past-due month oldest first, the previous month's standing), `reportingStatuses` and `reportingCounts`, and `STANDING_LABELS`, the words: **Finished**, **Due**, **Past due**, **Open, not yet due**, **No statement expected**. `trackerRows`, `trackerCounts`, `propertyMonths` and `propertyMonthState` carry each month's standing from `monthStanding`; `STATEMENT_STATE_LABELS` and the old `outstanding` month list are gone, so no screen decides for itself.
- **The column** (`app/admin/page.tsx`, `components/StatementStatus.tsx` + CSS): "Statement", second after the name; a badge (green Finished, amber Due, red Past due — the approved, odd and rejected tones of the costs page) and the month in question, the cell a link to `/admin/property?id=&month=<that month>`; "+n" when more months are past due, every month in the tooltip. A property with nothing due shows the quiet words alone, so the rows that need work are the coloured ones. The badges share one width, so the months stand in one column.
- **The home** (`components/DashboardStats.tsx`): the tracker read is `useStatements`, held by the page for the tile, the panel and the column; the page moved under the PIN gate (`AdminHome`), since that read is admin-only. The tile: **Statements past due** — the number of statements past due, every property counted — with "September 2026: 4 due · 1 finished" under it; red when anything is past due, the accent when anything is due.
- **The panel** (`components/StatementsPanel.tsx`): each row's badge is the month's standing; a draft or a correction in progress is said beside it; past due first, then due, open, finished; the line counts by standing ("1 of 5 statements finished · 4 due · 3 drafts in progress"); under it, when there are any, "Past due in other months: August 2026 (1)" with each month a way to it.
- **The property page** (`app/admin/property/page.tsx`, `FinishTab.tsx`): the head carries the property's status — the past-due months, then the previous month when due, each a link; or the one month that says done or not yet due; the month bar's badge is the month's standing; the month list reads "September 2026 · due · draft", "September 2026 · finished · # Sep-…"; the release status uses the same badges ("Upcoming" kept for months not begun). The bar's old "Past due: …" list is gone (it used the old rule).
- **Deleting** (`deleteFinishedStatement` in `server-reports.ts`, `DELETE /api/admin/monthly-reports/[id]`, `deleteStatement` in `reports-client.ts`, "Delete statement…" on the Finish tab): the confirmation names what is lost ("This statement was downloaded 2 October. Deleting it removes the record of what was sent." / "This statement was never downloaded."; for a correction, which statement becomes current again); one transaction deletes the report and every download record of it and writes the draft back holding the statement's reference, date, lines, fee, carried balance, notes and the statement it replaced; then the PDF object at the report's stored path is deleted. The page mounts the month afresh from the answer: editable, finishable. The head of `server-reports.ts`, the function and the route each say that this is the one place a finished statement, its PDF or a download record is deleted.

### 21.2 My decisions, not rulings

- **The words.** "Due" for the warning and "Past due" for the problem; "Finished" for done (the statement's own word everywhere else, rather than a second word for the same fact); the current month keeps dispatch 23D's "Open, not yet due". The 23F label "Past due" for any closed month is withdrawn: September on 2 October reads Due.
- ~~A month is expected when it is in the property's statement months or a draft was started for it.~~ **Withdrawn on Kian's instruction (2026-10-02, §23):** it stood in for the rule that every property owes every closed month; a draft no longer makes a month owed.
- **Finished means a current finished statement**; a correction in progress beside it does not unfinish the month.
- **The month in question**: the oldest past-due month for a problem; the previous month for a warning or done; the last month of the property's statements when they ended before it; the first month due when none is yet. A property whose current month is already finished (Kian's 3 Bedroom Main Floor House, October) shows "Finished · October 2026" in green: nothing is due; the tile does not count it.
- **The tile counts statements past due**, keeping the ruled tile ("past due reports to be generated") under the new rule; the previous month's due and finished are its detail. One word to change if Kian wants the figure to be due + past due.
- **Only the month's current statement is deleted.** Refused, nothing deleted: a statement another replaces (409 `REPORT_REPLACED`); one with a correction of it in progress (409 `CORRECTION_IN_PROGRESS`, the page shows the correction); a draft that is not the one it was finished from (409 `DRAFT_CHANGED`); a download made since the page showed its count (409 `DOWNLOADED_SINCE`), so the admin always confirms against what is lost.
- **Deleting a correction** leaves the statement it replaced current and the draft a correction of it, holding the deleted correction's content.
- **Report For** lives on the property's record, not the draft; the statement froze what it printed. When the record no longer says that, the delete sets it back and the notice says so — a Report For edited on the record after finishing is overwritten. A statement finished before 23E froze none; its record is left alone and its draft takes the day it was finished as its date.
- **The PDF goes after the record.** If Storage refuses, the object is left and logged by path, and the page says so; the record is already gone.
- **One server log line per deletion** (IDs and counts, nothing of the statement).
- **The delete is on the Finish tab only**, in red; not on the panel.

### 21.3 Observed, not changed

- **"The one place in the system where something is deleted"** is true of the statements and costs records. Three deletes exist elsewhere: a property from the list, a property's management record cleared from the property form, a cleaner-facing name cleared. The code says "the only delete anywhere in the statements and costs records". (Since dispatch 23H a cost entry can be deleted too, and the code says so: §24.)
- **As with a correction (§18.5),** deleting an older month's statement after a later statement printed an adjustment against it, and finishing the older month again, carries that entry at its new amount while the later statement already printed the difference.
- **A later statement's carried balance may name the deleted statement** (`carried.fromReportId`); it is never looked up.

### 21.4 Verification (2026-10-02, morning)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4500, throwaway admin secrets, no `.env.local` in the copy; final build `wfNkgUwZ5YiPF34aSBwn_`), through the real routes and a real browser. **Opening export `backups/2026-10-02T13-32-02Z`: 100 documents, 15 collections** — Kian's state since 1 October: two finished October statements (each downloaded once), two management records, September drafts on Corner Penthouse and Ajax. **Storage 4,647 objects before the first write.** Test properties, none with an entry, a draft, a statement or a record: A Family Home in the Heart of Thornhill (`2uOz2IFFHZO6StZRBBTG`, record from September), B Private Basement Near Yonge St (`37L8ri0iao2pIjkeKcQR`, from September), C Nice Room In Renovated Basement (`4zOZFqCCkwlh2xuJsIKB`, from August), each record `__TEST__`. Raw outputs in the session scratchpad `out/00–18`, screenshots in `shots/`.

- **Pure** (`pure/check-23g.mjs`, 42 checks, 0 failed): the words; each standing; A finished, B not finished, C two months behind on 2 October; B on the 1st, 10th, 11th and 31st — the warning unchanged; B and A on 1 November (September past due, October due); C on 5 December (three past due, oldest first); the current month never counted; no record (nothing due in October, due in November); a replaced and a replacing statement; a deleted statement; statements that ended; a draft making a month expected; the tile counts; the panel rows equal to the list's previous-month standing; a property's months.
- **The status, on 2 October, the same everywhere.** List: A "Finished · September 2026", B "Due · September 2026", C "Past due · August 2026" (tooltip "Past due: August 2026 | Due: September 2026"), each link `…&month=` that month; Kian's two September drafts Due, his finished October property Finished · October 2026, 40 rows "Open, not yet due". Tile: "1 · Statements past due · September 2026: 4 due · 1 finished", red. Panel (September): A Finished, B, C and Kian's two Due, "Past due in other months: August 2026 (1)"; (August): C Past due. Property pages: A "[Finished] September 2026", B "[Due] September 2026", C "[Past due] August 2026 [Due] September 2026"; C's August link → August, its badge Past due, the release status June/July "No statement expected", August Past due, September Due, October "Open, not yet due", November/December Upcoming.
- **The column at 1,280 × 800**: no horizontal scroll (`scrollWidth 1280`); Statement 212 px, the name 276 px; badges one width, months aligned (`shots/list-1280-c.png`). Found and fixed on the way: the first build read the statements before the PIN gate signed in ("Statements could not be read: Authentication required"), now under the gate; the quiet rows printed a brighter month than their words, now the words alone.
- **A downloaded statement deleted.** A's September statement `Os585JWWXkoQNMPzbktu` (two lines, one with dates; fee by rate; carried balance; notes; reference `Sep-__TEST__-A`), 25,509 bytes, downloaded once (the signed link's bytes = the stored SHA-256). Report For then changed on the record to "…(changed after finishing)". A delete with `downloadsSeen 0`: 409 `DOWNLOADED_SINCE`, nothing deleted. From the page: the confirmation "Delete # Sep-__TEST__-A, Family Home in the Heart of Thornhill, September 2026? / This statement was downloaded 2 October. Deleting it removes the record of what was sent. / Its PDF is deleted too. The month reopens as a draft holding everything the statement had."; then the report, its PDF and its download record gone (`where reportId ==` 0), the draft at revision 2, `finishedAs null`, its reference, date, lines, fee, carried balance, notes and `supersedes` each equal to the statement's; Report For set back; the page "Due", "September 2026 · due · draft", the reference editable, "Draft · saved …"; the server log "statement Os585… deleted with 1 download record(s); PDF deleted"; Storage 4,647.
- **A new statement finished from it**: the notes edited in the page (revision 3), Finish and issue → `mMvGNqVzDzKUzuAtCZZ5`, "✓ Stored PDF verified: SHA-256 matches", the head Finished again.
- **A correction deleted.** `iDDcBKZzR6eAx6Cy46wL` replacing it (cleaning $65); deleting the replaced one: 409 `REPORT_REPLACED`. From the page: "…This statement was never downloaded. / # Sep-__TEST__-A, which it replaced, becomes the month's statement again; the draft continues the correction. …"; the correction and its PDF gone, the replaced one and its PDF still there, the draft revision 5 a correction of it with the $65 line; deleting the replaced one then: 409 `CORRECTION_IN_PROGRESS`. Again after the notice was reworded (`goxGHEYYkI9yzNpg0bTj`): "Deleted # Sep-__TEST__-A2. # Sep-__TEST__-A is September 2026's statement again; the correction continues as a draft."
- **Cleanup** by exact ID and path: the three records, A's draft, `mMvGNqVz…` and its PDF (the other three statements, their PDFs and the download record were already deleted by the feature). **Closing export `backups/2026-10-02T13-41-58Z`: all 15 files byte-identical to the opening export, 100 documents. Storage 4,647.** `tsc` clean; `eslint` clean on every changed file (two warnings in `app/admin/page.tsx` predate this).

**Not exercised:** a Storage failure leaving the PDF (`pdf: "left"`); deleting a statement finished before 23E (none exists); `STATEMENT_DELETE_FAILED`; the production admin panel.

## 22. The costs page: review first, totals last, one line per entry (2026-10-02)

Kian's note, with a screenshot of the queue (three removed entries, the property names broken mid-word, Status and Receipt out of view): "Totals for what is shown" should go at the bottom of the page, the logs that need to be reviewed should come on the top, and the table should become much cleaner in spacing and column structure.

- **Order** (`app/admin/costs/page.tsx`): the line, the filters, the entries, and "Totals for what is shown" (with its report row) at the bottom. A property's ledger keeps its one totals line with its Excel and PDF over its entries (the dispatch-21 ruling: its date range and both exports without further clicks).
- **The queue in groups**: "Approved automatically, not yet looked at" (Mark all as seen), "Needs a decision", then "Rejected or removed — kept on record; counted nowhere" last. Before, the rejected and removed entries sat among the ones waiting, by date. The queue's line is "Review queue · 2 to review"; its paragraph is the line's tooltip, the group note the button's.
- **The table**: Sent · Property · Logged by · Total · Status · Receipt, one line per entry. Items and Tax are no longer columns: the total's tooltip reads "Items $97.76 · tax $12.71" and the pane lists both. Every column is as wide as its widest entry; the property takes the rest and is cut to it, its whole name on hover (it used to break mid-word, `overflow-wrap: anywhere`). The kind is one word ("Office", "Work"); a missing receipt is a dash with its reason on hover, not a sentence.
- **The pane only when an entry is open**: before, it held "Select an entry…" at 380–500 px whatever was shown, which is what squeezed the table into scrolling sideways. With an entry open the table tightens (12 px cell sides, the pane at most 440 px, a long name cut, the Receipt column and the kind badge set aside — the pane shows both).
- **Removed**: `TaxText`, which nothing calls now.

**My decisions:** dropping the Items and Tax columns for the tooltip; hiding the empty pane; the decided group's place and words. **Verified** on a local build reading production data (throwaway PIN, build `tCwXPQ1EM_i3ZekGLUf6T`), nothing written (exports `2026-10-02T13-57-00Z` and `T14-00-57Z` byte-identical, 98 documents): the queue at 1,280 px — the line @y97, the filters @y128, the entries @y188, the totals @y459; "Rejected or removed (3)" with Kian's three removed entries; columns Sent 171 · Property 497 · Logged by 191 · Total 104 · Status 145 · Receipt 90 px, the table 1,198 px in a 1,198 px box, every row 53 px. All three groups, through an in-page stub of the list read: in that order, "Review queue · 2 to review". An entry open: the table 738 px in 738 at 1,280 (Property 201 px) and 898 in 898 at 1,440 and 1,700, no sideways scroll; the receipt loads in the pane. "All statuses" and a ledger: one line per entry (69 px where "in PDF" sits under the total), no sideways scroll.

## 23. Every closed month owed by default (2026-10-02)

Kian's ruling (in `CLAUDE.md`, *Statements*): every property owes a statement for every closed month by default; a property's management record narrows that — a start month excludes earlier ones, an end month excludes later ones — but a property with no record owes every closed month. On 2 October all 46 properties with no finished September statement must read Due, and the tile and the panel count them all. The draft rule of §21.2 is dropped.

- **Built:** `STATEMENTS_FROM_DEFAULT` is September 2026 (it was October 2026, decision 4): the month a property with no record owes from. `monthStanding` takes `owed` — in the property's statement months, nothing else; the `drafted` reading is gone from `reportingStatus`, `reportingStatuses`, `trackerRows` and `propertyMonthState`. The panel's line counts the rows owed ("0 of 44"), so a draft on a month not owed is listed ("No statement expected · draft") but not counted. A record `setReportFor` creates starts at the default, so saving Report For narrows nothing from now on.
- **My reading:** "every closed month" has a first month, September 2026, the month Nubnb's costs and statements began. With none, August and every month before would be owed, and every property would read Past due, not the Due the ruling expects. One constant to move.
- **Two records narrow September away.** Corner Penthouse l Tall Ceiling (`1VpX0wMpaUkbFwkULD8P`) and 3 Bedroom 2 Bath Main Floor House (`3dIaEHZuFzzgvy6Mbaq0`) have records starting October 2026: written by the old default when Report For was first saved on their pages (owners none, no end month, no fee), not chosen. By the ruling they do not owe September, so 44 of 46 read Due. Not changed in code (records are edited by hand): "Statements from" on each property's form.
- **What follows for statements:** September is owed by every property without a record, so an approved September cost not yet in a statement is carried into October's statement as "Expense - … (from September 2026)", the 23B rule for earlier months in scope. Seen on Ajax's October draft: −$110.47.

**Verified** on a local build reading production data (throwaway PIN, builds `tCwXPQ1EM_i3ZekGLUf6T` before, `fjW8pKWyThqoyddDfnyyh` after), nothing written. Before: list 2 Due (Ajax and Corner Penthouse, by their September drafts) and 44 "Open, not yet due"; tile "0 · Statements past due · September 2026: 2 due · 0 finished"; panel "0 of 2 statements finished · 2 due · 2 drafts in progress". After: list 44 "Due · September 2026", Corner Penthouse "Finished · October 2026", 3 Bedroom Main Floor "Open, not yet due"; tile "0 · Statements past due · September 2026: 44 due · 0 finished"; panel "0 of 44 statements finished · 44 due · 2 drafts in progress", 44 rows Due and Corner Penthouse "No statement expected · draft". The other tiles from their sources: Units 46 = 46 list rows; Costs to review 0 = 0 pending + 0 unseen of 7 entries; New leads 3 = 3 of 3. Pure checks 43, 0 failed.

## 24. Codes typed at creation, handymen always reviewed, deleting an entry outright (dispatch 23H, 2026-10-02)

Kian's rulings (in `CLAUDE.md` under *Team and costs*): an admin types a new cleaner's or handyman's four-digit code, with an offer to generate one, under the refusals a code change already has; an admin can delete a cost entry entirely — the document, its history and its receipt object — reversing the earlier ruling that nothing is deleted, so a deleted entry leaves no record of what was claimed or who logged it; the confirmation names who logged it, when, the amount and that the photo goes; removal stays as it is; and a delete is refused, naming the statement, while a finished statement prints the entry. He also asked for a check that a handyman's entry never auto-approves. Built on `3189872`.

### 24.1 What was built

- **The code at creation.** `POST /api/admin/cleaners` takes `{ name, role?, code? }`. A typed code goes through `issueCleaner`'s new `issueTyped`: the PIN and the reserved list are refused before anything is read (422 `CLEANER_CODE_IS_ADMIN_PIN`, `CLEANER_CODE_TOO_EASY`); one transaction reads `cleaner_codes/{code}`, refuses one ever issued (409 `CLEANER_CODE_TAKEN`, "belongs to someone else on the team" or "was used before and is never given out again"), then `create()`s the code and the account. Without `code` the server draws one, as before. The reserved list moved from `codes.ts` to `model.ts` (`isTooEasyCode`), the same 24 codes, so the browser can use it. The dialog (`NewMemberDialog.tsx`) has a Code field after the name, digits only, at most four, and **Generate**, which fills the field with `suggestCode()` (uniform over 0000–9999 from `crypto.getRandomValues`, never a reserved code) for the admin to keep or change; Create waits for four digits. A refusal stays in the dialog with what was typed. "Change code" is untouched.
- **Deleting an entry.** `deleteCostEntry` (`server-cost-entries.ts`) and `DELETE /api/admin/cost-entries/[id]` with `{ seen }`. One transaction: the entry as the admin saw it (else 409 `ENTRY_CHANGED`); every finished statement of its property, and any whose `entryIds` name it, read from their raw fields (cost rows, `entryIds`, adjustments; current or replaced) — any printing it refuses with 409 `ENTRY_IN_STATEMENT`, the hint naming each ("It is in the statement for October 2026 (# Oct-…), finished 2 October 2026…") and `evidence.statements` their IDs; then the entry, its reading (`cost_entry_readings/{id}`) and the one-time-key record naming it (`cost_entry_submissions`, `where entryId ==`) are deleted. After the commit each receipt object at the entry's stored path, only under `receipts/{id}/`, is deleted; a failure leaves it, logged by path, and the answer says `left`. One log line per delete.
- **The pane** (`EntryPane.tsx`): **Delete…** in red beside Remove, for an entry of any status. When the property's statements show a finished one printing the entry, it refuses at once with the server's words, without asking. Otherwise the confirmation: "Delete this entry for good? / Logged by Amir (cleaner) on Oct 2, 2026, 11:03:01 a.m. / Amount: $45.20, for … / The receipt photo is deleted with it. [or: It has no receipt photo.] / [It went out in a PDF exported …; that PDF will no longer match the ledger.] / Nothing is kept: there will be no record of what was claimed or who logged it. This cannot be undone. / To take it out of totals and keep it on record, use Remove instead." Afterwards the pane closes, the entry leaves the page's list and the page says what went. Remove's icon is now a circle with a minus, so the bin is Delete's alone. The approved note no longer ends "and nothing is erased".
- **The ledger after a delete** (`deletedSincePdf` in `costs/report.ts`): an entry gone has no row to mark, so the ledger on the costs page (every PDF of the property) and the property page's Costs tab (PDFs covering the month) say, per recorded cost PDF that lists one: "The cost PDF exported … for … lists an entry since deleted, at $45.20: whoever received it holds a total that includes it." `sincePdf`'s `missing` is no longer "not expected".

### 24.2 My decisions, not rulings

- **The reading and the one-time-key record go with the entry.** The ruling names the document, its history and the receipt; the reading holds what the receipt said and the cleaner's ID, the key record the cleaner's ID and the entry's, so keeping either would leave a record of what was claimed or who logged it. A consequence: the phone sending the same receipt again after a delete would write a new entry rather than find the old one (it only resends when an answer was lost).
- **A recorded cost PDF (`cost_report_exports`) is never changed**: it keeps the amount it printed, and the ledger says that PDF no longer matches — the ruling of 2026-09-30 on corrections after a PDF. Deleting is not refused for an entry in a cost PDF, only for one in a finished statement; one line to add if Kian wants that too.
- **"Printed in a finished statement" counts replaced statements and adjustments**, not only the month's current statement: each was sent.
- **Any status can be deleted**, a removed entry included; the delete checks the history length the page showed.
- **Generate fills the field** rather than creating at once (as "Change code"'s Generate does): the admin sees the code before creating, and can change it. The server stays the judge: a suggestion that is the PIN or already issued is refused like a typed one.
- **The create's "taken" message** says "someone else on the team" (a handyman's code is in the same index); the code-change route's words are unchanged.

### 24.3 Handymen and auto-approval: already right

Checked against the live build (www.nubnb.ca, `3189872`) with a `__TEST__` handyman: work at $150.00 and at $250.00 were both stored `pending`, `autoApproved: null`, one `submitted` event; the handyman's receipt was refused 403 `ROLE_MISMATCH` before any upload. The same on this tree. `createWorkEntry` writes `pending` whatever the amount, and `createCostEntry` refuses any account that is not a cleaner, inside its transaction. Nothing was changed.

**What Kian likely saw:** in production, the account "Amir" (`Ce3Lm7VEBIYyHbMdLB9R`) was created on 30 September at 20:05 Z, before roles existed, so it has no `role` and is a cleaner — the Team page says "Cleaner". Its receipt of $11.87 (`Auu3BFk7Ztn5RK76QWcz`, 1 October 21:34 Z) was approved automatically, as a cleaner's receipt is. Eight minutes later a handyman account "amirrrr" (`RH3gFhoOrZobOnFGBb3P`) was created; it has logged nothing. A role is fixed when an account is created, and no document is corrected by code.

### 24.4 Verification (2026-10-02, late morning)

Against a local production build of this tree reading production data (`next start` on 127.0.0.1:4500, throwaway admin and cleaner secrets, no `.env.local` in the copy; builds `FEbbJbYz3qoAnLK0xvRqL`, then `vZVqA-6TK5QZSg9n_mW0-` after the wording fixes), and production itself for the handyman check. **Opening export `backups/2026-10-02T14-47-22Z`: 96 documents, 13 collections; Storage 4,645 objects (4,640 property photos, 5 receipts).** Test property Nice Room In Renovated Basement (`4zOZFqCCkwlh2xuJsIKB`: no entry, draft, statement, record or cost PDF). Raw outputs in the session scratchpad `out/`, screenshots in `shots/`.

- **Pure:** the reserved list before (HEAD `codes.ts`) and after (`isTooEasyCode`) identical, 24 codes; `suggestCode` ×200,000 offered no reserved code and all 9,976 others, each 6–36 times (~20 expected).
- **Codes at creation:** the cleaner by the API with 8341 → 201, stored 8341; the handyman from the dialog with 9263 typed (after Generate filled 9201, 5475, 7764) → "Created __TEST__ 23H handyman as a handyman. Their code is 9263." Refused, nothing written: 9263 again → 409 "belongs to someone else on the team"; the server's own admin PIN → 422 `CLEANER_CODE_IS_ADMIN_PIN`; 1234 and 0000 → 422 `CLEANER_CODE_TOO_EASY`; "12a4" → 422 validation; 8341 after the cleaner's code was changed to 9759 → 409 "used before". Then 7 accounts (5 + 2), `cleaner_codes/1234` and `/0000` missing. In the dialog, the refusal kept the name and the code.
- **Handymen:** above (§24.3); the four work entries showed in the queue as Pending.
- **A cleaner's receipt under $200:** three, all `approved`, the second event by the system actor, `autoApproved {thresholdCents 20000, totalCents 4520}` on the first.
- **Deleted:** entry A (`1u83iE705VtH4JCIgbwp`, $45.20, auto-approved, with a `__TEST__` reading written beside it) after an Excel file and a recorded PDF that listed it. From the pane: the confirmation as above; afterwards `cost_entries/…`, `cost_entry_readings/…`, its `cost_entry_submissions` record and `receipts/1u83iE…/fab6fe2a….jpg` each read MISSING; the server log "deleted with 1 submission record(s), reading deleted, receipts deleted"; Storage 4,648 → 4,647; the cost PDF record unchanged. The ledger: 3 entries · $143.00 → 2 · $97.80, and the line about the PDF; the Excel file and the PDF made afterwards hold no trace of it (0 matches for its ref, its items or $45.20), the PDF two entries and $97.80. The property page's Costs tab carries the same line. Entry C, removed first, was deleted from the queue the same way (4,648 → 4,647 with the statement's PDF present).
- **Refused:** a `__TEST__` October statement finished printing entry B; `DELETE` → 409 `ENTRY_IN_STATEMENT`, "It is in the statement for October 2026 (# Oct-__TEST__-23H), finished 2 October 2026…", B, its record and its receipt unchanged (update time = creation). In the pane, Delete showed the same words and no confirmation. Also 409 `ENTRY_CHANGED` (stale `seen`), 404 `ENTRY_NOT_FOUND` (A again), 401 without a session.
- **Removal:** C removed from the pane, the old confirmation; out of the ledger (1 entry · $67.80), in the queue "Removed · auto · still in a PDF", its history submitted → approved → removed.
- **Cleanup** by exact ID: the statement through its delete route (its PDF deleted), B and the four work entries through the new route, the rest from the ledger (2 accounts, 3 code documents, 2 cost PDF records, the reopened draft). **Closing export `backups/2026-10-02T15-10-53Z`: all 13 files byte-identical to the opening export, 96 documents; no `__TEST__` left; Storage 4,645.** `tsc` and `eslint` clean.

**Not exercised:** a Storage failure leaving a receipt (`left`); `ENTRY_DELETE_FAILED`; an entry in a replaced statement or only in an adjustment (the scan reads both; no such data); the production PIN as a typed code (the local server refuses its own PIN by the same comparison); the production admin panel.

## 25. An entry opens under its own row (2026-10-02)

Kian, with a screenshot of the costs page and its side pane: the details should not appear on the right; they should be an accordion, expanded under the entry, showing its details and its receipt preview in depth.

- **The costs page** (`app/admin/costs/page.tsx`): a click on a row opens the entry in a full-width row beneath it; a chevron before the date says open or closed (`aria-expanded`); a click on the row again, or the ×, closes it. The side pane, its grid and the table's tightened mode for it are gone, so the table keeps its width and every column. `?entry=` still opens an entry on load and brings its row to the top; an address naming an entry the filters leave out says so in one line. In "Items bought", a line opens its entry in the Entries view.
- **The entry, opened** (`EntryPane.tsx`): no heading under its row (the row says the property, who and when); the receipt photo in its own column, at most 380 px or a third of the width, up to 860 px tall, beside the review, the items, the property and statement, the PDFs, the cleaner's note and last 90 days (side by side when they fit), and the history. The two columns come from the entry's own width (a container query at 760 px), so the property page, where the entry has about 620 px, stacks them with the receipt capped at the old 340 px, and keeps its heading. An entry with no receipt is one column, "No receipt: …" said once beside its status.
- **Clearer, per the standing instruction on admin pages:** the status is said once, by its badge — the paragraphs repeating it are gone; the automatic approval is one line; the note under the items table and the receipt link's minute are tooltips; Correct is a quiet link at the end of its line, plain on the line under the pointer, so a 35-line receipt is 35 lines of 42 px instead of 78. The items table, nested in the entry table, no longer takes that table's cell padding, header band and hover. The double divider under the actions is gone.

**My decisions:** one entry open at a time; the chevron in the date cell, not a column of its own; when a review takes the open entry out of the list shown (approved or seen in the queue, removed from "Approved"), it closes and the page shows the review's notice with "It has left this list." — before, the pane stayed open on an entry no longer listed.

**Verified** on a local build reading production data (throwaway PIN, build `pqxpwlPMLkeyaz2E8mspO`), nothing written: at 1,320 px the 35-line receipt opens with the photo 378 × 820 px beside its items, every line 42 px, no sideways scroll; at 1,700 and 960 px the receipt column 380 and 293 px; the office entry one column; opening a second row closes the first, the same row again closes it; `?entry=` opens with its row at the top (88 px); an unknown entry shows the one line; from "Items bought" the line's entry opens in Entries; a Remove answered by an in-page stub (no request reached the server; the entry's `updateTime` unchanged) closed the entry, took it off the Approved list and showed the notice; Full size covers the window; the property page stacks, the receipt 157 × 340 px over the review.

## 26. The Income tab asks the way the Costs tab does; every block on the property page is one shape (2026-10-02)

Kian, with a screenshot of an empty Income tab ("LINES · No lines yet · Add line"): "The UI on the form for income intake is not good, improve the UI and make sure there is alignment between income, cost and details tabs in forms and the way that they are being asked."

- **The Income tab** (`IncomeTab.tsx`): the block is **Income**, its figure the revenue and the typed expenses, its one action **Add a line**, a primary button like the Costs tab's Log a cost. It opens a labelled form under the head — Description and Dates on one row, Quantity, Rate ($) and the computed Amount on the next — with Add line and Cancel. The lines are a table like the month's costs (Description · Qty · Rate · Amount), the dates and anything a line written before carried under the description; a click on a line opens the same form on it ("Line 2"), with Save line, Cancel and Remove line (a confirm) at the far right, the row marked while it is open. ↑ ↓ at the end of each row keep the order, quiet until the row is under the pointer. A line goes into the draft when the form is submitted and the draft saves itself as before; a loaded line that does not read (no description, a rate of 0.00) shows "—" and "Check this line" until it is opened and fixed. A finished month shows the table alone. The spreadsheet-style grid of inline inputs, its order column, its trash button and its container queries are gone.
- **The Costs tab** (`CostsTab.tsx`, `AddCostForm.tsx`): the block is **Approved costs**, its figure "2 entries · $221.05 · tax $24.05" (or "None"), its action Excel · PDF · Log a cost; the log-a-cost form opens under the head, not inside the head's row, and is the form alone (the tab holds whether it is open). Its fields sit on the same widths as a line's.
- **The Details tab** (`DetailsTab.tsx`): each block is the same shape — its name, its figure, its one action in the head, the fields under it. The management fee's head says its amount (or "None") and offers Add a fee / No fee; the carried balance's head offers Carry $359.96 from September 2026 and Type a balance, or No balance; the empty-state sentences and the link buttons they held are gone. The fields keep their widths (rate 96 px, amounts 180 px, the label full width); Report For's name and address stay side by side.
- **The Finish tab**: Reference and Date on the same field layout (the date 180 px).
- **One stylesheet rule set** (`page.module.css`): `.blockHead` is name · figure · action (the name takes the room; a block with no action keeps its figure at the right edge); `.fields` is one row that wraps, each field as wide as what it holds (`fieldGrow` 240 px and up, `fieldDates` 250, `fieldQty` 96, `fieldAmount` 180, `fieldHalf`, `fieldFull`, `fieldBreak` to start a new row), with the dates field drawn like the inputs beside it (`datesField`); `.form` is the panel under a head; `.listTable` is the one table for lines and entries (the costs table's rules, renamed), with `rowClick`, `rowOpen`, `rowSub`, `orderCell`. The old `lineHead`/`lineRow` grid, `feeGrid`, `carriedGrid`, `referenceGrid`, `twoCols`, `formGrid`, `costsHead` and `removeBtn` are removed.

**My decisions, not rulings:** a line is added or corrected through a form rather than typed in place (the Costs tab's pattern, which the instruction named); the computed amount is shown as a figure, not a field; removal lives in the line's form; the Income block is named "Income" and the Costs block "Approved costs"; an empty Income block is its head alone (the figure already says $0.00), as an empty fee or balance block is; the line form always has two rows, so the figures stand together under the description at any width.

**Verified** on a local dev server of this tree reading production data (throwaway PIN, 127.0.0.1:4651), with the draft save answered by an in-page stub (every `PUT /api/admin/monthly-reports/draft` caught, 200 with the payload echoed; **nothing written**) and a finished October statement likewise stubbed into the property's statements read for the read-only views: at 1,440 × 950 on 3 Bedroom 2 Bath Main Floor House, October 2026 — the empty block, the form (Description · Dates on one row; Quantity · Rate · Amount on the next, the amount $1,200.00 live as the rate is typed), two lines added (Revenue 1 × 1,200.00; Expense - Cleaning 2 × −120.00) listed as a table with the tab count 2 and the figure "$1,200.00 revenue · −$240.00 expenses", the preview redrawn with both, a click on Revenue opening "Line 1" with Save line and Remove line and the row marked; Costs with Log a cost open under the head (Description · Amount · Tax on one row); Details with the fee and the balance open (96 / 180 / 180, the label full width; label and 180). At 1,280 × 800 the line form, the cost form and the Details tab wrap as designed (the cost form's tax on a second row); the left column's bottom at 771 px with the fee and balance closed. The finished month: Income a table alone, no button; Details nine fields all disabled, no button. The production build of the tree (`cfobiRqjeetkNKuakOG95`, `next start` with the throwaway secrets) then showed the same: the two lines added through the form, the row opened, the cost form, Details, Finish. Port 4500 now serves that build from the same copy with the production `.env.local`: c6e91c4 plus the costs accordion (§25) and this section.

## 27. A recorded cost prints on the statement as its reference and day, not its items (2026-10-02)

Kian, with a screenshot of the preview printing "Expense - BED IN A BAG, BLUEW PLW, RED TW FTD, …" for a receipt: "the expense that got logged is a list of all items are set as the description but it's wrong, it needs to be expense id and date or something like this." This answers the question left open in §20.8.

- **`costLineName(entryId, day)`** in `app/lib/reports/statement.ts`: `ref ykHRE5 · Oct 1, 2026` — the entry's reference (the first six characters of its ID, as the admin pages show it) and the Toronto day it was sent (Kian's ruling of 2026-10-01: a cost is named by the day it was submitted), in the date style the statement already uses. The month's cost rows print "Expense - ref ykHRE5 · Oct 1, 2026"; an earlier-month entry "Expense - ref … · Sep 28, 2026 (from September 2026)"; an adjustment "Adjustment - ref … · Sep 28, 2026 (reported in September 2026 as $401.10, now $380.00)". The items are in the ledger and its PDF, where they were.
- **Every kind** of entry prints this way — receipts, handyman work and office costs — so a statement names costs one way. The ledger PDF and the Excel export still print what was bought or the work done.
- **Statements finished before print as they did.** The description is stored on each cost row of the finished report and the writer prints the stored text; nothing is backfilled. The finish claim (entries, earlier entries, adjustments and their amounts) does not carry descriptions, so a page open on the earlier build still finishes.
- **Where else the text shows:** the Costs tab's "Also in this statement" rows and the entry pane's statement line read the new description for a draft, and the stored one for a finished statement.

**My decisions, not rulings:** the form "ref ykHRE5 · Oct 1, 2026" (Kian said "expense id and date or something like this"); the rule applied to work and office entries too, whose typed description no longer reaches the owner's statement — Kian may want those to keep their words.

**Verified** (pure, `pure/check-cost-name.mjs` in scratchpad 80c3cdc7: the four modules transpiled with the repo's TypeScript, `buildStatement` run on made-up entries, no Firestore): a receipt of two items sent 1 October prints `Expense - ref ykHRE5 · Oct 1, 2026` at −40110; one sent 28 September and not reported before prints `Expense - ref FEAD17 · Sep 28, 2026 (from September 2026)`; an entry a September statement printed at $401.10 and since corrected to $380.00 prints `Adjustment - ref AdJ001 · Sep 10, 2026 (reported in September 2026 as -$401.10, now -$380.00)` at 2110; no row carries an item's name; the September report's stored row text ("Paint (old text)") is untouched. `tsc` and `eslint` clean. On the production build of the tree (throwaway PIN, nothing written), the preview for 3 Bedroom 2 Bath Main Floor House, October 2026, prints the receipt as `Expense - ref RirhrW · Oct 1, 2026 · 1 · -$401.10 · -$401.10` where it printed the item list before (build `9hNmx4zKr_LhxNSCS_PXl`; screenshot `shots/q-costs-preview.png` in scratchpad 80c3cdc7). Port 4500 now serves that build with the production `.env.local`: c6e91c4 plus §25, §26 and §27.

## 28. Deleting a team member (2026-10-02)

Kian: "we should be able to fully delete a team member (cleaner or handyman)." Recorded in `CLAUDE.md` under *Team — Kian's ruling of 2026-10-02 (afternoon)*.

- **`deleteCleaner(id)`** (`server-cleaners.ts`) and **`DELETE /api/admin/cleaners/[id]`** (no body): one transaction reads the account and every `cleaner_codes` document whose `cleanerId` is the account's, retires each that is not retired yet (`retiredAt`), and deletes the account's document. Answers 200 `{ deleted: { id, name, role, codes } }`; 404 `CLEANER_NOT_FOUND` (nothing deleted); 502 `CLEANER_DELETE_FAILED` (may or may not have). A session the person still holds names a document that no longer exists, so `readSessionCleaner` answers invalid and the phone is signed out on its next request; the code no longer signs anyone in (`findCleanerByCode` needs the code not retired and the account present).
- **The Team page**: a third row action, **Delete…**, in the past-due red. The confirmation names what is lost: "Delete Amir for good? / Handyman, code 4821. The code stops working at once and is never given out again; any signed-in phone is signed out. / They logged 3 entries (1 pending review); those stay on the ledger under the name “Amir”. / The account cannot be reactivated. This cannot be undone." (or "They logged no entries.", or, when the cost read failed, that they could not be counted). The row leaves the list only on the server's answer; the notice says the code no longer works and how many entries stay. `deleteCleaner` in `cleaners-client.ts`; `CLEANER_DELETE_FAILED` is an unknown outcome, said as such.
- **Their entries stay**, untouched: each keeps its `cleanerId` and the name it was logged with, so the ledger, the statements and the review queue read as before; the entry pane already says "This cleaner no longer exists; the name is the one recorded with the entry." (`NameNotes`). The readings and one-time-key records beside those entries stay with them. Nothing in Storage belongs to an account.

**My decisions, not rulings:** the account's codes are retired, not deleted — the rule a replaced code already follows (a code is never given out again), so a phone that knows a deleted member's code cannot sign in as whoever is issued it next; the code documents keep the deleted account's ID (an opaque auto-ID that the entries also carry), nothing else; entries are never deleted with an account (an entry may be printed in a statement; the 23H delete, one entry at a time, stays the way to remove one); a member can be deleted in any status, with no deactivation first; no `seen` guard, since a concurrent code or status change does not change the decision.

**Verified** (2026-10-02, 20:49–20:51 Z) on a production build of this tree (`Y4MTNTA5kEszkBv8dRUu4`, `next start` on 127.0.0.1:4651 with a throwaway PIN) reading production data, through the real routes and the real Team page. Opening export `backups/2026-10-02T20-49-11Z` (13 collections, 89 documents); Storage 4,643 objects before. A first run reached the Team page signed out (the browse daemon had restarted), so its delete went through the route instead (200), the session then 401 and the code refused; its account `KAEA4CDvGS4z9EL8VW06`, entry `VXRiOhHGIQ8p5eEThrxW`, code document `1326` and submission record were cleaned up by ID. The second run, in full: `__TEST__ Delete Me` created as a handyman with the typed code 4651 (`cleaners/7ih8PM9afTzi1eT0feXj`, `cleaner_codes/4651` with `retiredAt: null`); signed in with it on the phone side (200) and logged one work entry `xO67wS5a3hSLtJflrclr` ($185.00, pending); `/api/cleaner/start` answered 200. On the Team page the test row's **Delete…** asked exactly: "Delete __TEST__ Delete Me for good? / Handyman, code 4651. The code stops working at once and is never given out again; any signed-in phone is signed out. / They logged 1 entry (1 pending review); those stay on the ledger under the name “__TEST__ Delete Me”. / The account cannot be reactivated. This cannot be undone." Accepted: the notice read "Deleted __TEST__ Delete Me. Their code no longer works. 1 entry stays on the ledger under their name." and the table went from 6 rows to 5 with none naming the member. Then: the phone's `/api/cleaner/start` 401 `CLEANER_SESSION_INVALID`; the admin list 5 members, the ID absent; `cleaners/7ih8…` does not exist; `cleaner_codes/4651` kept, `cleanerId` 7ih8…, `retiredAt: 2026-10-02T20:50:38.897Z`; the entry still listed with `cleaner: { id: 7ih8…, nameAtEntry: "__TEST__ Delete Me", state: "missing", name: null }` (what the pane's note reads from); a second DELETE 404 `CLEANER_NOT_FOUND`; sign-in with 4651 401. Cleanup: the entry by ID through `DELETE /api/admin/cost-entries/xO67…` (200, its submission record with it), the retired code document by exact ID with the Admin SDK (no admin route deletes a code document). Closing export `backups/2026-10-02T20-51-08Z`: all 13 files byte-identical to the opening one, 89 documents; Storage 4,643 after. Screenshots `shots/t-team-before.png` and `t-team-after.png` (every real code blanked before capture). The two runs' test codes, 1326 and 4651, are no longer reserved.

## 29. A code is free whenever no active account holds it (2026-10-02)

Kian, with a screenshot of the new-member dialog refusing the typed code 1381 ("That code was used before and is never given out again"): "this is not correct UX, if there is no active accounts with that PIN, it should be good to go to reuse the PIN." Recorded in `CLAUDE.md` under *Team*. This replaces the rule, mine since dispatch 18, that a replaced code is never reissued, and §28's decision that a deleted member's codes stay retired.

- **`codeAvailability` and `takeCode`** (`server-cleaners.ts`), used by the create (`issueTyped`) and the code change (`writeCode`) inside their transactions: a code is **taken** only while an existing account whose `code` is that code is **active**; the refusal names them ("That code is Amir’s." · "Change their code or delete them to reuse it, or choose another."). Otherwise it is **free**: never issued (the document is created, as before); replaced or a deleted account's (the retired document is overwritten to point at the new holder); or a **deactivated** account's — then that account is left with no code (`code: null`, a `code_released` event in its history, reason "Given to another team member"), so on reactivation the admin sets a new one and no two accounts ever show the same code. `HISTORY_ACTIONS` gains `code_released`.
- **The answer says who let go**: `released: { id, name } | null` on the create's 201 and the code change's 200; the Team page's notice adds "It was Baban's (deactivated); they now have no code." The dialog's refusal for an active holder stays in the dialog, as before.
- **Words changed**: "and is never given out again" is gone from the code-change explanation, the random-code confirmation and the delete confirmation. Code documents are still kept and marked `retiredAt` on a change or a delete, as the record of whose they were, not as a reservation. A drawn code (Generate on the server side, up to five candidates) still skips any code whose document exists: with ten thousand codes there is no need to reuse one at random.

**My decisions, not rulings:** "active" is read as the account's status: a deactivated account's code is free and that account loses it, rather than refusing until the admin changes or deletes them; the refusal names the active holder by name (admins already see every code and name on the Team page).

**Verified** (2026-10-02, 22:16–22:17 Z) on a production build of this tree (`ZggwLuJecZsWOKK_hu1Mj`, `next start` on 127.0.0.1:4651, throwaway PIN) reading production data, through the real routes; opening export `backups/2026-10-02T22-16-16Z` (9 collections, 74 documents — see the note below on what production held by then), Storage 4,640. Two unissued test codes X = 4368 and Y = 6708. (1) `__TEST__ Reuse A` created with X; A's code changed to Y: `cleaner_codes/4368` kept, `cleanerId` A, `retiredAt` set. (2) `__TEST__ Reuse B` created with X: 201, `released: null`; `cleaner_codes/4368` now points at B, `retiredAt: null` — a replaced code reused. (3) B deactivated; `__TEST__ Reuse C` created with X: 201 with `released: { id: B }`; B's document then `status: deactivated`, `code: null`, its history ending in `code_released` ("Given to another team member"); the code document points at C. (4) `__TEST__ Reuse D` with X while C is active: 409 `CLEANER_CODE_TAKEN`, "That code is __TEST__ Reuse C’s." (5) Sign-in with X answered C. (6) C deleted through the new route; D created with X: 201 — a deleted account's code reused; C's old session 401; sign-in with X answered D. (7) A's code typed as X while D is active: 409; D deactivated; A's code typed as X: 200 with `released` D, D's document `code: null` with its `code_released` event, `cleaner_codes/4368` pointing at A and `6708` retired. (8) The Team page listed D and B as "None on record · Deactivated" with **Set code**, and A with 4368, Active (`shots/r-team.png`, real codes blanked — there were none left to blank). Cleanup: A, B and D deleted by ID through the delete route (C already), the two code documents by exact ID with the Admin SDK (one of them, Y's, had not been ledgered by the driver and was deleted in a second pass). Closing export `backups/2026-10-02T22-17-12Z`: all 9 files byte-identical to the opening one; Storage 4,640.

**Observed, not changed — production between 20:51 Z and 22:16 Z.** My closing export of §28 (`20-51-08Z`) held 13 collections and 89 documents: five team members (Amir, Kian, Baban, Moe C, amirrrr), four cost entries with three receipt objects, their readings and submission records. The opening export of this section (`22-16-16Z`) holds none of `cleaners`, `cost_entries`, `cost_entry_readings` or `cost_entry_submissions`, Storage has no `receipts/` objects, and five `cleaner_codes` documents gained a `retiredAt` — what the delete route of §28 writes when an account is deleted. Nothing of mine ran in that window; the deletions came through port 4500, which Kian uses with the production environment. Reported to him in the hand-over.

## 30. The property list's Statement column names the month alone (2026-10-02)

Kian, with a screenshot of the column ("Due · September 2026" on every row): "remove the 2026 (year) from the column, month is enough." `ReportingStatusCell` (`components/StatementStatus.tsx`) now writes `monthName(month)` — "September" — from a new helper beside `monthLabel` in `app/lib/reports/model.ts`. The cell's tooltip keeps the year ("Due: September 2026", and every past-due month with its year), as do the property page's head, the month control, the Finish tab and the home panel: past-due months can span a new year there. **Verified** on a production build of the tree (`5tSC19Zy_4PkFt0xwKyOF`, throwaway PIN, read only): all 46 rows read "Due September", none with a year, the first row's tooltip "Due: September 2026" (`shots/s-list.png` in scratchpad 80c3cdc7).

## 31. Two property toggles, and the month as a ZIP (dispatch 24, 2026-10-03)

Kian's rulings are in `CLAUDE.md` under *Backup — Kian's rulings of 2026-10-03* and *Properties — Kian's rulings of 2026-10-03*. The backup's design, revised to them, is `FINANCIAL-MANAGEMENT-PLAN.md` §2.7 (committed `92a4694`, not pushed). The Drive mirror is the next dispatch.

### 31.1 Every public path that reads properties (reported before anything changed)

| Path | How it read `properties` | Now |
|---|---|---|
| `/` (homepage, map, search, filters) | server, `getPropertySummaries()`, ISR 1 h | the summaries leave unlisted properties out |
| `/property/[slug]` | server, `getPropertySummaries()` + `getPropertyById()`, ISR 1 h, `generateStaticParams` | an unlisted slug resolves to nothing: the page says "this property is no longer available", as for any unknown slug |
| `/api/property/[id]` (the panel's JSON) | server, force-static + `generateStaticParams` over every ID | 404 for an unlisted ID; no file prerendered for one |
| `/api/properties/[id]` GET | server, public, rate-limited; the admin form reads through it too | 404 for an unlisted ID unless the request carries an admin session |
| `/api/booked-dates/[id]` | server, reads the property's `icalUrl`; CDN 10 min + stale-while-revalidate 1 day | 404 for an unlisted ID, cached at the edge like a success so it replaces what the edge held |
| `/about/guests` (map, city counts) | **the browser, client SDK**: the whole collection read from Firestore on every visit | a server page, ISR 1 h, on the same summaries as the homepage; the browser reads no Firestore |
| `/sitemap.xml` | none: four fixed pages, no property | unchanged |
| Direct reads of the collection | `firestore.rules`: `allow read: if true` (get and list) for anyone with the public web config | `get` refused for an unlisted property; `list` refused for everyone (rules are not filters) |
| Not public, but under the same rules | the admin list and the Availability page read the collection from the browser | both read `GET /api/admin/properties` (admin session, Admin SDK) |
| Not reading properties | `/api/check-availability`, `/api/fetch-booked-dates` (take an iCal URL), `/api/contact` (stores a property ID) | unchanged |
| Inside, through the Admin SDK, untouched by rules | the cleaner app (`/api/cleaner/start`), costs, leads, reports, availability, scripts | unchanged: an unlisted property works everywhere inside |

Residual, not changed: property images are Firebase Storage download-token URLs, served without consulting rules. Nothing public links to an unlisted property's images any more, but a URL handed out before keeps working.

### 31.2 Excluded from reporting

- **Stored** on the server-only `property_management/{propertyId}` record as `excludedFromReporting: true`, written only when true and absent otherwise (`PROPERTY_MANAGEMENT_SCHEMA_VERSION` 3), so no record that never set it changes shape. The form sends the flag on every save, so unticking clears a stored `true`; a record back at every default is cleared, as before.
- **The rule, in one place** (`reports/model.ts`, `reports/statement.ts`): `inStatementScope` is false for an excluded property; `monthStanding` gives a new standing, `excluded` — "Excluded from reporting", tone none — unless the month is finished; `reportingStatus` answers it at once with nothing due, past due or finished, so `reportingCounts` (the tile) counts it nowhere; `trackerRows` (the home panel) and `looseEnds` skip the property; the property page passes the flag to `propertyMonthState`. The backup button of the next dispatch reads the same `reportingStatus`.
- **The form**: a *Status* block at the top, two checkboxes, *Unlisted* and *Exclude from reporting* (disabled while the management record loads or could not be read).

### 31.3 Unlisted

- **Stored** as `property_visibility/{propertyId}` `{ schemaVersion: 1, propertyId, unlisted: true, setAt }` (`server-visibility.ts`), existing only while the property is unlisted: listing it again deletes it, by its ID, in a transaction that checks the property exists. Never a field on the property document.
- **Routes**: `PUT /api/admin/properties/[id]/visibility { unlisted }` (session, cross-site, media type, ID, exactly the one key); `GET /api/admin/properties` → `{ properties, unlistedIds }` (whole documents as the browser read gave them, the flag beside them so the form cannot write it onto one); `POST /api/properties?unlisted=1` creates the property and its mark in one batch.
- **The form** saves visibility first on an edit, so unlisting takes the property off the site before any other change is published; on a create the flag rides on the create.
- **The list** shows an *Unlisted* badge beside the name (the quiet state badge).
- **A defect found while verifying, and fixed:** `revalidateListingPages` called `revalidatePath('/api/property/[id]', 'page')`, which does not reach a route handler's cache: the prerendered JSON kept answering `x-nextjs-cache: HIT`, so an unlisted property's JSON — and, before this, every edit's — stayed stale for the hour. Each write now also revalidates `/api/property/<id>` (the property route's PUT and DELETE, the create, the mirror and the visibility route).

### 31.4 The month as a ZIP

- **Where**: the home's statements panel, for the month shown: *Download <Month>* in its head; while working it says "Reading the month…", "Fetching the files…", "Making the ZIP…", "Saving…"; then "Nubnb 2026-10 October.zip saved: 5 properties, 33 files."
- **`GET /api/admin/month-package?month=`**: reads every property's name, every cost entry, every statement, the month's drafts and download records, the management records; `selectMonthPackage` (`app/lib/backup/data.ts`, pure) decides which properties have a folder and works each unfinished month's statement out with `buildStatement`; answers only the entries the package names, the stored documents for `Records/` with each receipt's Storage path removed, and a 60-second signed link per receipt and statement PDF (paths checked: `receipts/<entryId>/…`, `monthly-reports/<reportId>.pdf`). It records the download before any link leaves: one `report_downloads` per statement in it (`via: 'month-package'`, `REPORT_DOWNLOAD_SCHEMA_VERSION` 2) and one `month_downloads` document; if that fails, no link (502).
- **The browser** (`app/lib/backup/download.ts`) fetches every file from Google six at a time, checks each SHA-256 against Nubnb's record (a counted receipt also against its statement row's `receiptSha256`), refuses the ZIP and names the file on any mismatch or failed fetch, builds the files with `buildMonthPackage` (`package.ts`, `workbooks.ts`, `names.ts` — the backup's own builder), zips them and saves.
- **The workbook core**: `app/lib/xlsx/core.ts`, lifted from `costs/xlsx.ts` as `pdf/core.ts` was; the ledger workbook is byte-identical before and after (12,442 bytes, SHA-256 `3d2a51df…` both). `costs/zip.ts` sets the UTF-8 flag on names beyond ASCII only, so every existing archive is unchanged.

### 31.5 My decisions, not rulings

The visibility mark in its own collection, deleted on re-listing, rather than a field on the property; the standing word "Excluded from reporting", and an excluded property leaving the home panel even when it has a statement or a draft; an unlisted slug answering like an unknown one (the page's existing "no longer available"), not a 404; booked dates' unlisted 404 cached ten minutes; `list` refused to everyone in the rules; the guests page on the server summaries; the Status block at the top of the form; the ZIP button in the statements panel; the download recorded when the links are minted, as for a PDF link; year workbooks left to the mirror; the ZIP's files built by the same module the mirror will use; the revalidation fix.

### 31.6 Verification (2026-10-03, 17:55–18:12 Z)

On a production build of this tree (`KFJnk5ZvwRDTdw93XZCTY`, then `LctulHFRrloj0hjWxa2fa` after the revalidation fix) on 127.0.0.1:4500 reading production data, with a throwaway admin PIN and session secrets. Opening export `backups/2026-10-03T17-55-45Z` (77 documents), Storage 4,640 live objects.

- **Pure**: 19 checks of exclusion through the reporting rule (status, tile counts, panel rows and line, loose ends, the property page, the record's reader); a made-up month with a finished statement (earlier-month cost, handyman work, office cost, an adjustment, a correction after finishing), a draft, a rejected and a pending entry, an excluded and an empty property, a name with `/` and `é`: two folders, the right not-charged entries, no Storage path in the data; the ZIP passing `unzip -t`, unpacked by `ditto` with its names intact, `shasum -a 256 -c` OK on every file, the 15 non-ASCII names flagged UTF-8 and no ASCII one; the corrected entry shown as printed ($9.02, "Checked: Yes").
- **Excluded** (Bright Guest Suite Near Yonge St, through the form): the record `excludedFromReporting: true`; the tile from "September 2026: 46 due" to "45 due"; the panel from "0 of 46 … 46 due" to "0 of 45 … 45 due", the property gone from its rows; the list's cell "Excluded from reporting", the list still 46 rows; its page loading with the head "Excluded from reporting". Unticked through the form: record cleared (`record: null`).
- **Unlisted** (CN Tower Boutique Suite, through the form; visibility saved before the property): homepage, its page, `/api/property`, `/api/properties` without a session, booked dates and the guests page all lose it (404s, 0 IDs in the HTML; the homepage 45 of 46 IDs); `/api/properties` with a session 200; the admin list, the cleaner app's start (a `__TEST__` cleaner) and the availability read keep it; City Skyline Panoramic Views, listed, unchanged on every path. The JSON route fixed and proven: 404 MISS/HIT while unlisted, 200 on listing again, 404 on unlisting again. **Rules** (Firebase Rules API, nothing deployed): new rules refuse the unlisted get and the list, allow a listed get; the deployed rules allow both, and production's REST read of the unlisted document answered 200 — the refusal takes effect when the rules are deployed. Unticked through the form: mark deleted, every path back.
- **The ZIP** (`__TEST__` data on Cozy 1 Bedroom Basement Suite in Prime Location, October): two real JPEGs through the cleaner route (auto-approved), one rejected, an office cost, a draft, a finished statement (`JnOKM79i…`, $195.95, PDF SHA-256 `5f53ec48…`). The panel's button made `Nubnb 2026-10 October.zip` (437,922 bytes, 33 files, 5 property folders: the test statement and Kian's four October drafts, read only). `unzip -t` clean; `shasum -c` OK on all 27 checked files; the PDF's hash equal to the one recorded at finishing; both receipts byte-identical to the files uploaded; the Statement sheet line for line with `pdftotext` of the PDF; tax apart on each cost; the office cost "No receipt: entered by the office"; the excluded property "Excluded from reporting" in fee income; the cleaner's name in Nubnb's Not charged only, never in the owner's folder; both workbooks opened in Microsoft Excel. One receipt altered in transit: "The receipt of entry PcQqUH is not the file Nubnb recorded … No ZIP was made", no file saved.
- **Cleanup by ID**: the statement through its delete route (its PDF and both `report_downloads`), the three entries through theirs (receipts and send records), the cleaner through the Team route, then by exact ID the reopened draft, both `month_downloads` and the test code's `cleaner_codes` document. Closing export `backups/2026-10-03T18-12-07Z`: 9 of 10 files byte-identical; `properties.json` differs only by "Lower Penthouse Corner Unit" (`R7ZIkNtHLjub4rYZ0dAm`), created at 18:05:42 Z through the production admin, not by this work; all 46 existing property documents unchanged. Storage 4,705 live objects: the 65 new ones are that property's mirrored images; no receipt or statement PDF live.

## 32. A property owes statements from the month it was added (2026-10-03)

Kian's dispatch of 2026-10-03: "a property owes statements from the later of September 2026 and the month its document was created, using Firestore's own create time. A property added in October owes nothing for September. A management record's start month still narrows further." The ruling is in `CLAUDE.md` under *Statements*, as Kian's ruling of 2026-10-03 superseding the one of 2 October that a property with no record owes every closed month.

- **The rule** (`statementMonths`, `app/lib/reports/model.ts`): the first month owed is the latest of `STATEMENTS_FROM_DEFAULT` (2026-09), the property's created month and its record's start month; the record's end month and *Exclude from reporting* are unchanged. `inStatementScope` takes the created month, so every caller of the one rule follows: the status (`reportingStatus`, `reportingStatuses`, the tile's counts), the panel's rows (`trackerRows`), the property page's months and head (`propertyMonths`, `propertyMonthState`), and the month ZIP's standings (`selectMonthPackage`).
- **The created month** (`app/lib/firebase/created-month.ts`, `createdMonthOf`): the document's `createTime`, which Firestore returns on every read, a `select()` or a field mask included, and which nothing in Nubnb can write. It reaches the browser three ways: the tracker's properties (`listCosts`' name lookup, `createdMonth` beside each name), `GET /api/admin/properties` (`createdMonths`, by ID), and the property page's read (`readPropertyStatements`, through `propertyFacts`). The month ZIP's route reads it itself.

### 32.1 My decisions, not rulings

- **The Toronto calendar**, as for every month in the reports: a property created at 2026-10-01T03:30Z was created on 30 September.
- **An unknown create time leaves September 2026** (the old rule): a property ID the reports know but the collection no longer holds, or a read that did not carry the month. Never narrower than what is known.
- **A record's start month only narrows.** Before, a record's start month replaced September 2026, so one set earlier widened what was owed; now nothing starts before the later of September 2026 and the created month. On production (export `backups/2026-10-03T18-47-59Z`) both records start 2026-09, on properties created before September: neither changes.
- **The statement and the loose ends do not take the created month.** `buildStatement` and `looseEnds` use the first month (September 2026, or a record's later start) only to bound the earlier months whose sent costs a statement carries; no cost can be sent for a property before it exists, so the created month would change nothing there, and `buildStatement` runs in the browser and again at finish, where both must make the same claim.
- **The admin home joins the two reads' months** as it already joined their IDs, so a property added since either read still has its created month.

### 32.2 Verification (2026-10-03, 18:52–18:58 Z)

Production builds on 127.0.0.1:4500 reading production data, with a throwaway admin PIN and session secrets: `c7ebb36` for *before*, this tree (`gN5bOncOZKmPeOFXlegCR`) for *after*.

- **Pure**: 20 checks of the rule (the created month against the default and a record, scope, the status, the tile's count, the panel's rows, the property page's months, the Toronto boundary), and the 19 exclusion checks of §31.6 again: all pass. `tsc` exit 0; `eslint` 0 errors (the two warnings in `app/admin/page.tsx` are older).
- **Production's properties by created month**: 39 in March, 2 in May, 2 in August, 3 in September (21 and 26 September), 4 on 3 October (18:05, 18:37, 18:45 and 18:51 Z).
- **Before**: tile "September 2026: 50 due · 0 finished"; panel "September 2026 · 0 of 50 statements finished · 50 due · 2 drafts in progress", 50 rows; the list's Statement column 50 × "Due September".
- **After**: tile "September 2026: 46 due · 0 finished"; panel "0 of 46 … 46 due · 2 drafts in progress", 46 rows, none of the four added on 3 October; the list 46 × "Due September" and 4 × "Open, not yet due" (Lower Penthouse Corner Unit, 2 Bedroom Condo Quiet Neighborhood Free Parking, Queen Bachelor Fully Private, Queen Bed Studio Fully Private; tooltip "Open, not yet due: October 2026"). CN Tower Boutique Suite, created 26 September, still reads "Due September". Lower Penthouse Corner Unit's page: head "Open, not yet due · October 2026", its months only "October 2026 · open, not yet due".

## 33. Income from the platforms: the Income page (dispatch 27, 2026-10-04)

Kian's dispatch 27, its amendment and his rulings on the report (all 2026-10-04): admins upload Airbnb's monthly transaction CSV on an Income page beside Costs; each row proposes a line to the property its listing title is linked to; an admin accepts (as it is or edited) or rejects it, and an accepted line becomes an ordinary line of the property's statement draft. The rulings are in `CLAUDE.md` under *Income*. The file it was built from is `~/Downloads/airbnb_09_2026-09_2026.csv` (SHA-256 `68093638…46400`): the co-host account's September 2026 report, 71 rows × 21 columns, every row dated by its payout day; it stays out of the repo (guest names).

### 33.1 What is stored

Three root collections and a Storage prefix, all server-only (firestore.rules' catch-all and storage.rules' deny-all cover them; neither file changed, so nothing needs deploying):

- `earnings_uploads/{autoId}` — `platform`, `month`, `file { name, kind: "csv", bytes, sha256 (the original), storagePath, storedBytes, storedSha256 (the kept copy), blanked: ["Guest","Details"] }`, `read { by: "csv", rows, payoutRows, lineRows, amountCents, paidOutCents, balanced, unbalanced[] }`, `titles [{ title, rows, amountCents }]` (the month's rows), `added`, `duplicates`, `outsideMonth [{ month, rows, amountCents }]`, `notRead [{ row, type, amountCents, why }]`, `uploadedAt`, `actor`.
- `earnings_lines/{sha256("airbnb|code|payoutDate|type|amountCents")}` — `uploadId`, `fileRow` (spreadsheet numbering, header = 1), `payoutDate`, `month`, `type`, `confirmationCode`, `listingTitle` (NFC, spaces collapsed, trimmed), `stay { start, end, nights }`, `amountCents`, `currency`, `evidence { grossCents, serviceFeeCents, cleaningFeeCents }`, `remittedTaxCents`, `status` (proposed · accepted · rejected), `decided` (accepted: `{ at, actor, propertyId, draftId, lineId, description, amountCents, edited }`; rejected: `{ at, actor }`), `history [{ at, actor, action, propertyId? }]`. The document ID is Kian's duplicate rule: a row already stored is never written again.
- `earnings_title_links/{sha256("airbnb|title")}` — `title`, `propertyId`, `linkedAt`, `actor`, `history [{ propertyId, linkedAt, actor }]` (earlier links).
- `earnings-uploads/<uploadId>/<uuid>.csv` — the file with Guest and Details emptied, every other cell as uploaded, BOM and line endings kept; create-only, no download token, metadata `{ uploadId, platform, month, originalName, sha256, storedSha256, blanked, uploadedAt }`. Read through a 60-second signed link (`GET /api/admin/income/uploads/[id]/file`).

**How this differs from the shapes reported before building** (Kian: "Your stored shapes and matching rule stand"): `instalment` is gone (ruling 3 dropped the label); a line has no top-level `propertyId` — the property is its title's link, read live, and `decided.propertyId` records where an accepted line went; a link has no `lastSeen` — the Income page works it out from the uploads' titles; an upload's titles carry no `propertyId` for the same reason; the kept copy's size and SHA-256 sit beside the original's (ruling 1); a line keeps a `history`, which "propose again" needs.

### 33.2 Reading the file (`app/lib/income/airbnb.ts`, `csv.ts`)

RFC 4180, strict. Needed columns by Airbnb's names: Date, Type, Confirmation Code, Start date, End date, Nights, Listing, Currency, Amount, Paid out; Gross earnings, Service fee, Cleaning fee and Airbnb remitted tax are kept when present. Dates are MM/DD/YYYY; amounts are read by their digits, never through a float. Each Payout row starts a batch and the rows after it until the next payout are its rows. A file with a missing column, a field count that differs from the header, or a date or amount not in Airbnb's form is refused whole, with the rows named.

### 33.3 My decisions, not rulings

- **The whole label is the line's description, with no dates on the line.** The statement prints a description and then " - " and its dates; Kian's "(paid Sep 30)" comes after the dates, so a line with dates could not print it. Every line from a file is "description, quantity 1, rate = amount": "Revenue - Apr 29–Dec 31, 2026 (paid Sep 30)" prints exactly. "Runs outside the month" is judged on the two printed days (check-in, checkout).
- **The month is the upload's, chosen on the page; rows paid in another month are counted on the upload, never stored**, so that month's own file proposes them (a row stored from the wrong month's upload would later read as a duplicate). A file with no row in the month is refused, naming the months it covers.
- **The same file twice is refused** by its SHA-256 (409, nothing stored); a different file holding the same rows stores nothing new and counts them as duplicates, and a row repeated within one file is one line.
- **A file that does not add up is taken and flagged**, not refused: the upload names each payout that differs from its rows, and rows under no payout. Rows of a type that is not a line, with no amount, no confirmation code, no listing, or a currency other than CAD are listed as not read, with why; they still count in their payout's check.
- **Accepting into a month with no draft starts one as the property page starts one** (`suggestedTyped`): the reference offered from the previous statement, today's date, the fee rate offered with no base (dispatch 26), no balance, no notes. A month whose draft was finished — or, with no draft, which has a current statement — refuses (409 STATEMENT_FINISHED); during a correction the draft is a draft and takes lines. The draft is written in its own revision-checked shape, so a property page open on it gets DRAFT_CHANGED on its next save and reloads.
- **Propose again**: a rejected line, or an accepted line whose statement line has since been removed from its draft (the page lists those apart). A line still in its draft is never proposed again, so it cannot print twice.
- **A link can be moved, never removed**; lines already accepted stay where they went, proposed ones follow it. The link form offers the property whose name is the title when exactly one is; nothing is linked until an admin presses Link.
- **The check-in gap** reads the daily calendar copies (`availability_days`) of the month and the week after it, and counts a `reserved` event that starts in the month as a check-in. "No income" is no line in the property's statement for the month and none proposed under its titles. The page says how many daily copies it read: September 2026 has 4 (30 Sep, 2–4 Oct), so most of September's short stays are not visible to it.
- **By property** lists every statement of the month with lines, as the Income tab adds them up (revenue the positive lines, expenses the negative ones), with how many came from a file; a negative line from Airbnb therefore shows as an expense there, as on the statement. Expenses print as a positive amount ("$50.00 expenses"), here and on the Income tab (Kian, 2026-10-04).
- **The property page** reads the property's lines from the files beside its two reads, never holding the page up: an accepted line is marked "From <file> · row n" in the Income tab, and the month's lines still waiting are counted with a link to the Income page.
- **Limits**: 2 MiB a file, 400 rows for the month per upload (everything an upload writes is one transaction).
- **Not built**: deleting an upload; removing a link; the PDF/image/AI path (ruling 2); mobile layout.

### 33.4 Verification (2026-10-04)

A first pass (21:05 Z) checked the reader, the labels and the upload; it stopped before any decision, and its test data was deleted by ID at 21:44 Z (export `backups/2026-10-04T21-45-14Z` byte-identical to its opening `21-04-56Z`, Storage back to 5,265 objects). The second pass, 21:56–22:03 Z, used a production build of this tree (with §34's rule) on 127.0.0.1:4610, reading production, with a throwaway admin PIN and session secrets, and fresh test data: Kian's September file uploaded as `__TEST__airbnb_09_2026-09_2026.csv`.

- **Upload**: 201, 71 rows, 50 lines added, 21 payouts adding up to $37,721.37.
- **Links**: three titles linked by `PUT /api/admin/income/links` (Sunlit House With Southern Charm, 2 Bedroom Condo Quiet Neighborhood Free Parking, New Build Cottage By River l Hot Tub). A stale `expected` was refused with 409 LINK_CHANGED, and an unknown property with 404. Kian's three titles stayed unlinked.
- **Decisions on Sunlit House**:
  - Row 6 was accepted as it was.
  - Row 16 was accepted edited ("… __TEST__ edited", $300.00), and stored with `edited: true`.
  - Row 70 was rejected, proposed again and rejected again (its history reads rejected > proposed-again > rejected).
  - Proposing row 6 again was refused with 409 STILL_IN_STATEMENT.
  - The draft holds exactly the two accepted lines ($219.95 and $300.00). The 10 proposed lines and the rejected one are not in it.
- **2 Bedroom Condo** (created 3 October): its one line was accepted. Under §34's rule, September became owed:
  - the tile went from "36 due" to "37 due";
  - the panel went from 36 rows to 37;
  - the list's Statement column reads "Due September";
  - the property page's head reads "Due · September 2026";
  - the month ZIP route lists it as due, with a draft folder of 1 line.
- **New Build Cottage**:
  - Rows 15, 29, 41, 60 and 62 were accepted in one call; rows 68 and 72 were left proposed.
  - Finishing with no reference was refused with 422 STATEMENT_INCOMPLETE `missing: reference`. With a `__TEST__` reference it finished (201): 5 lines, payable $2,017.58.
  - Accepting row 68 was then refused with 409 STATEMENT_FINISHED, and the row stayed proposed.
  - The PDF fetched through its 60-second link matched the record's size and SHA-256 (25,598 bytes). Its text prints the 5 accepted lines and none of rows 68 or 72.
  - Deleting the statement through the app was refused with 409 DOWNLOADED_SINCE while it named 0 downloads. Naming 1, it deleted the report, the PDF and the download record, wrote no management record, and reopened the draft with its 5 lines, which then took row 68.
- **The same file again** was refused with 409 FILE_ALREADY_UPLOADED, naming the first upload. The same rows with CRLF line endings were taken as a new upload: 0 added, 50 duplicates, and every decision kept.
- **Guest data**: 0 of 43 guest names, 0 of 7 Details values and 0 of 1 payout destination were found anywhere searched after the decisions:
  - every file of the export `backups/2026-10-04T21-59-31Z`;
  - both kept CSVs, each matching its `storedSha256`;
  - the statement PDF's text;
  - the Income page's API answer.
  The same search over the original file finds all 43, 7 and 1.
- **In a browser**: `/admin/income?month=2026-09`; New Build Cottage's page, where every line is marked "From … · row n", "1 line from the Airbnb file to review" is shown, and the live preview holds the 6 lines; 2 Bedroom Condo's page; and the home list.
- **Cleanup**: 59 documents and 2 objects were deleted by ID from the ledger. The closing export `22-03-25Z` is byte-identical to the opening `21-56-06Z` in 10 of 10 files, and Storage holds 5,265 objects, the same names as before.

## 34. A month with money in it is owed whenever the property was added (2026-10-04)

Kian's ruling of 2026-10-04 replaces the created-month part of the owed-months rule for months with money: "a property owes a statement for any month in which it has accepted income or approved costs, regardless of when it was added. A management record's end month still stops it." It is in `CLAUDE.md` under *Statements*.

- **The rule** lives in `app/lib/reports/model.ts`:
  - `statementMonths(management, createdMonth, moneyMonths)` and `inStatementScope(…, moneyMonths)`.
  - A month before the created month is owed when it is in `moneyMonths`.
  - `from` reaches back to the earliest such month.
- **The months with money** come from `moneyMonthsByProperty(drafts, entries)` in `statement.ts`, which every caller uses:
  - the tracker's read (`readTracker` puts `moneyMonths` on each property), and with it the list's column, the tile, the panel and the home page's join;
  - the property page, from its own drafts and costs reads, so it follows a line added or removed without a reload;
  - the month ZIP (`selectMonthPackage`), from the month's drafts and every entry.
- **Unchanged**: with no money anywhere, old and new answer identically in 350 cases (pure). `buildStatement` and `looseEnds` still bound earlier costs by the first month alone (§32.1).

### 34.1 My decisions, then Kian's confirmation

Kian confirmed the first and third readings on 2026-10-04: "September 2026 and a record's start month still apply to money months; accepted income is any line on the month's draft, typed or accepted, negatives included." Both are now in `CLAUDE.md` under *Statements*. The rest are still my decisions.

- **Accepted income is a line on the month's statement draft.** It may be typed by an admin or accepted from a platform's file. A line proposed from a file is on no draft and counts for nothing. Any line counts, negative ones included: an expense typed on the Income tab, or an Airbnb adjustment.
- **Approved costs are entries whose status is `approved`**, auto-approved ones included, counted in the Toronto month they were sent (`sentDay`), the month the ledger and the statement put them in. Pending, rejected and removed entries do not count.
- **September 2026 and a record's start month still bound it.** The ruling replaced only the created-month part, so a month with money before September 2026, or before a record's start month, is still not owed. *Confirmed by Kian, 2026-10-04.*
- **Excluded from reporting still wins**: an excluded property owes nothing, money or not.
- **The status of a property whose record has ended** names the last month that was owed. Before, it named the end month, which can now be a month that is not owed (after the money, before the property was added).

### 34.2 Verification (2026-10-04)

- **Pure**: 24 checks of the new rule pass:
  - money months from drafts and entries, with the Toronto boundary: 2026-10-01T03:30Z counts for September;
  - the rule month by month, including a month between money and the created month, money before September 2026, a record's end and start, and exclusion;
  - the status, the panel's rows, the tile's counts, the property page's months and the month ZIP's standings;
  - 350 cases with no money, identical to the code before.
- **Checks**: `tsc` exit 0; `eslint` 0 errors (the two warnings in `app/admin/page.tsx` are older); `next build` passed (`Kj6O_mSqvgHoZcvH0ikFe`).
- **On production data**: §33.4. Before any test write, 45 properties gave "September 2026: 36 due · 0 finished", and the only property with money was Corner Penthouse (created in March), so the rule changed nothing. Accepting September income for 2 Bedroom Condo, created 3 October, made it due: "37 due".

## 35. The property pages: create and edit on their own pages (dispatch 30, 2026-10-10)

Kian's rulings of 2026-10-10 are in `CLAUDE.md` under *Property pages*: creating and editing happen on their own pages, not in a pop-up; and the admin uses no native browser controls on these pages — no native selects, date or file pickers, checkboxes, validation bubbles or confirm dialogs. The dispatch asks for a layout built to hold more sections later without redesign, proposed before building, with a sketch. This section is that proposal, written before the build; §35.4 onward records what was built and how it was checked.

### 35.1 The design plan (written before building)

**What the pages are.** Two addresses under the admin: `/admin/property/new` and `/admin/property/edit?id=…` — the edit page takes the ID in the query, as the property page does, so both are static client pages and cost the server nothing per property. Both sit behind the PIN gate, under the one admin header, in the admin's dark language. The audience is the admin on a desktop (mobile is out of scope by the dispatch); the job is to create a property from an Airbnb import and a map link, or to change one thing on an existing one, without hunting and without losing work.

**Palette.** The admin's own: ground `#0a0a0c`; a surface at `rgba(255,255,255,.025)` with a `rgba(255,255,255,.08)` border; text `#f0f0f0`, muted at 55% and 40%; the brand blue `#6599CD` for focus and for "something to act on"; the three state tones every admin page already uses — amber `#f0a63a` for missing and unverified, red `#ef5350` for refused, green `#6ee7a0` for complete. Nothing new is added to the palette: these pages must read as the same admin as the property list and the property page.

**Type.** Manrope throughout, as the admin. The page title 22 px/700 (the property page's); section names in the rail 13 px/600; field labels 11 px/600 muted, in the admin's uppercase block-title style; inputs 13 px; counts in tabular numerals. One family, a clear scale, no second face.

**Layout.** Under the header, a head line, then two columns: a sticky rail on the left (236 px) and one section panel on the right (at most 880 px wide), left-aligned.

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ NUBNB Admin   Properties  Leads  Costs  Income  Team  Availability   View Site ↗    │
│                                                        ● Unsaved changes   [ Save ] │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ← Properties                                                                        │
│ 7000 Sqft Estate   Unlisted                        Property page →   View on site ↗ │
├──────────────────────┬─────────────────────────────────────────────────────────────┤
│ IMPORT               │  Photos                                   Missing: 2 photos  │
│   Airbnb             │  ┌───────────────────────────┐  Gallery · 4                 │
│                      │  │                           │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ │
│ LISTING              │  │        cover photo        │  │    │ │    │ │    │ │    │ │
│ ● Photos          2  │  │                           │  └────┘ └────┘ └────┘ └────┘ │
│ ● Basics          ✓  │  └───────────────────────────┘  ┌────┐                      │
│ ● Location        3  │  Change cover                   │ +  │  Add photos          │
│ ● Space & price   ✓  │                                 └────┘  or drop them here   │
│ ● Highlights      1  │                                                             │
│ ● Offers          ✓  │                                                             │
│ ● Rules           ✓  │                                                             │
│   Reviews            │                                                             │
│                      │                                                             │
│ NUBNB ONLY  🔒       │                                                             │
│   Status             │                                                             │
│   Cleaners           │                                                             │
│   Statements         │                                                             │
│   Calendar           │                                                             │
└──────────────────────┴─────────────────────────────────────────────────────────────┘
```

- **The rail** lists every section in three groups: *Import* (the Airbnb listing), *Listing* (what the public sees: Photos, Basics, Location, Space & price, Highlights, Offers, Rules, Reviews) and *Nubnb only* (what the public never sees: Status, Cleaners, Statements, Calendar). Every section is one click away. Each row carries its state at the right edge: a green check when the section is complete, an amber count of what is missing, an amber "n to check" after an import left fields defaulted or unread, a red "n refused" after the server refused fields. A section with nothing to check (Reviews, the internal ones) carries no mark. The *Nubnb only* group is set apart by its label and a lock mark, and its panels say in one line that nothing in them reaches the public site.
- **One section shows at a time.** The right column holds the chosen section's panel: its name, its missing fields named in words in the panel's head ("Missing: City, Area"), then its fields in a flat grid. The chosen section is mirrored in the address bar (`&section=location`), so a reload keeps it. On Save, the first missing required field's section opens and the field is pointed at, as the dispatch-29 accordion did.
- **One place to save.** Save is the page's action in the header, where every admin page keeps its action, and the header is sticky: it is reachable from anywhere on the page. Beside it, the state: nothing while the page holds what is stored, an amber "Unsaved changes" once anything differs from what was loaded, and a quiet "Saved" with the time after a save. Cmd/Ctrl+S saves too.
- **Leaving asks first.** A click on any link that leaves the page — the header's sections, the brand, Back to properties, the property page — with unsaved changes opens Nubnb's own dialog: *Leave this page? Your changes to 7000 Sqft Estate are not saved.* — **Stay** · **Leave without saving**. The browser's own leave prompt is a native confirm dialog and is therefore not used; instead the unsaved changes are kept in the tab's session storage and restored when the same page is opened again in that tab (after a reload, or the browser's back and forward), with a bar saying so and a Discard control. Closing the tab loses them: see §35.3.
- **Photos as a section of their own.** The cover large on the left, the gallery as a grid beside it; each photo can be made the cover, moved earlier or later, or removed; new ones come in through Nubnb's own Add photos control or by dropping files on the gallery. Nothing about a photo is an afterthought in a form row.
- **Built to grow.** A section is a rail entry and a panel; adding one is adding both. The rail has room for many more rows before anything moves.

**Principles.** One section on screen at a time; the rail says what is missing, in a count, and the panel says it in words; a state appears once; the internal fields are visibly set apart; photos first; no decoration and no motion except the dialog's own appearance; every control Nubnb's own.

**Reviewed against the defaults.** The generic version of this page is the "SaaS card kit": every field group its own rounded card with the same shadow, a wizard with numbered steps, all-caps eyebrows over each. Two things were changed on that review. First, there is one panel, not a card per group; the rail is plain rows with a mark, not cards. Second, the sections are not numbered: editing is not a sequence, and a new property is imported first and then reviewed in whatever order the marks suggest. What is kept on purpose: the uppercase 11 px labels, because they are the admin's established language on every other page and the brief asks for the current design language throughout. The one bold element is the Photos panel; everything else stays quiet.

### 35.2 What stays from dispatch 29

Everything: offers edited in place, their categories (the property's own and the standard list), availability and stars by the same rules in `offers.ts`, highlights and house rules edited in place, a missing field opening its section, the Airbnb import with its per-field provenance, Get Location, the price-conflict warning, the server-refused fields pointed at, the images mirrored after the save. An imported property opened and saved untouched writes a document byte-identical to what was stored: the page reads the exact stored document through a new admin read (the public single-property read folds the mirrored URLs in and drops the stored fields, so it cannot be used for this), and sends it back by the same rules as before.

### 35.3 My decisions, not rulings

- **The edit page's address is `/admin/property/edit?id=…`**, the ID in the query like the property page's, so the page is static.
- **One section at a time**, the rail as tabs, the chosen one in the address bar.
- **Save lives in the header**, enabled whether or not anything changed (a save with no changes re-runs the image mirror, and is how an untouched save is exercised).
- **The browser's leave prompt is not used**: it is a native confirm dialog. Unsaved changes are kept in the tab's session storage and restored on return to the same page in the same tab, only when the stored document is still what it was when they were typed. **Consequence: closing the tab with unsaved changes loses them.**
- **File choosing.** The ruling's "file pickers" is read as the browser-drawn file control: none is shown. The control is Nubnb's own button and drop zone; the system's file chooser that opens on a click is the operating system's dialog, not a browser control in the page.
- **Numbers are typed into text fields** with a numeric keyboard, no spinners; **months** (statements from and until) are chosen from a month select, not the browser's month picker.
- **Weekly, monthly and weekend prices no longer count as missing**: no surface shows them (an accepted state), and the type's own comment names the pressure the old `required` put on an admin. **Bedrooms at 0 no longer counts as missing**: a studio has none. Everything else keeps the dispatch-29 counts.
- **After creating**, the page becomes the new property's edit page (the address is replaced) and says "Created".
- **The property list's Delete keeps its browser confirm**: the list is not one of these pages.
- **The modal (`PropertyForm.tsx`) and `CustomSelect` are removed**; `AdminSelect` gains a placeholder for a field with nothing chosen yet.

### 35.4 What was built (2026-10-10, evening)

- **Two pages**: `app/admin/property/new/page.tsx` and `app/admin/property/edit/page.tsx` (`?id=`), both static client pages behind the PIN gate, both rendering `editor/PropertyEditor.tsx`. The list's Add Property and each row's Edit are links to them; the property page's header has "Edit property"; the edit page's head has "Property page" and, for a listed property, "View on site".
- **The editor** (`app/admin/property/editor/`): `model.ts` (the sections, the draft, the missing-field rules, the save payload rules carried over from dispatch 29, the kept-draft helpers), `controls.tsx` (field, text, number, switch, tick, dialog, action bar), `shared.tsx` (what every section is handed; the panel head; a list row), `row-edits.ts` (the dispatch-29 in-place editing of offers, highlights and rules, as a hook), `sections-listing.tsx`, `sections-offers.tsx`, `sections-internal.tsx`, `sections-import.tsx`, `editor.module.css`.
- **An exact admin read**: `GET /api/admin/properties/[id]` answers `{ property: { id, ...doc.data() }, unlisted, createdMonth }`; `getAdminProperty` in `app/lib/firebase/properties.ts` calls it. The public single-property read is unchanged and unused here.
- **`AdminSelect`** gained `placeholder`, `invalid` and `disabled`. A value that matches no option is shown as it is: every one of the 60 stored properties holds `addressDetails.state: "ON"`, which the province list spells "Ontario", and the first build showed those as unset.
- **Gone**: `PropertyForm.tsx`, `PropertyForm.module.css`, `CustomSelect.tsx`, `CustomSelect.module.css`. The list no longer holds a modal; its "/" shortcut no longer waits on one.
- **After a save, the document is read again** and the image mirror's two fields (`coverImageStored`, `imagesStored`) are taken from it, so the page holds what the server holds and the next save sends them fresh rather than stale (dispatch 28 found them sent back stale). They take no part in "has anything changed" or in the kept draft's fingerprint: the first build counted them, and a reload after a save that reordered photos dropped the kept draft as "changed since".
- **The price grid**: the shortest stay on its own row, the two stored-only prices together under a rule.

### 35.5 Verification (2026-10-11, 00:05–00:24 Z, on 127.0.0.1:4500, throwaway PIN, under a write guard)

The guard (`guard-preload.cjs` in the scratchpad) let through only a `properties` create named `__TEST__…`, that property's marks in `property_visibility`, `property_cleaner_names` and `property_management`, updates to it and to the untouched-save property, deletes of it, and Storage objects with `__TEST__` in their name or under its mirror prefix; everything else throws. It recorded every write (68 lines).

- **Checks**: `tsc` exit 0 (the only errors are the stale `.next/types` of the repo's old build, which name the removed Fund page); `eslint` 0 errors in the new code (the remaining errors are in `IconPicker.tsx`, unchanged by this dispatch; the two older warnings in `app/admin/page.tsx` stay); `next build` passed three times (`jJRgNCnDHZ07Bf8gOQ_B8`, `BsTanAqgvAzyxbXqsBlBu`, `IwpITSk3OHrkOWNF52meW`).
- **Every section reachable, every control Nubnb's own**: an in-page audit on every section of both pages found 0 visible native controls, no `required` attribute, no `<form>`; the only native elements are the two hidden file inputs behind Add cover photo / Add photos; `window.confirm`, `alert` and `prompt` were patched to throw and were never called; the browser captured no dialog in the whole session.
- **A `__TEST__` property created Unlisted through the new page** (`H3P4r0gYsswGiGRO13tn`, 00:09:43 Z): title, display location, type, tag, description, coordinates, address, check-in and -out, capacity, prices, two highlights, two offers (one starred), pets allowed, a house rule, a name for cleaners, Report For and a fee rate, a cover and two gallery photos. Read back: 27 fields, `price` 150 = `priceInfo.nightly`, slug `test-d30-property`, no `airbnbUrl`, `googleMapsUrl` or `icalUrl` key, the unlisted mark, the cleaner name and the record (rate 2000 basis points) all stored; the mirror had written the stored URLs.
- **Edited through the edit page** and saved: the title, the price (175 in both fields), photo 1 moved later and photo 2 made the cover (read back: cover = gallery 1, gallery = old cover, gallery 2), Hot tub unticked (read back under "Not included", not available), a highlight deleted, a rule edited in place, excluded from reporting, an owner added. The ledger shows one `update` of 27 fields, one `set` of the record, the mirror's variants and its 2-field update.
- **Deleted by document ID through the admin API**: the cleaner name and the record cleared first (their routes refuse once the property is gone), then `DELETE /api/properties/{id}`, which removed the document and its mark. Read back: none of the four exist. Its 15 Storage objects (3 uploads and 12 variants, every one named `__TEST__`) deleted by exact path with `ifGenerationMatch`; each confirmed gone.
- **An imported property saved untouched**: 7000 Sqft Estate (`gjAUvPari3oiYaedJ2CX`) opened on the edit page and saved with no change. Its document is byte-identical: 50,973 bytes before and after, the same key order and values; `updateTime` still 2026-09-21T04:58:32.593Z; its side documents unchanged. The ledger shows the 30-field update and the mirror's 2-field update, no Storage write.
- **Every other document byte-identical**: the closing export `2026-10-11T00-20-44Z` equals the opening `2026-10-11T00-05-51Z` in all 13 files (`cmp`), SHA-256 `9ece169a…cdd27dc` for both.
- **Storage restored**: 6,623 objects before and after, the same names and generations.
- **Also exercised**: the leave dialog (Stay keeps the page; Leave without saving goes to the list and forgets the kept changes); a reload with unsaved changes restores them with the bar, and Discard returns to what is stored; Save on an empty new property names the 11 required fields, opens Photos and focuses Add cover photo, with "Required" under each empty field; Get Location on a Google Maps link filled the coordinates and the address (Toronto, ON, Harbourfront-CityPlace, Canada); the Airbnb import, which only `next dev` can run (it needs the system Chrome), on a read-only dev server on 4510: 21 of 23 fields read, the cover and 25 photos, 52 offers in 13 categories with 6 stars, 3 highlights, 9 rules, the price left for the admin, Reviews marked "1 to check".

### 35.6 Found, not changed

- **Deleting a property leaves its cleaner name and its statements record behind.** `DELETE /api/properties/[id]` removes the document and its unlisted mark (dispatch 29) but not `property_cleaner_names/{id}` or `property_management/{id}`; the test cleared both through their routes before deleting. The old modal had the same gap. Not changed here: the delete route is not one of these pages.
- **Every stored province is "ON"**, written by Get Location, while the province list offers full names; an admin who re-picks stores "Ontario". The list is the dispatch-29 form's; the page now shows the stored value rather than hiding it.
- **The `IconPicker.tsx` lint errors** (a setState in an effect; two unescaped quotes) predate this dispatch.

### 35.7 The bento pass (2026-10-10, late evening; Kian: "keep it like this, make the UI a little more like a bento grid; the right side full width, the left side its own container and clean navigation")

- **The rail is a card**: its own rounded container, 252 px, sticky, the three groups divided by rules, an icon on every row (Link2, Image, Home, MapPin, BedDouble, Sparkles, ListChecks, ScrollText, Star, Eye, Brush, FileText, CalendarDays), the open row filled, the mark at the right edge.
- **The section fills the page.** The 880 px cap and the panel's own card are gone. The section's head is a plain row (its name, its missing fields in words), and under it a twelve-column bento of tiles, each a rounded container with a small title row. Tiles differ in width on purpose: Photos is cover 5 + gallery 7; Basics is the listing text 8 + its kind 4; Location is the map link 8 + coordinates 4, then the address 8 + the times 4; Space & price is capacity 7 + **the nightly price 5, the one large figure on the page** (a 56 px input with a dollar sign), then stay and fees 7 + the two stored-only prices 5; Rules is the policy 5 + what is allowed 7 (bare switches in two columns) + the house rules 12; Reviews is the rating as a figure 4 + the reviews 8; Status is one tile a switch; Statements is Report For, Owners, the months and the fee rate, 6 each; Offers is **one tile per category**, 6 wide, flowing densely, with the item count in its head, then Add an item 12 wide. Highlights, Cleaners and Calendar are one tile of 8; Airbnb is the link 12 and, after an import, the report 12.
- **Tiles keep bounded heights**: a long gallery scrolls inside its tile (540 px at most) and the cover grows to fill its tile beside it, between 260 and 520 px, so no tile is left half empty; the category tiles take their own heights.
- Below 1100 px every tile takes the full width; below 960 px the rail becomes a row of chips in its card. Mobile stays out of scope.
- **Checked on build `tFuMEpuFV5IUUJF_TKaFv`** (the one the preview serves; a long gallery measured 540 px tall scrolling over 1,016 px of photos, each 134 px square, the cover 502 px beside it): the native-control audit on every section of both pages is still clean (0 visible native controls, no `required`, no `<form>`, no dialog); nothing but layout changed, so no production write was made and no export was taken.

## 36. Safe to finish: Step 1 of the dispatch 31 plan (dispatch 34, 2026-10-12)

Kian's rulings of 2026-10-12 are in `CLAUDE.md` under *Safe to finish*. What follows is how they were built, the developer's decisions where the rulings leave room, and how it was checked.

### 36.1 What was built

- **The checks** (`app/lib/reports/checks.ts`, pure, one function for the Finish tab, its dialog and the verification): refused only without a Report For name (S20), which the server refuses too (`STATEMENT_INCOMPLETE`, `missing: reportForName`); warned: no fee or a $0.00 fee (S4, S15), a fee label that does not work out to its amount (S7), lines changed since the base was typed (S6), last month closed owing NuBNB and nothing carried (S3), a carried balance whose statement was since corrected or deleted (S2), Airbnb lines waiting or titles in the month's files linked to no property (I1), no cleaning line while the month shows Airbnb checkouts (N4), automatic approvals not looked at (C2), entries still pending (the old confirmation's line), Report For cut short on the PDF (S25), a date before today (S13).
- **The Finish tab** lists them under "Before finishing", one line each with the tab that puts it right; the refusal red, the warnings amber.
- **Finish, Correct and Delete** ask in Nubnb's own dialog (the editor's `Dialog`). The date is Nubnb's own day picker (`DateRangeField single`).
- **The statement PDF** (schema version 4) prints the property and the month under "Payment Summary", and a correction's reason in full above the table. A report of version 3 is drawn exactly as before.
- **Deleting a property** (`server-property-delete.ts`) refuses while it holds drafts, statements, accepted income lines, title links or cost entries, naming how many, and points to Status; otherwise it deletes the property with its unlisted mark, owner record and cleaner-facing name in one transaction.
- **The duplicate check** (`listing-identity.ts`, `server-listing-clashes.ts`): create refuses an Airbnb listing or calendar another property holds (409 `DUPLICATE_LISTING`, at the field); save warns (`warnings` in the answer, shown after Save).
- **The small fixes:** S10, S12, S17, S18, S23, S24, S25 as below.

### 36.2 Decisions, not rulings

- **"One extra confirmation"** is a tick in the Finish dialog, "Finish with these N warnings", which enables Finish and issue. With no warning there is no tick.
- **S6** keeps the month's revenue when the base was typed on the fee (`baseRevenueCents`) and warns when the revenue differs at Finish. A fee saved before, or whose base was never typed on this page, carries none and is not warned about: no guess from base ≠ revenue, since Kian's bases follow several rules. The revenue is shown under the base, never filled in.
- **S7** reads a rate and a base out of the label ("NuBNB 25% Net of $1,000.00") and compares what they work out to with the amount; a label naming no rate and base is not checked.
- **I1** counts every title in the month's files that no link names, whichever property it may belong to: any of them could be this property's money.
- **N4** counts distinct Airbnb reservations (confirmation codes), not rejected, under the property's titles, whose stay ends in the month. A cleaning line is a typed line whose description says "clean". The count is shown in the warning only, never multiplied into anything.
- **S10:** a save sends what reads; a half-typed fee, carried balance or date is sent as it was last saved, the page says "… not saved until complete", and Finish stays blocked naming it. Nothing is written when nothing that reads changed, and a month with nothing stored is not created by a part that does not read (so a misclick on "Add a fee" leaves no empty draft, which would block deleting the property). The typing is kept in the page's memory while another month is open and comes back while the draft is at the revision it was saved against; a reload of the page loses it.
- **S12:** the reason prints above the table as "Correction: …", wrapped to the page width; "Replaces # … dated …" stays at the top right.
- **S17:** the carried balance reads "$359.96 deducted", as the PDF prints the amount.
- **S23:** "<property> - <Month YYYY> - <reference>.pdf", plain ASCII.
- **S24:** the reports' own month word ("Sept", "July") is tried first, then the long, then the short; the next month's word is written in the same style.
- **The property delete** refuses on any draft, not only drafts with lines (Kian's ruling says "drafts"). The list keeps its browser confirm (dispatch 30: the list is not one of the property pages); its words now say what goes with the property.
- **The duplicate check** compares Airbnb room IDs (`/rooms/<id>`, `/calendar/ical/<id>.ics`); a calendar that is not Airbnb's is compared by its address. A calendar for another room than the listing is warned about on create and on save. A save whose check cannot read the properties is saved, with a warning that the check did not run.

### 36.3 How it was checked (2026-10-12, 23:47–23:57 Z)

- **On the copy of 11 October** (the export dispatch 31 audited; the production reset of 2026-10-12 cleared those drafts and that upload), with Nubnb's own code: New Build Cottage warns no fee and "No cleaning line · 5 Airbnb checkouts in September"; Sunlit House warns 16 unlinked titles ($31,498.56); the four drafts the Income page created are refused for no Report For; 7000 Sqft Estate's October warns "September 2026 closed owing NuBNB $4,676.45; nothing is carried" when its September is finished as it stands; a clean statement is silent, and each single change fires its one check.
- **The PDF:** 30 statements of version 3's layout are byte-identical between `2793e84` and this code; a 104-character reason prints in full.
- **The duplicate check** over today's 60 properties finds the two "Cozy Basement In Family Home" records (listing and calendar) and Bright Walkout's calendar (CN Tower's, another room).
- **On a local build** (`8d60SMLmF6MpVtk1uj_-u`, 127.0.0.1:4500, throwaway PIN, a write guard letting through only the test's own writes) against production, on the Unlisted `__TEST__ d34 safe to finish`: a duplicate create refused with nothing written; a duplicate save saved and warned; the refusal on the page and at the route; a half-typed fee leaving the rest of the draft saved and coming back after leaving the month; the Finish dialog's tick; a finished statement whose stored PDF prints the property and the month, downloaded as "__TEST__ d34 safe to finish - October 2026 - Oct-TEST-d34.pdf"; the Correct dialog sending the whole 104-character reason (its save stubbed in the page: a real correction would leave the statement undeletable in the app); the Delete dialog's ruled words and a real delete; the property delete refused while the draft stood, and allowed once the draft was removed by exact ID outside the app (K13), taking its side records with it. 21 writes through the guard, none refused; the opening and closing exports byte-identical (84 of 84 documents); Storage's 6,622 objects identical by name and generation.

### 36.4 Before release (Kian's rulings of 2026-10-12, later the same evening)

- **The property list's Delete asks in Nubnb's own dialog** ("Keep it" first, "Delete property"); the browser's confirm is gone from it. Checked on a build that cannot write (`RXj8VmkaVAX7q3KcItPVM`, read-only preload), the DELETE stubbed in the page: "Keep it" sends nothing, "Delete property" sends one DELETE for that property and shows the answer, and no native dialog opened.
- **A $0.00 fee does not print** on a statement of the dispatch 34 layout (`printedLines`, so the PDF and the month ZIP's workbook agree); a report of version 3 is drawn as stored. 40 statements of version 3's layout, 10 with a $0.00 fee, are byte-identical to `2793e84`. Finish still warns about a $0.00 fee, saying it does not print.
- **Still native, not converted in this release** (Kian asked for the property list; the ruling now covers the whole admin): Team (`cleaners/page.tsx`, three confirms), Costs (`costs/page.tsx`, one; `costs/EntryPane.tsx`, two), the property page's Income tab ("Remove this line?") and Costs tab (download with pending entries), and the property list's unused `handleSeedDatabase`.
- **K13** is now Kian's ruling: records the admin cannot delete may be deleted by exact document ID after an export, never by pattern — as the test's draft was in §36.3.

## 37. Corrections that add up: Step 2 of the dispatch 31 plan (dispatch 35, 2026-10-12)

Kian's rulings of 2026-10-12 are in `CLAUDE.md` under *Corrections*. This section records how they were built (S1, S2, S5, R7), the developer's decisions where they leave room, and how it was checked.

### 37.1 The model: the current statements are a ledger

- **What an entry was charged** is added up over the current statements (`chargedBy`): a cost row's total plus every adjustment's difference. A statement charges only what that leaves. Before, an adjustment compared the entry with its last printing alone, which a redone month made wrong (S1).
- **A redone month** (corrected, or deleted and finished again) prints an entry that later statements adjusted at what is left after those adjustments: what the latest of them printed it as, less what they charged. That is the amount the month first charged, so "reported in September 2026 as -$100.00" on October's statement stays true, and a change made after October lands on November's statement, not on the redone September (both rulings at once; Kian confirmed this reading on 2026-10-12, now in `CLAUDE.md`). An entry since removed is still printed by the redone month at what it first charged, so the refund already given nets it to zero.
- **An adjustment shows on the next month's statement**: the first month after the latest month that charged the entry that has no current statement (`nextOpenMonth`). A later month finished first leaves it for that month (S5). Before, the next statement finished took it, whichever month it was.
- **An entry whose statement was deleted, not finished again,** is picked up at what is left by the first statement finished for its month or a later one (as an earlier-month row), and only once.
- **"Earlier month" rows, cost rows of entries no statement printed, and statements finished in month order are unchanged**: the chains of `scenarios.mjs chains` are byte-identical to `33270e3`.

### 37.2 The carried balance is a link (S2)

- **A carried balance taken from a statement stores its month** (`carried.fromMonth`; a balance carried before is read through its statement's ID). While the statement carrying it is open, it carries what that month's current statement says is owed, less what other current statements already deducted for that month; a corrected source is followed without a click, and the Details tab shows "follows October 2026's statement". Typing over the amount makes it a typed balance, which is no link.
- **Once finished, a correction or delete of the source** is settled on the next open statement (the same `nextOpenMonth` rule) by a line in the table, "Adjustment - Balance From October (carried in November 2026 as $150.00, now $120.00)", signed as the owner gains, and counted in the Total. The report stores them as `carriedAdjustments`, written only when there are any. A source deleted and not finished again owes nothing: the carry is given back; finished again, the new figure is deducted.
- **Uncarried debts** (`uncarriedDebts`): every earlier month that closed below zero and that no current statement carried or settled, most recent first, each with its own "Carry $X from <month>" button; Finish warns for each one the statement does not carry. A statement being corrected still counts as carrying what it carried.
- **The finish claim carries the carried balance and the settled ones**, so a source changed between the page loading and Finish is refused as `STATEMENT_CHANGED`, like an entry.

### 37.3 The confirmations (R7)

- **Delete and Correct name the later statements** (`laterReferences`): current statements of later months that printed an adjustment for an entry this one charged, carried its balance, or settled a carry from its month — "# Nov-TEST-d35 (November 2026) adjusted its costs and carried its balance" — and say what follows.
- **The home panel's adjustments count** adds up what statements charged (`charged` on each summary) instead of reading the last printing, so a redone month is not counted as a change waiting.

### 37.4 No native browser dialogs in the admin

`useAsk` (`components/AskDialog.tsx`) asks in the property pages' own `Dialog` and answers a promise. Converted: the Team page (deactivate or reactivate, change a code, delete a member), the costs page (download with entries pending), the entry pane (remove, delete for good), the property page's Income tab (remove a line) and Costs tab (download with entries pending). The unused `handleSeedDatabase` is gone; `app/data/properties.ts`, its data, is left. `grep` finds no `confirm(`, `alert(` or `prompt(` call in `app/admin`.

### 37.5 How it was checked (2026-10-12, 20:45–20:53 Toronto)

- **Pure, the audit's acceptance scenarios** (`scenarios.mjs acceptance`, Nubnb's own code): $100 corrected to $150 after September, October adjusted, September deleted and finished again or corrected — charged $150.00 once, November no adjustment; corrected again to $170 after October, then September redone — September prints $100.00, November +$20.00, charged $170.00; the removal case nets to $0.00; October finished first, its cost removed, September finished after — September carries nothing, November gives the $40.00 back, December (finished first) leaves it to November; −$359.96 carried then corrected to −$200.00 — an open October follows to $200.00, a finished October is settled by +$159.96 on November ($200.00 deducted in all), a deleted September gives back $359.96 then deducts $200.00 when finished again; an uncarried debt offered in November and December until carried.
- **Byte-identical**: five in-order statements (a cost and an earlier-month cost, an adjustment and a carried balance, a second adjustment, a correction redoing nothing earlier, a December preview) hash the same under `33270e3` and this code; the 40 version-3 statements of §36 still match `2793e84`.
- **Live, on a local build** (`XtgjjWq2OyHu3d_pVt96a`, 127.0.0.1:4500, throwaway PIN, the write guard) on the Unlisted `__TEST__ d35 corrections`, with November and December reached by the address (a statement may be made for any month): October finished at −$150.00 with two $100.00 office costs; one corrected to $150.00, the other removed (Nubnb's dialog); November finished with +$50.00, −$100.00 and October's $150.00 carried; October deleted (the dialog naming November) and finished again — $100.00 and $100.00, what is left; corrected (the dialog naming November) with $80.00 revenue, closing at −$120.00; December's preview settled the carry: +$30.00. 42 writes through the guard, none refused. Cleanup: November and the correction deleted through the app; the corrected October statement, which the app cannot delete while its correction is open, and the three drafts deleted by exact ID after an export (K13); the two entries and the property through the app's dialogs. Opening and closing exports byte-identical (84 documents); Storage's 6,622 objects identical by name and generation.
- **Not exercised live:** out-of-order finishing and a deleted source carry (pure only: an entry's day cannot be set through the routes); the finish refusal when a carried balance's source changes after the page loaded (read from the code: the claim carries it); the Team page's code and delete dialogs (opened and cancelled only for Deactivate, so no code was read); the costs pages' "Download anyway" (no pending entry exists).

## 38. The office-cost month, empty months together and the title mark: C3 and Step 3 of the dispatch 31 plan (dispatch 36, 2026-10-12)

Kian's rulings of 2026-10-12 are in `CLAUDE.md` under *Office costs, empty months and Airbnb titles*, the two on printing and the ledger included. What follows is how they were built, the developer's decisions where they leave room, and how it was checked.

### 38.1 What was built

- **The office-cost month (C3).** "Log a cost" asks "For the month", the month on screen first. The entry stores `month`. The route refuses a month after Toronto's current one and answers which statement the cost goes on (`statementMonthOfCost`); the notice names it: "Logged $5.00 for September 2026, approved. September 2026 is finished: it goes on October 2026's statement." `entryMonth` (the stored month, else the month sent) places an entry for the statements, the owed months, the loose ends, the property page's Costs tab, the entry pane and the month ZIP; `statementMonthFor` says which statement takes it.
- **How an office cost prints** (`officeWhen`): "ref EffGwj · Sep 2026 (logged Oct 12)" on a statement row; in the ledger PDF the date column says "Sep 2026" with "(logged Oct 12)" under it; the Excel sheets write the same words in the date column; the Costs tab lists it that way.
- **The ledger places costs by the statements' month rule** (`ledgerDay`): the ledger's period filter, its PDF and Excel, the server's check when it records a PDF, and the comparisons against recorded PDFs. On September's Costs tab, an entry the finished statement did not print is marked "on October 2026's statement".
- **Empty months together (Step 3).**
  - `reports/empty.ts` (pure) decides the list.
  - `server-empty-months.ts` reads what it needs and finishes.
  - `GET` and `POST /api/admin/monthly-reports/empty` serve it.
  - `EmptyMonthDialog` is opened by "Finish empty" on the Statements panel for a month that has ended. It shows the properties that can be finished, each with a tick and its reference, then those left out with why, and a block naming the unsettled titles with the way to the Income page.
- **The title mark.** "Not a Nubnb property" on the Income page's unlinked titles, asked in Nubnb's dialog. The link is stored with no property and `notNubnb: true`. The title's proposed lines are rejected then and in every later file (the upload rejects them as it records them). The title stays in the titles table, marked, and its heading counts it apart: "0 linked · 1 not a Nubnb property". It is in none of the gaps, and Finish and the bulk finish count it as settled. A rejected line under it shows the mark instead of "Propose again", and the server refuses that too (409 `TITLE_SET_ASIDE`).
- **S22.** On the property page, Finish on a month with nothing stored saves what the page shows, its suggested reference included, then asks. An empty month needs no note.

### 38.2 Decisions, not rulings

- **The months offered** run from September 2026 to the current month. A month on screen outside that range starts the field at its nearer end.
- **An earlier month's cost waits for its own month's statement while that month is open,** and goes on the next open month's once it is finished. Before, whichever later statement was finished first took it. Statements finished in month order are unchanged.
- **"Sep 2026 (logged Oct 12)"** uses short month names, and adds the year to the logged day only when it differs: "Dec 2026 (logged Jan 5, 2027)".
  - It applies to every office cost: one logged for its own month prints "Oct 2026 (logged Oct 12)", and one written before dispatch 36 belongs to the month it was sent.
  - Finished statements print what they stored.
  - On an earlier month's row, the office cost drops "(from September 2026)", since the row already prints its month.
  - The review queue (`/admin/costs`) keeps the time sent.
- **For a period that is not a whole month,** an office cost logged for an earlier month sits on that month's last day. A month's ledger then holds what its statement holds, and two periods that meet hold each entry once.
- **The empty list** takes Due and Past due months, skipping excluded properties. It leaves a property out for the first of these:
  - the rulings' two, said together when both apply (no Report For name; calendar check-ins the month's file does not hold);
  - a draft with anything typed but its reference and date;
  - Airbnb lines waiting;
  - a cost, adjustment or carried balance;
  - any other Finish warning but "No NuBNB fee". An empty statement goes out unread, so it goes only when nothing needs a look.
- **References and ticks in the dialog.** The reference is the draft's if one was typed, else suggested from the property's last statement before the month; with neither, it is typed in the dialog. Every listed property starts ticked, and Finish is disabled while a ticked one has no reference.
- **The finish** writes each confirmed property's draft empty, with today's date and the typed reference, then finishes it as any statement.
  - The server reads the list again first: a property no longer on it is answered as left out with why.
  - An unsettled title finishes nothing.
  - One property failing does not stop the others; the answer lists each.
- **A set-aside title** keeps the lines it had accepted before. Linking it later is an ordinary link; the link's history keeps the set-aside.
- **Kian confirmed four of these on 2026-10-13:** both of the rulings' reasons said together, set-aside titles counted apart, a late cost marked on a finished month's Costs tab, and the "(logged …)" formats.

### 38.3 How it was checked (2026-10-12 and 13, 22:05–23:56 Toronto)

- **Pure** (`pure.mjs`, made-up data):
  - C3 in each order: September open, September finished before the cost was logged, September and October finished, logged for its own month, written before dispatch 36.
  - `ledgerDay` and the exports for September, October, 15 September to 15 October, and open; the September PDF and Excel read back.
  - The title mark in `monthView` and `unlinkedTitles`.
  - `emptyMonth` as of 1 November over fourteen kinds of property.
- **Byte-identical with the earlier code:**
  - the in-order chains, with `509499d`;
  - the dispatch 35 acceptance output;
  - 40 of 40 version-3 statements, with `2793e84`;
  - a ledger's PDF and Excel without an office cost, for a month and an open period, with `509499d`.
- **Live on real time** (build `hIlPbQboiV6u9jXBTz9NB`, 127.0.0.1:4500, throwaway PIN, the write guard), on Unlisted `__TEST__` properties:
  - A September cost logged on 12 October from September's page landed on September; October's costs said None.
  - After September was finished, a September cost picked on October's page went on October, named in the notice.
  - T5's October, untouched and showing "Nothing saved yet", finished straight from Finish with its suggested reference: no lines, no note.
- **Live with the server's clock at 1 November 2026** (builds up to `vnghCXWywTx7P_s8h-2ME`):
  - A made-up October file with one `__TEST__` title was uploaded through the app. October's list then held T1, T2 and one real property ("Corner Penthouse l Tall Ceiling", the only real one with a Report For name). 44 real properties were left out for no Report For name, and 16 for that and October check-ins the file does not hold; T3 for no Report For name, T4 for its costs.
  - The finish was refused, 409 `TITLES_UNSETTLED`, with nothing written. The title was set aside on the Income page ("1 line was rejected", gaps 17 → 16).
  - T1 and T2 were finished together, as `Oct-T1-TEST` and the suggested `Oct-T2-TEST`. T3, sent too, was answered as left out. Both PDFs' SHA-256 match their documents, and they read "Nothing to report this month.", dated Nov 1, 2026, with no note.
  - "Propose again" on the set-aside line was refused (409).
  - T4's September Costs tab and both its exports listed the two September costs as "Sep 2026 (logged Oct 12)". The PDF's record was accepted by the server (`cost_report_exports`). October's statement printed "Expense - ref EffGwj · Sep 2026 (logged Oct 12)".
  - The panel's dialog was opened for September and cancelled. The browser's own clock read 13 October, so October's button did not show.
- **The clock.** A preload (`clock-preload.cjs`) shifted `new Date()` and `Date.now()` only for callers in the app's compiled code. It reads the raw call sites, which Next's source maps would otherwise rename, and skips Next's own `Date` wrapper. Google's auth and gRPC kept real time.
- **Cleanup.** The guard saw 86 writes over the whole test, the app's cleanup included, and refused none.
  - Through the app: six statements with their PDFs, the two entries, and the five properties, which took their owner records and unlisted marks with them.
  - By exact ID after an export (K13): six drafts, the upload, its line, the title link, the PDF record, and the kept CSV.
  - The closing export (`2026-10-13T03-56-13Z`) is byte-identical, file for file, to the opening one (`2026-10-13T02-06-38Z`, 84 documents). Storage's 6,622 objects are identical by name and generation.

### 38.4 Not exercised live

- **October's dialog in the browser.** Kian checks it on 1 November, before any real statement is finished with it. "Corner Penthouse l Tall Ceiling" will be on it, ticked, until it is unticked or given a reference.
- **The month ZIP's placement** of an office cost (pure only).
- **The `/admin/costs` ledger's date filter** with an office cost (the same function as the exports; not opened).

## 39. One calculation per property-month: dispatch 37A of the dispatch 37 plan (2026-10-13)

Kian's rulings of 2026-10-13 are in `CLAUDE.md` under *The month's money*: the one calculation, M1 (claw-backs) and M2 (money months). What follows is how they were built, the developer's decisions where they leave room, and how it was checked. Nothing stored changes: no record is rewritten, finishing stores the same shape and values, and every printed statement is byte-identical.

### 39.1 What was built

- **The month's money** (`app/lib/money/month.ts`, pure and client-safe):
  - `monthMoney` for one property and month: the statement (frozen when finished, built live otherwise), the figures of the statement the owner holds, the correction's figures beside them while one is written, the statement's lines with their source, the month's cost lines with every statement that charges each, their totals, and what the statement charges for other months.
  - `buildStatement` stays the statement's arithmetic. The preview, Finish's claim and every byte printed are its, unchanged; the month's money is built around it.
  - `figuresOf` and `incomeFigures` place each line by its source (M1); `costCharges` says which statements charge each cost; `frozenStatement` is the property page's rule for "finished", now in one place; `airbnbLineIdsOf` reads which draft lines came from an accepted Airbnb line (`decided.lineId`).
- **Every reader switched** (plan §5.1; T-numbers are the plan's):

| Reader | Now reads | Closes |
|---|---|---|
| Property page: preview, Finish, Income tab head, revenue beside the fee base, Finish tab's Revenue Share | `monthMoney` | T4 |
| Property page: Costs tab head, its split by statement, row marks, "Also in this statement", the tab's count | `monthMoney`'s cost lines and charges | T1, T8, T9 |
| Ledger: Costs tab and `/admin/costs` exports, the ledger's line and rows | `buildReport` with `costCharges` | T1 |
| Entry pane: "Property and statement" | `costCharges` | T1 |
| Costs page totals and Items bought | approved and pending apart, tax rows | T5 |
| Home: Statements panel rows | `monthMoney` on the server, in the tracker's read (`panelFigures`) | T2, T4, T7 |
| Income page: By property | `incomeFigures`, the statement as sent beside a correction | T2, T4 |
| Finish's unlinked-titles check, empty months' unsettled titles | stored lines (`unlinkedTitlesFromLines`) | T3 |
| Month ZIP: folders and workbooks | `monthMoney` in `selectMonthPackage` | T4, T6, T7, T9, T10 |
| Empty months | `monthMoney` | — |
| Owed months | `moneyMonthsByProperty`, documented as M2 | — |

- **Stale comments corrected:** the month rule described as "the day sent" (`statement.ts`, its head and the money-months rule), "stored figures are never read back into a total" (`server-reports.ts`), the base "prefilled from the revenue lines" (`model.ts`), and the costs page's date note.
- **Tests in the repository** (`tests/`, made-up data only): dispatch 35's acceptance scenarios and chains (`money/corrections.mjs`), dispatch 36's checks (`money/office-month.mjs`) and ledger hashes (`money/ledger.mjs`), and this dispatch's walk through T1–T10, M1 and M2 (`money/month-money.mjs`). `node tests/run.mjs` (or `npm test`) compares each output with `tests/expected/`, byte for byte. The production-data scripts of dispatches 34–36 went to `~/Backups/Nubnb/dispatch-34-36/`, outside the repository.

### 39.2 Decisions, not rulings

- **What finishing stores is unchanged.** A report still stores `incomeCents` and `expensesCents` split by sign. Pages read the month's money instead, which takes Total, carried balance and Revenue Share from the statement as printed and places its lines by source. The two splits differ only for a claw-back; the Total never does.
- **Which line is Airbnb's:** a draft line an accepted Airbnb line points to (`decided.lineId`), or a line loaded from a row written before dispatch 23D whose `source` is `airbnb`. Line IDs survive a correction. Every other line is typed.
- **Revenue** is every Airbnb line, claw-backs taken off, plus typed lines above zero. **Expenses** are typed lines below zero. A typed negative line stays an expense: M1 names Airbnb's claw-backs.
- **Beside the fee's base:** the revenue, and "Airbnb paid $…" when the month has Airbnb lines. Neither fills the base in (dispatch 26).
- **The fee-base check** compares the base's revenue with the month's money's revenue. A fee saved before 37A stored the revenue split by sign; with a claw-back in the month it would warn once. Production held no draft at the build.
- **While a correction is written,** the month's figures are the statement as sent. The correction's figures are said beside them on the panel ("correction $…"), the Income page ("correction $…", "Finished · correcting") and the property page's Income tab ("as sent …"). The property page still edits and previews the correction.
- **The Statements panel** shows a month not finished as it stands, greyed, so a cost charged on an open month's statement is visible there. It gained a Carried column: the carried balance and any carried balance settled, together, so Income − Costs − Fee − Carried is the Revenue share on every row. The server works the figures out in the tracker's one read, for every month from September 2026 to the next month and any month a statement or draft names.
- **A figure is an amount, named; a statement's rows keep the statement's signs (T9).**
  - The Details tab's fee reads "$400.00 deducted", as the carried balance did.
  - The workbook's Statement sheet prints the carried balance as the PDF does.
  - "Fee as printed" became "Fee, deducted".
  - The Costs tab's "Also in this statement" lists cost amounts, below zero for money given back.
- **Where a cost is charged** (`costCharges`): the current finished statements' cost rows and adjustments, then each month not yet finished built as its statement is. An entry's charges add up to what it now adds up to.
  - A cost removed or rejected after a statement printed it stays on the Costs tab, marked, so the head's split adds up to the statements.
  - The split shows only when some cost is not on its own month's statement.
- **The ledger PDF and Excel** mark an entry and split the total only when an entry is charged on another month's statement; every other ledger is byte-identical. `/admin/costs` reads the chosen property's statements, and waits for them before an export. A failed read refuses the export, so a ledger can never go out without its marks.
- **T5.** The totals table's "Counted" (approved + pending) is gone: Approved, its tax, and Pending apart. Items bought lists each entry's tax as a row; its approved total is the ledger's figure, pending apart.
- **T6.** The Costs sheet adds "Adjustments to earlier statements" and "Recorded costs" rows when there are adjustments. A cost a redone month charges only part of reads "Yes: $X here, the rest on …". Its items carry a "Charged on …'s statement" row, so they add up to what the statement charges.
- **T7.** The fee workbook gained "Carried balances settled (CAD)" and "of which Airbnb (CAD)".
- **T3.** Which titles are unlinked still comes from the files' summaries; how many rows and how much comes from the stored lines.
- **Reads added:** the tracker reads the accepted Airbnb lines (`status == accepted`). The month ZIP reads the month's Airbnb lines. Finish's check reads the stored lines of unlinked titles. No other read changed.
- **Not built: O1, fewer reads.** The plan's "pages read one property's or one month's records" and the reads counted before and after were not done. The property page still reads every cost entry; its entry pane's cleaner pattern (`watchList`) needs every entry of that cleaner, so narrowing the read changes what it says. Kian to say whether it comes in a later dispatch.
- **The loose ends** under the panel are counts, unchanged.

### 39.3 How it was checked (2026-10-13, 09:45–10:28 Toronto)

- **Before building:** the repository's tests, generated at `a4ad705`, reproduce dispatches 35 and 36's recorded outputs exactly. One line differs: `office-month` prints its ledger files' SHA-256 where it used to write the files, and the hashes are those of the files d36 wrote.
- **After building, byte-identical:**
  - `node tests/run.mjs`: the four earlier checks identical; `month-money` recorded;
  - 40 of 40 version-3 statements (`d36/v3-hash.mjs`, from the archive);
  - dispatch 34's pure and small checks over the 11 October export, identical to `a4ad705`'s output.
- **Production held no statement** at the opening export (`2026-10-13T14-20-08Z`, 84 documents, byte-identical to dispatch 36's closing export), so no stored statement was re-rendered.
- **Live, real time** (build `-UmEESTl0KI2slkqDLh4X`, 127.0.0.1:4500, throwaway PIN, the write guard: 41 of 41 offline checks first). One Unlisted `__TEST__` property, `6q4CWmkws0rsC0vBmwQI`:
  - a $100.00 office cost for September; September finished as `Sept-TEST-D37A`; then a $50.00 office cost for September, which went on October's statement, the notice naming it;
  - September's Costs tab: "2 entries · $150.00", "$100.00 on September 2026's statement · $50.00 on October 2026's statement, not yet finished", the $50.00 row marked, the tab's count 2;
  - September's ledger PDF, read back: the $50.00 entry "On October 2026's statement", and "Charged on: September 2026's statement $100.00 · October 2026's statement $50.00";
  - September's statement, downloaded from Storage: one row, −$100.00, its SHA-256 the one recorded at finish;
  - the home panel: September Costs $100.00 (finished), October Costs $50.00 (as it stands);
  - October's Costs tab: "Also in this statement … $50.00"; its preview, −$50.00;
  - `/admin/costs`, the property's September ledger: the same split and mark;
  - the entry pane: "it belongs to September 2026, which is finished, so it goes on October 2026's".
- **Cleanup.** The guard saw 21 writes, the app's cleanup included, and refused none.
  - Through the app: the statement with its PDF and its download record, both entries, and the property, which took its owner record and unlisted mark with it.
  - By exact ID after an export (K13): the September draft and the cost PDF's record.
  - The closing export (`2026-10-13T14-27-26Z`) is byte-identical, file for file, to the opening one. Storage's 6,622 objects are identical by name and generation. The statement's PDF stays soft-deleted until about 2026-10-20.

### 39.4 Not exercised live

- **T2–T10, M1 and M2** were checked on made-up data only (`tests/money/month-money.mjs`): the correction, the claw-back, the unlinked titles, the costs page's totals, the month ZIP's workbooks and the panel's carried column. The month ZIP was not downloaded live, because its download record is a write the guard refuses.

## 40. Cleanings: dispatch 37B of the dispatch 37 plan (2026-10-13)

Kian's rulings of 2026-10-13 are in `CLAUDE.md` under *Cleanings*: one default rate per cleaner, every cleaning logged by hand, one line on the statement, the cleaner never named to an owner, the late and corrected rules costs follow, a tab inside the Costs page, the earnings record, and Finish's checkouts warning. What follows is how they were built, the developer's decisions where they leave room, and how it was checked. No stored record is rewritten; `firestore.rules` and `storage.rules` are unchanged.

### 40.1 What was built

- **Stored:**
  - `cleanings/{id}`, server-only: `firestore.rules`' catch-all already denies browsers.
  - Each cleaning holds the property and cleaner (with their names at entry), the day cleaned, the amount in cents, the note, a status (`logged` or `removed`), the amount the form started from (`suggested`: last, default or none, and its cents), and its history (`logged`, `changed` with before and after, `removed`).
  - A cleaner's one default rate is `cleaners/{id}.defaultRateCents`, set from the Team page with a `rate_set` history event. Handymen have none.
- **Routes** (admin session, cross-site and media-type refusals, zod schemas in `app/lib/cleanings/schemas.ts`):
  - `POST /api/admin/cleanings` logs one cleaning and answers with the month whose statement it goes on.
  - `PATCH /api/admin/cleanings/[id]` changes or removes one; `DELETE` deletes one.
  - `PUT /api/admin/cleaners/[id]/rate` sets or clears a default rate.
- **How a cleaning reaches the statements:** `cleaningEntryView` (`app/lib/cleanings/model.ts`) reads it as an approved cost entry of kind `cleaning` (removed once removed), dated on its day and belonging to its day's month. Dispatch 35's and 36's rules then apply unchanged:
  - one logged after its month is finished goes on the next open statement;
  - one changed or removed after printing is adjusted there.
- **The statement** (`printedLines`):
  - a month's own cleanings print as one line, "Expense - Cleaning", with their count and total; the rate shows only when every amount is the same;
  - cleanings of an earlier month print one line per month, "Expense - Cleaning (from September 2026)";
  - an adjustment names the cleaning's day: "Adjustment - Cleaning · Sep 5, 2026 (reported in September 2026 as -$60.00, now -$70.00)".
- **The ledger** lists each cleaning as a row, "Cleaning", logged by "Nubnb office", with a note saying what a cleaning entry is.
- **The month ZIP:**
  - the owner's workbook lists each cleaning the statement charges, logged by "Office", its history by day and amount only;
  - Nubnb's folder gains `<month> Cleanings.xlsx` (each cleaning with who cleaned, and an Earned sheet) and `Records/cleanings <month>.json`.
- **The Costs page** has two tabs, Costs and Cleanings (`?tab=cleanings`).
  - The Cleanings tab's form takes the day cleaned (with Today and Yesterday), the property (searchable), the cleaner (active cleaners only), the amount and an optional note.
  - The amount fills in when the property and cleaner are chosen, saying where it came from: "last paid for this property", "their default rate" or "type the amount".
  - Below the form, the cleanings in the chosen dates, property and cleaner: Change (in place), Remove and Delete, all in Nubnb's own dialogs. Then the total, and "Earned in these dates" for each cleaner.
  - The Costs tab's kind filter has "Cleanings", and a cleaning's row there opens the Cleanings tab on it.
- **Elsewhere:**
  - The property page's Costs tab: a cleaning row opens the Cleanings tab, and its foot links "Log cleanings" for the property and month.
  - The Team page: a Rate column and "Set rate" for cleaners. A team member's delete confirmation counts their cleanings apart ("N cleanings done by them stay, under the same name").
  - Finish: the checkouts warning reads a logged cleaning as a cleaning line (count only, unchanged). The property delete guard counts cleanings. `scripts/export-firestore.mjs` expects `cleanings`.
- **Tests:** `tests/money/cleanings.mjs` (made-up data) covers:
  - equal and differing amounts, the late cleaning, the change and the removal;
  - no cleaner name in either statement PDF, the ledger PDF, the cleanings-only ledger Excel or an owner's ZIP folder;
  - a deleted cleaner's cleanings;
  - the amount the form starts from;
  - Finish's warnings;
  - M2's owed and empty months;
  - the ledger PDF's split and footnote;
  - what the routes accept.

### 40.2 Decisions, not rulings

- **No rules change.** Cleanings are read and written only by the server, through the Admin SDK.
- **Logging checks the cleaner in the same transaction:** they exist, are a cleaner (not a handyman), and are active.
  - The amount the form started from is worked out again on the server and kept beside the amount stored. The stored amount is the one the admin left.
- **"Last paid for that property"** means that cleaner's latest cleaning there by day cleaned, removed ones left out.
- **The day** may not be in the future or more than twelve months back, as a receipt's purchase date.
- **A printed cleaning keeps its month.** Moving its day into another month is refused, because the adjustment would land on the wrong statement. Remove it and log it again instead.
- **Delete** is refused while a finished statement prints the cleaning, as for a cost entry (dispatch 23H). A removed cleaning can be deleted too.
- **A change or removal names what the page saw** (its history's length) and is refused if the cleaning changed since.
- **Fast logging:**
  - With no cleaner chosen, picking a property fills in its last cleaner.
  - After logging, the day and cleaner stay and the property clears.
  - So a week of one cleaner's cleanings is six actions each: the day (two), the property (three: open, type, pick), and Log. Seven when the amount is changed.
- **A typed "Expense - Cleaning" line beside logged cleanings** warns at Finish: "cleaning may be charged twice".
- **Who is named where:**
  - owners' files never name a cleaner;
  - the ledger says "Nubnb office" for a cleaning;
  - the ledger Excel still names who sent a receipt, as before;
  - an owner's workbook history carries no reasons, since a reason the admin types may name the cleaner;
  - Nubnb's own Cleanings workbook names who cleaned.
- **The earnings record** is "Earned in these dates" on the tab and the Earned sheet in Nubnb's month workbook: cleanings done, removed ones left out. Neither records a payment.
- **A deleted cleaner's cleanings** read under the name at entry, marked "(deleted)" on the tab.
- **The tab's "Charged on" column** shows only when a property is chosen: it needs that property's statements.
- **The ledger PDF:**
  - an entry charged on two statements wraps its "On …'s statement" note onto a second line; it was cut with "…" before, a 37A limit first seen here;
  - a changed cleaning's footnote reads "* A cleaning marked so was changed by Nubnb after it was logged.";
  - the receipt footnote is unchanged, and every older ledger is byte-identical.
- **The costs list shows a cleaning's day without a time:** it has a day, not a time.

### 40.3 How it was checked (2026-10-13, 11:49–12:19 Toronto)

- **Byte-identical on the final code:**
  - `node tests/run.mjs`: the five earlier checks identical; `cleanings` recorded;
  - 40 of 40 version-3 statements (`d36/v3-hash.mjs`);
  - dispatch 34's pure checks (dated 12 October, as recorded) and small checks over the 11 October export, identical to `a4ad705`'s output.
- **Production held no statement, cost entry or cleaning** at the opening export (`2026-10-13T15-49-44Z`, 84 documents, identical to 37A's closing export).
- **Live, real time** on a local build reading production: builds up to `vhWOsg7ice0xWDWYaVpOY`, 127.0.0.1:4500, a throwaway PIN, and the write guard (57 of 57 offline checks first). The test used one Unlisted `__TEST__` property, `rZUgxOs6XAkGro8XPUMQ`, and one `__TEST__` cleaner made on the Team page with a typed code and a $60.00 default rate.
  - **Equal amounts:** Sep 5, 12 and 19, each prefilled $60.00 ("their default rate", then "last paid for this property"), logged in 8, 6 and 6 actions. September's PDF: "Expense - Cleaning · 3 · -$60.00 · -$180.00".
  - **Late:** a Sep 28 cleaning at $75.00, logged after September was finished, said "September 2026 is finished: it goes on October 2026's statement".
  - **Differing:** Oct 3 at $60.00 and Oct 9 at $80.00.
  - **Corrected after printing:** Sep 5 changed to $70.00 and Sep 12 removed. October's PDF:

    ```
    Expense - Cleaning                                   2              -$140.00
    Expense - Cleaning (from September 2026)             1    -$75.00    -$75.00
    Adjustment - Cleaning · Sep 5, 2026 (reported in September 2026 as -$60.00, now -$70.00)   -$10.00
    Adjustment - Cleaning · Sep 12, 2026 (reported in September 2026 as -$60.00, no longer in the ledger)   $60.00
    ```
  - **The ledger:** `/admin/costs` and its PDF showed "$120.00 on September 2026's statement · $225.00 on October 2026's statement" for $345.00.
  - **No cleaner named:** neither statement PDF, the ledger PDF and Excel, nor any file of either month's owner ZIP folder holds the cleaner's name or ID (PDFs read with `pdftotext`, workbooks unzipped). The ZIP's October PDF is byte-identical to the one downloaded from the property page.
  - **A deleted cleaner:** after the cleaner was deleted on the Team page, the API, the tab, the ledger and both finished months still read all six cleanings, under the name at entry, "(deleted)".
  - **Delete refused:** deleting a printed cleaning was refused (`CLEANING_IN_STATEMENT`), nothing written.
- **Found live and fixed before the end:**
  - the form's empty note was sent as `null` and refused by the schema;
  - the form's selects did not fill their fields;
  - the costs list showed a cleaning at "1:00 p.m.";
  - the ledger PDF called a changed cleaning "corrected against the receipt" and cut a two-statement note;
  - a removed cleaning offered no Delete.
- **Cleanup.** The guard recorded 54 writes; it refused 1, its own first refusal of the code record, and nothing landed from it.
  - Through the app: both statements, with their PDFs and 4 download records; the 7 cleanings; the cleaner, whose code was retired; and the property, with its owner record and unlisted mark.
  - By exact ID after an export (K13): the two drafts, the two cost-PDF records, the two month-ZIP records and the retired code.
  - The closing export (`2026-10-13T16-19-14Z`) is byte-identical, file for file, to the opening one. Storage's 6,622 objects are identical by name and generation. The two statement PDFs stay soft-deleted until about 2026-10-20.

### 40.4 Not exercised live

- **Finish's checkouts warning** needs a property with Airbnb checkouts. The cleaning-twice warning and M2's owed and empty months for a cleaning-only month were also not exercised live. All three were checked on made-up data only (`tests/money/cleanings.mjs` §6–7).
- **The Team page** was read only with codes masked and never screenshotted, so the Rate column was checked by a masked read.
- **The property page's Costs tab** heads its column "Logged by". For a cleaning it shows who cleaned, which only admins see.

## 41. October's Airbnb file: dispatch 37C of the dispatch 37 plan (2026-10-13)

Kian's rulings of 2026-10-13 are in `CLAUDE.md` under *Airbnb files*: M10, M11, one active title per property, M13, M14, identical rows, unknown row types, and print order. What follows is how they were built, with the rest of dispatch 31 Step 4 as the architecture lists it, the developer's decisions where the rulings leave room, and how it was checked. Production held no upload, line or title link, so no stored record changes shape for good; `firestore.rules` and `storage.rules` are unchanged.

### 41.1 What was built

- **Accepted lines read where they are stored (M10):**
  - Accepting writes only the decision on the line: the property, and the words and amount as the admin left them. Nothing is copied into the draft.
  - `platformLineOf` reads such a line for the statements (`PlatformLineInput`), and `buildStatement` places it (`platformLinesOn`): its own month while that month's statement is open, otherwise the next open statement, with "(paid Sep 29)" printed (M11).
  - Lines from files print first, newest stay first; the typed lines follow in the admin's order.
  - A finished statement keeps each such line with `source` and `platformLineId`, which locks it. An edit or a send-back is refused while a current statement prints the line, unless a correction of that statement is being written.
  - Finish's claim carries each line and its history's length, so a line changed since the page loaded is refused (`STATEMENT_CHANGED`).
  - A line accepted before 37C carries `draftId` and `lineId`: it was copied into its draft, which still holds it, and it is read there as before.
- **The readers:**
  - The property page, Finish (re-checked inside the transaction), the home panel and tracker, owed months, empty months, the Income page and the month ZIP all read accepted lines through the same path.
  - A deleted or corrected statement reopens its draft with its typed lines only.
- **An edit after acceptance (I10):** `PATCH /api/admin/income/lines/[id]` `{ action: "edit", seen, description?, amount? }` changes the line itself, with an `edited` event holding what it said before and after. `propose-again` sends an accepted line back for review.
- **Reject all (N2):** `POST /api/admin/income/lines/reject`.
- **One active title per property:**
  - `earnings_title_links` gains `active`. A link written before 37C reads as active. One title per property and platform is active; the others are previous titles, still the property's, so older files still match.
  - `setActiveTitle` serves the edit page's new "Airbnb title" section (Nubnb only; `GET`/`PUT /api/admin/properties/[id]/airbnb-title`), the Income page's Link (M12), and an accepted rename.
  - The property save refuses `airbnbTitle`, `airbnbTitles`, `listingTitle`, `titleLink`, `titleLinks` and `activeTitle`, as it refuses `cleanerName`.
- **Moving a title (M13):** a title linked to another property moves only while none of its lines is on a current finished statement (`TITLE_LINES_PRINTED`, naming the statements). Its lines accepted for the other property go back for review, each with an event saying why.
- **Renames (M14):** `renameSuggestions` (pure) weighs three kinds of evidence:
  - a confirmation code under the new title that was under one of a property's titles in an earlier file;
  - stays matching bookings on the property's calendar copies;
  - the title being the property's name.

  It suggests only when every kind of evidence found names the same one property. The Income page offers "Make it <property>'s title", asking first; nothing is applied otherwise.
- **The reader:** `income/platforms.ts` holds one reader per platform. Row types live in `PLATFORM_TYPES` (stay types print "Revenue" and count as checkouts). Lines are looked up by title on their own platform.
  - **Identical rows:** the second identical row in a file is keyed `|2`, the third `|3`. The first keeps the key earlier files made, so a later file holding the same rows adds nothing.
  - **Unknown row types:** a row Nubnb does not recognise becomes a line with its property and is marked "Needs a decision". "Accept all" leaves it out.
  - **Columns (I7):** names are matched in any case, and a file without Guest or Details is refused.
  - **Rows out of order (I14):** payouts are checked day by day when the rows are not after their payouts.
- **The rest of Step 4:**
  - **I2:** a proposed line warns when it may repeat the same booking accepted at another amount, or a typed line of the same amount and dates.
  - **I5:** a review group says when its property owes no statement (excluded, or outside its record's months).
  - **I8:** the Income page and the Income tab say how many days' calendar copies were read, so an empty gap list is never an all-clear. A check-in on a month's last day is left to the next month's file.
  - **I15:** stays on the calendar copies that no line covers are listed on the Income tab and warned about at Finish (`calendar-stays`).
- **The Income tab** lists the lines from the files apart from the typed ones ("From the Airbnb file"), each with its file and row, "edited since accepted", and, for a late line, the month it belongs to. While the statement is open, each has Edit and Send back.
- **Tests:** `tests/money/airbnb-file.mjs`, with dispatch 36's made-up October file (`tests/fixtures/airbnb-october-d36.csv`) and its variants. The income route schemas moved to `app/lib/income/schemas.ts` so the bodies the pages send are tested as they are.

### 41.2 Decisions, not rulings

- **Where a late line goes:** a line accepted for a finished month goes on the next open statement. If that month is corrected while the later statement is still open, the line returns to its own month, as a late cost does (dispatch 36). Once a later statement prints it, it stays there.
- **Edits after printing:** an accepted line printed on a finished statement is never adjusted on a later one. M10 locks it; only correcting that statement unlocks it.
- **A line before the property's first statement month** (September 2026, or its record's start) goes on no statement, as a cost does.
- **Accept all** leaves out lines that need a decision; each is accepted (edited if need be) or rejected on its own.
- **Moving a title** is refused while any of its lines is on a current statement, even one being corrected. Lines accepted before 37C still in a draft also stop the move (`TITLE_LINES_IN_DRAFT`).
- **Missing titles:** "Linked, not in this month's file" lists active titles only. A previous title is expected to be missing. Since Kian's ruling of 2026-10-13 (after the first report), an active title is listed only for months after the Toronto month it became active (`activeMonthOf`, from its `linkedAt`); a renamed listing's earlier months are no longer flagged.
- **The calendar-stays warning** appears only when the month has calendar copies; with none, nothing is checked, and the page says so.
- **Kian's confirmations of 2026-10-13, after the first report:** the two decisions above stand (a late line returns to its corrected month; a printed line changes only by correcting its statement). Deduction wording (I12) stays as is; uploads and title links cannot be deleted; no flag for a long stay's missing instalment. Still unchanged: the kept copy's byte-order mark (I11) and one file for two months (I13). The pages still say "Airbnb", the one platform there is.

### 41.3 How it was checked (2026-10-13, 14:24–14:36 Toronto)

- **Byte-identical:**
  - `node tests/run.mjs`: the six earlier checks identical; `airbnb-file` recorded;
  - 40 of 40 version-3 statements (`d36/v3-hash.mjs`);
  - dispatch 34's pure checks (dated 12 October) and small checks over the 11 October export, identical to `a4ad705`'s output.
- **Made-up files** (`tests/money/airbnb-file.mjs`): dispatch 36's October file and variants:
  - two identical rows: two lines, two keys;
  - a changed amount: a new key, and a warning beside the accepted one;
  - a "Pass Through Tot" row: a line that needs a decision;
  - the Guest column renamed: refused; the columns in lower case: read and blanked;
  - rows reversed: balanced day by day; one payout $1.00 wrong: unbalanced;
  - a renamed title whose long stay repeats its code: suggested, with its evidence; with disagreeing evidence: nothing suggested.

  Also checked there: statements placing lines (order, M11, the lock, the claim, a correction, a copy made before 37C), the Income page's view, Finish's checks, titles, the route schemas, and the property save's refusal.
- **Live, real time** on a local build reading production: build `jBkFC2X4bep4Lvmbwr3ok` (earlier `4V6G_-4tJ74tXQkdID5Pd`), 127.0.0.1:4500, a throwaway PIN, and the write guard (40 of 40 offline checks first). One Unlisted `__TEST__` property, `mNZIIoGbDMgw9uw8YRAd`, and three made-up files:
  1. On the edit page, "Change title" typed "__TEST__ d37c Loft" and saved it through Nubnb's dialog.
  2. The September file, uploaded on the Income page: 12 rows became 8 lines; the identical pair became 2 lines; the "Pass Through Tot" line was marked "Needs a decision"; "Accept all 7".
  3. One line edited and accepted, one rejected, the unknown type accepted on its own, the other five accepted together. Then one accepted line was edited from $900.00 to $880.00 ("edited since accepted").
  4. The property page listed the 7 file lines newest stay first, with Edit and Send back. September was finished with them and a typed line, and its PDF read back as printed. Edits and send-backs on its lines were then refused with `LINE_LOCKED`, and the page marked them "Locked".
  5. The late September file was uploaded after September was finished. Its line was accepted: "September 2026 is finished: on its October 2026 statement, with the day paid printed".
  6. The October file under "__TEST__ d37c Loft Renamed": the page offered the rename on the repeated booking code; accepting it made the old title previous. Its two lines were accepted.
  7. October was finished. Its PDF prints "Revenue - Sep 27–29, 2026 (paid Sep 29)" between October's own lines.
  8. After both statements were deleted, the late line returned to September's reopened draft, with nothing counted twice.
- **Cleanup.** The guard recorded 58 writes and refused none.
  - Through the app: both statements, their PDFs and download records; the property, with its owner record and unlisted mark.
  - By exact ID after an export (K13): the 11 lines, 3 uploads and their 3 kept files, 2 title links and 2 drafts.
  - The closing export (`2026-10-13T18-36-12Z`) is byte-identical, file for file, to the opening one (`18-24-39Z`). Storage's 6,622 objects are identical by name and generation.

### 41.4 Not exercised live

- **Not run live; checked only by pure tests or reading the code:**
  - moving a title between two properties (M13);
  - Send back and Reject all (only the lock's refusal of a send-back was exercised live);
  - the calendar-stays warning (the test property has no calendar), and I5's note.
- **Variants:** the made-up variants (Guest renamed, rows out of order, the changed amount) went through the reader only, not uploaded.

## 42. Admin accounts: dispatch 38 (2026-10-13)

Kian's rulings of 2026-10-13 are in `CLAUDE.md` under *Admin accounts*:
- one main admin, who adds and removes admins and sets their level;
- each admin has their own PIN, and every admin action names its admin;
- six-digit PINs, locked for 15 minutes after five wrong tries;
- the shared PIN stays the main admin's until he changes it;
- sessions are signed with their own secret.

What follows is the design reported before building, what was built, the developer's decisions where the rulings leave room, and how it was checked. `firestore.rules` and `storage.rules` are unchanged: the three new collections are server-only through the rules' catch-all deny, so no rules deploy goes with this.

### 42.1 The design, as reported before building

- **How PINs are stored.** Never as typed. Each admin document holds `scrypt(HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-pin:v1:" + pin), salt)`:
  - a random 16-byte salt;
  - N 2^15, r 8, p 1;
  - the scheme, the salt and the parameters stored beside the hash.

  `ADMIN_PIN_KEY` lives in the environment only, so a copy of the database, every `./backups/` export included, cannot be used to recover a PIN. Unlike cleaner codes, nobody can read an admin's PIN back, the main admin included.

  The shared PIN of today is not copied anywhere. The main admin's document says `pin: { state: 'shared' }`, and sign-in compares the typed PIN with `ADMIN_PIN` in constant time. Every check spends one scrypt, whichever kind it is, so timing does not tell the kinds apart.
- **How a session names its admin.** Sign-in is a name and a PIN. A lock on "that PIN" needs to know whose PIN was tried, which a PIN alone cannot say.
  - The token is `a1.<adminId>.<sessionEpoch>.<issuedAtMs>.<mac>`, an HMAC-SHA256 with `ADMIN_SESSION_SECRET`. The PIN is no longer the key.
  - The cookie keeps its name, path and attributes, so a new session replaces a PIN-signed one in the browser.
  - Each request checks the token, then reads the admin's document: it must exist and hold the token's epoch. The name, the level and the PIN's state come from that read.
  - A level change holds on the next request. A removal, a new PIN or a PIN change ends that admin's other sessions at once. The lifetime is 24 hours, absolute, as before.
- **What the main admin can do that an admin cannot:** the Admins page and its routes. There they can:
  - add an admin (name, level, temporary PIN);
  - remove one;
  - set a level;
  - give a new temporary PIN;
  - unlock a locked PIN;
  - read the activity log.

  Every other page and action is open to both levels.
- **How a locked PIN shows.**
  - The fourth wrong try warns: "One more wrong try locks it for 15 minutes."
  - After the fifth, the boxes grey out and the gate reads "Locked until 5:08 pm", in the browser's time. A try during the lock is refused unchecked, the right PIN included, and is not counted.
  - The Admins page shows the same "Locked until …" on the admin's row, with Unlock.
  - A name nobody holds always gets "Wrong name or PIN." and locks nothing.
- **How Kian gets back in if he forgets his PIN:**
  1. Run `node scripts/export-firestore.mjs`, as before every write.
  2. Run `node scripts/admin-recover.mjs Kian --write` with the service account in `.env.local`. It puts that main admin back on the shared PIN (`ADMIN_PIN` as Vercel has it), clears any lock and ends his sessions.
  3. Sign in with the shared PIN and set a new one.

  It refuses an account that is not a main admin. Such an admin gets a new temporary PIN from a main admin on the Admins page.

### 42.2 What was built

- **The library.** In `app/lib/admins/`:
  - `model.ts`: levels; PIN rules; the lock as pure functions (`lockHolding`, `afterTry`); names; `adminActor`; views; the activity log's words.
  - `secrets.ts`: the two keys, validated lazily, failing closed.
  - `pin.ts`: hashes and the shared PIN.
  - `session.ts`: the token, the cookie, the session check.
  - `schemas.ts` and `responses.ts`.

  `app/lib/firebase/server-admins.ts` holds:
  - sign-in with the lock;
  - the first main admin;
  - one's own PIN;
  - add, level, new PIN, unlock and remove;
  - the activity log.
- **The admin door.**
  - `app/lib/api/verify-admin.ts` exports `adminRoute(handler, { level?, record? })`. It checks the session (and the level, for the main admin's routes), hands the handler the admin and their `actor`, and after a response below 400 writes one `admin_actions` line through `after()`. The line records who, when, method, path and status. A GET is written only with `record: true` (the two downloads).
  - All 64 admin-gated handlers go through it, converted by an AST codemod that removed each `verifyAdminSession` pair, so no route keeps the PIN-signed check.
  - The public `GET /api/properties/[id]` reads the session itself: an admin gets an unlisted property, as before.
- **Who did it, in the records.** Every server function that wrote `ADMIN_ACTOR` takes the signed-in admin's actor instead:
  - cleaners (created, status, code, code released, rate);
  - cleanings;
  - cost entries (office entry, status, lines, tax, seen, cost-report exports);
  - Airbnb uploads, lines and title links;
  - finished statements;
  - report and month downloads.

  The cost history in the admin reads "Approved by <name>". A record made before keeps `{ role: 'admin', id: null, name: null }` and reads "an admin".
- **Routes:**
  - `POST/GET/DELETE /api/admin-auth`: sign in, who am I (clears a cookie that no longer opens anything), sign out;
  - `PUT /api/admin-auth/pin`: one's own PIN;
  - `GET/POST /api/admin/admins`, `PATCH/DELETE /api/admin/admins/[id]`, `POST …/[id]/pin`, `POST …/[id]/unlock`, `GET …/activity`: main admins only.
- **Pages:**
  - The gate (`PinGate.tsx`, `PinBoxes.tsx`): name and PIN, the lock, "Choose your PIN".
  - The header: the admin's name with Change PIN and Sign out (`AccountMenu.tsx`, `ChangePinDialog.tsx`), and "Admins" for main admins.
  - `/admin/admins`: the list, the add and new-PIN dialogs, and the activity.
- **Scripts:**
  - `scripts/admin-recover.mjs`;
  - `scripts/export-firestore.mjs` names the three new collections.
- **Tests:** `tests/admins/accounts.mjs` (`admin-accounts`) covers:
  - names and PIN rules;
  - the lock across a fifteen-minute boundary;
  - tokens: a PIN-signed one of before, a cleaner token, a changed MAC or epoch, the 24-hour edge;
  - PIN hashes;
  - a walk of every route file asserting that every admin handler goes through `adminRoute` and that every recorded write has words in the activity log.

### 42.3 Decisions, not rulings

- **The name at sign-in.** It is matched without regard to case or spacing, and kept unique by `admin_names/{key}`. Each device remembers the last name that signed in, so on his own devices Kian types only the PIN.
- **Temporary PINs.** A PIN the main admin sets, adding an admin or giving a new one, is temporary. It opens only "Choose your PIN"; every other route answers 403 `ADMIN_PIN_CHANGE_REQUIRED`. That way an admin's PIN is theirs alone, and the record of who did what means something.
- **The lock counts wrong tries in a row** since the last right one or the last lock. There is no window, and a lock that ends starts the count from nothing. Unlock (a main admin's button) ends a lock early.
- **Nobody acts on themselves** was the first version: no one could set their own level, remove themselves, or give themselves a new PIN, and a second main admin could have removed Kian. Superseded the same day by Kian's ruling that a main admin cannot be removed, demoted or given a new PIN by anyone but themselves (§42.7).
- **Too easy.** New PINs refuse one digit six times and straight runs (20 PINs), as cleaner codes refuse theirs.
- **The first main admin.** While no admin exists, the first sign-in attempt by the name Kian creates him as main admin on the shared PIN, before the PIN is checked, so the lock counts from his first try. Once any admin exists this never happens again: removing Kian does not let the shared PIN make him anew.
- **The activity log** records successful writes only: what was done, not what was tried. It records the path, never the query or the body, which can hold PINs, codes and names. Sign-ins are not logged; `lastSignedInAt` is kept on the admin.
- **What owners receive does not change.** An owner's workbook still says "Office" for an admin's action. Nubnb's own workbook prints the actor's name beside the role, as it already did for cleaners.
- **Cleaner codes** are still kept clear of `ADMIN_PIN`. It is the main admin's PIN until he changes it, and the recovery PIN after that.
- **The session secret.** The `ADMIN_SESSION_SECRET` already in `.env.local` was never read by the app and is not base64url, so it is refused and must be replaced.

### 42.4 Before deploying

1. Generate `ADMIN_SESSION_SECRET` and `ADMIN_PIN_KEY`, each `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Put both in Vercel Production and `.env.local`, with copies in a password manager. Without the first, nobody can sign in. Without the second, only the main admin on the shared PIN can sign in, and no PIN can be set.
2. Keep `ADMIN_PIN` set.
3. After the deploy, sign in as "Kian" with the shared PIN; the first attempt creates the main admin. Then use Change PIN.
4. Every session signed with the PIN ends at the first request after the deploy.

### 42.5 How it was checked (2026-10-13, 16:31–17:12 Toronto)

- **Byte-identical:**
  - `node tests/run.mjs`: the seven earlier checks identical; `admin-accounts` recorded, then recorded again after the reserved-name fix below, which added two lines;
  - 40 of 40 version-3 statements (`d36/v3-hash.mjs`, run against this tree);
  - `tsc` clean apart from the stale `.next` validator entries; lint equal to the baseline (the same three errors and seven warnings, none in these files).
- **The setup.** Live, real time, on a local build reading production: 127.0.0.1:4500, a throwaway shared PIN and throwaway keys, and the write guard (30 of 30 offline checks first).
  - `9dLEGY6oV0JzqZ7cBWEEO` dropped digits typed quickly into the PIN boxes. Fixed (the boxes read their latest value from a ref) before any write.
  - `wEYI0cSOWzy4JgPjO4Bx0` served checks 1–10.
  - `O07_rX5Dx_Vo1xpKKoy-Y` served the rest. It carries the fix for names the key cannot hold (`__…__`), which made the add 502 and sign-in 503 instead of refusing; that fix was exercised live.
  - The opening export is `2026-10-13T20-31-01Z`.
- **The checks:**
  1. **Sessions from the PIN signing.** A token made by HEAD's own code with the server's PIN was valid there. On this server it got 401 `ADMIN_SESSION_INVALID` from every admin route and from the gate's check, which cleared the cookie (`Max-Age=0`). A browser holding it (78 characters) loaded `/admin` and showed the sign-in, with the cookie gone.
  2. **The first main admin.** The first sign-in as Kian with the four-digit shared PIN created `admins/JDVSEoKv0UpAUSe6UUpC` and `admin_names/kian`. The header showed "Kian", with the amber shared-PIN dot, and "Admins".
  3. **Adding admins.** The main admin added `__TEST__ Ada` on the Admins page and `__TEST__ Bo` through the API; each add wrote an activity line. A name differing only in case and spacing was refused (409), and 123456 was refused (422).
  4. **Temporary PINs.** Ada's six-digit temporary PIN opened "Choose your PIN" and nothing else. Bo's temporary session got 403 `ADMIN_PIN_CHANGE_REQUIRED` from an admin route until he chose his PIN.
  5. **An admin refused the main admin's pages.** Ada's page read "Only a main admin manages admins". All eight main-admin requests got 403 `MAIN_ADMIN_ONLY`; nothing was written.
  6. **Each action records the right admin.**
     - The cleaner: created by Ada, rate set by Bo, deactivated by Kian.
     - The cost entry: sent and approved by Bo, removed by Ada.
     - One activity line each, under the right name. The Costs page read "Approved by __TEST__ Bo … Removed by __TEST__ Ada".
  7. **A level change.** Bo was refused the Admins list, made a main admin, and allowed it on his next request; made an admin again, refused again. Kian could not change his own level, remove himself or give himself a PIN (409 `ADMIN_IS_YOU`).
  8. **The lock.**
     - Four wrong tries got 401; the fourth carried the warning. The fifth got 429, locked until 21:08:30.048Z.
     - The sixth, Ada's right PIN, got 429. A try at 3.2 minutes got 429 and was not counted.
     - The gate read "This PIN is locked. Locked until 5:08 pm." with the boxes disabled; the Admins page showed "Locked until 5:08 pm" with Unlock. Her existing session kept working.
     - At 16.9 minutes her right PIN got 200, with the lock and the count cleared.
  9. **The recovery script.** It refused an admin who is not a main admin. On main-admin Bo it put him back on the shared PIN: his session ended, his own PIN got 401, the shared PIN got 200 as a main admin, and his history recorded `pin_reset` by "recovery script". It writes outside the guard, to a document removed after.
  10. **Kian changes his PIN** from the header's menu. His other session ended; the shared PIN got 401 for Kian; the new PIN got 200; the browser that changed it carried on, without the dot.
  11. **Removal ends sessions.** Ada's and Bo's sessions got 401 at once, and Ada's browser showed the sign-in. Her name no longer signed in. Kian alone remained. The Admins page listed the run's 20 activity lines.
  12. **Sign out** took the cookie off the browser, and a reload stayed signed out. It wrote nothing.
- **A stop and a restart.** The first attempt at check 5, written as `bash -c 'source …'`, was refused by a built-in permission check. The run stopped there and Kian was told. On his approval it went on as plain script files (`node checks/<n>.mjs`); nothing else was refused.
- **Cleanup.** The guard recorded 67 writes and refused none.
  - Through the app: the cost entry, the property (with its unlisted mark, owner record and name for cleaners), the cleaner, then Ada and Bo through the Admins API.
  - By exact ID after an export (`2026-10-13T21-11-10Z`), approved by Kian: Kian's admin document, `admin_names/kian`, the 20 activity lines and the test cleaner's retired code, 23 of 23, each checked for what it held and deleted with its update time as a precondition.
  - The closing export (`2026-10-13T21-12-01Z`) is byte-identical, file for file, to the opening one. Storage's 6,622 objects are identical by name and generation.

### 42.6 Not exercised live

- **Admins-page actions:**
  - Unlock (the lock ended by itself after the real fifteen minutes): checked only by reading the code;
  - New PIN… for another admin: through the API only, in §42.7's round, not from the page's dialog;
  - Make main admin and Remove: run through the API only, not from the page's buttons.
- **The 503 paths** with a key missing: checked only by reading the code.
- **Concurrent tries** on one PIN, and two first sign-ins at once: the transactions are meant for them, but neither was run.
- **Production.** Kian's first sign-in after the deploy, with the production `ADMIN_PIN` and keys, is his to do (CLAUDE.md: a live admin session is Kian's check).

### 42.7 After the first report: masked boxes, and a main admin's account their own (Kian's rulings of 2026-10-13)

- **PIN boxes mask their digits** on the sign-in gate, Choose your PIN and Change PIN. `PinBoxes` gives each box only a dot to show. The digits stay in the caller's state, and a key typed into a box is read from what the box then holds, the dot taken out, so masking does not depend on the browser. The main admin's temporary-PIN field on the Admins page is not a PIN box: it shows what they type, since they hand that PIN on.
- **A main admin cannot be removed, demoted or given a new PIN by anyone but themselves.** One rule, `accountVerdict` in `admins/model.ts`, decides it for the server functions (inside their transactions) and for the page's buttons:
  - another main admin's account is refused: 409 `MAIN_ADMIN_PROTECTED`;
  - a main admin may step down or remove themselves while another main admin remains, otherwise 409 `LAST_MAIN_ADMIN`;
  - their own PIN is changed with Change PIN, as before;
  - promoting an admin and unlocking stay open.

  The page shows another main admin's row as "Theirs to manage", with Unlock only during a lock. Your own row has Step down and Remove myself… while another main admin remains. Removing yourself clears your cookie and returns you to the sign-in.
- **Decisions, not rulings:**
  - **The last main admin** cannot step down or leave, so someone can always reach the Admins page.
  - **Promoting is one-way** for the main admin who does it: the confirmation says so ("Only they can step down or leave: you cannot undo this").
  - **The recovery script** is outside the admin. It is run with the service account, which only Kian holds, so it stays the way back in for any main admin.
- **How it was checked** (2026-10-13, 17:25–17:30 Toronto). Build `x1QxiEe_hvwrHNu0PlfXg` on 127.0.0.1:4500, a new guard ledger, opening export `2026-10-13T21-25-10Z`:
  - **The boxes** held `["•","•","•","•","",""]` on the gate and six dots in every other group. No digit was in any box, and the PIN appeared neither in the page's text nor in its boxes, on all three. Signing in, choosing a PIN and changing one worked with them.
  - **Two main admins on each other.** With Bo made a main admin, each of the two was refused removing, demoting and re-PINing the other: six 409 `MAIN_ADMIN_PROTECTED`, nothing written. An admin was still given a new PIN.
  - **Their own accounts.** Bo stepped down and lost the Admins page. Kian, then alone, was refused stepping down and removing himself (409 `LAST_MAIN_ADMIN`). Bo, made main again, removed himself: his cookie was cleared and his old session answered 401.
  - **The test record:** `tests/admins/accounts.mjs` prints the rule for every action and case.
  - **Cleanup.** The guard recorded 33 writes and refused none. Ada and Bo went through the app. After export `2026-10-13T21-28-42Z`, Kian's admin document, `admin_names/kian` and the 11 activity lines were deleted by exact ID (K13), 13 of 13. The closing export `2026-10-13T21-29-24Z` is byte-identical to the opening one. Storage's 6,622 objects are identical.

## 43. Sign-in by PIN alone: Kian's rulings of 2026-10-13 (evening)

Kian's rulings are in `CLAUDE.md` under *Admin sign-in*:
- an admin signs in with their PIN alone, and the PIN identifies them;
- every PIN is unique; the main admin names an admin when adding them, and an admin can change their own name;
- PINs are generated by Nubnb, never chosen, and shown once;
- five wrong PINs from one connection lock sign-in from it for 15 minutes, a lock the main admin can lift; the connection is stored only as a keyed hash;
- the shared PIN, `ADMIN_PIN`, stays only as the recovery script's PIN.

They replace dispatch 38's sign-in rulings: a name typed before the PIN, a lock on the PIN, and the shared PIN being the main admin's until changed. `firestore.rules` and `storage.rules` are unchanged: the two new collections, `admin_pins` and `admin_signin_locks`, are server-only through the rules' catch-all deny, so no rules deploy goes with this.

### 43.1 The design, as reported before building

- **How a PIN finds its admin.** Each PIN has one lookup key, the same every time: `hex(scrypt(HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-pin-lookup:v1:" + PIN), a fixed salt))`, N 2^15, r 8, p 1. The key is the ID of the PIN's `admin_pins` document, which names its admin; the admin's document holds the same key.
  - Sign-in works out the key once and reads that one document: one hash and one read, however many admins there are. No admin's hash is tried.
  - The PIN is stored nowhere. Without `ADMIN_PIN_KEY` a copy of the database cannot be turned back into PINs.
  - The `admin_pins` document is created with `create()`, which fails when any admin holds that PIN: that keeps PINs unique, and Nubnb draws again.
- **The connection.** On Vercel it is the address in `x-real-ip`, which Vercel sets and overwrites; then the first entry of `x-forwarded-for`; else one shared "unknown". An IPv6 address counts as its /64. Only `HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-connection:v1:" + address)` is kept, as the ID of the connection's `admin_signin_locks` document, which holds the count, the lock's end and the last wrong PIN's time.
- **Kian's document** is left as it is, on the PIN he chose under the first version, which no longer signs him in (it has no lookup key). He gets a generated PIN either from New PIN in an open session, or through the recovery script and the shared PIN. Nothing is backfilled.
- **A consequence reported then:** a lock per connection does not stop someone with many connections, and with PIN-only sign-in every guess can hit any admin's PIN.

The read counts reported then were one short; §43.5 gives the measured ones.

### 43.2 What was built

- **The library.**
  - `admins/model.ts`: the PIN states (`set`, a generated PIN; `shared`; the first version's `own` and `temporary`, read but never written); the lock per connection (`lockHolding`, `afterTry`, unchanged); `normalizeAddress`.
  - `admins/pin.ts`: `pinLookup`, `connectionKey`, `drawPin`, `sharedPinLength`, `sharedPinMatches`, and the first version's `pinMatches`, kept for New PIN.
  - `admins/connection.ts`: the connection's keyed hash, from the request.
  - `firebase/server-admins.ts`: sign-in by lookup with the connection's lock; New PIN; Change name; adding an admin and giving one a new PIN, both generated; removal, which deletes the name's and the PIN's index entries; listing and lifting locks.
- **Routes:**
  - `POST /api/admin-auth` takes `{ pin }` alone;
  - `POST /api/admin-auth/pin` (New PIN) takes `{ currentPin }` and answers `newPin`;
  - `PUT /api/admin-auth/name` (Change name);
  - `POST /api/admin/admins` takes `{ name, level }` and answers `pin`; `POST /api/admin/admins/[id]/pin` answers `pin`;
  - `GET /api/admin/admins/locks` and `DELETE /api/admin/admins/locks/[id]`, main admins only.

  `POST …/[id]/unlock` and `PUT /api/admin-auth/pin` are gone.
- **Pages:**
  - The gate: six masked boxes and nothing else; the lock's line; after a sign-in with the shared PIN, a card with the generated PIN before anything else.
  - The header's menu: Change name, New PIN, Sign out. A dot while the admin's PIN is not one Nubnb generated.
  - `PinReveal` shows a generated PIN once, in two groups of three.
  - The Admins page: Add admin asks for a name and a level only; New PIN… on an admin's row asks first. Both show the PIN in a dialog that closes only by its button (the admin dialog's new `dismissible` option). Locked connections are listed with Lift. Unlock and the lock columns are gone.
- **Scripts:**
  - `admin-recover.mjs` puts a main admin on the shared PIN, deletes their PIN's index entry and ends their sessions. It refuses while another main admin is on the shared PIN.
  - `export-firestore.mjs` names the two new collections.
- **Tests:** `admin-accounts` was re-recorded. It covers generated PINs (fed numbers: too easy, the shared PIN, padding), lookup keys, the connection (every address shape, the /64, the headers), the lock, tokens, the first version's hashes and the route walk, which now includes the three new routes. The other seven suites are unchanged.

### 43.3 Decisions, not rulings

Kian confirmed six of these on 2026-10-13: New PIN asking for the current PIN, locks listed by time only, the shared PIN signing in only while exactly one main admin is on it, the reveal closing only by its button, the count not fading, and a lock record staying until a right PIN. He also confirmed the two `CLAUDE.md` edits that were the developer's: the sentence keeping rate limiting ruled in for admin sign-in, and the shortened masking ruling.


- **New PIN from your own menu asks for your current PIN first,** so a stolen session cannot turn itself into a lasting PIN. Wrong ones count toward the connection's lock like sign-ins.
- **Locked connections are listed by time only:** when the lock ends and when the last wrong PIN came. No address is kept, so none can be shown.
- **The shared PIN signs in only a main admin on it,** put there by the recovery script (or the first sign-in of an empty database), and only while exactly one is.
- **The shared PIN cannot be found by timing.** Every PIN of its length that no admin holds reads the main admins the same way. A new PIN is drawn, which costs a hash, only once a sign-in by the shared PIN is certain, in a second pass of the transaction. The first build drew it as soon as the shared PIN was typed, so the shared PIN answered measurably slower whether or not anyone was on it. That was found while building and fixed before the checks.
- **The count does not fade.** It counts wrong PINs in a row since the last right one or the last lock, with no window.
- **A lock document stays** after its lock ends, with a past time and a count of 0, until a right PIN from that connection deletes it. It holds no address.
- **A first-version session still opens,** so Kian can use New PIN in a session he holds at the deploy. A first-version `temporary` session is no longer limited to choosing a PIN; production has none.
- **Generated PINs** are `randomInt(0, 1_000_000)`, drawn again while too easy (20 PINs) or equal to `ADMIN_PIN`, and drawn again (up to five times) when another admin holds the PIN.
- **The account name in the header** is shown whole up to about 40 characters (24em; 40% of the window on a phone), and whole in the menu at any length. It was cut at 10em until the header ruling (§43.7) gave long names a row's room.

### 43.4 Before deploying

1. Nothing new to set: `ADMIN_SESSION_SECRET`, `ADMIN_PIN_KEY` and `ADMIN_PIN` stay as they are.
2. Kian's chosen PIN stops signing him in at the deploy. Either:
   - sign in on the current site before the deploy (sessions last 24 hours and survive it), then use New PIN in the menu with the chosen PIN; or
   - after the deploy, run `node scripts/export-firestore.mjs`, then `node scripts/admin-recover.mjs Kian --write`, then sign in with `ADMIN_PIN` alone.

   Either way the generated PIN is shown once.
3. No rules deploy.

### 43.5 How it was checked (2026-10-13, 19:15–19:41 Toronto)

- **Byte-identical:**
  - `node tests/run.mjs`: the seven other suites identical; `admin-accounts` re-recorded after reading its output, which was identical across two runs;
  - the 40 version-3 statements, 40 of 40;
  - `tsc` clean apart from the stale `.next` validator entries; lint equal to the baseline (three errors and seven warnings, none in these files).
- **The setup.** A local build reading production on 127.0.0.1:4500, with throwaway keys and a write guard that refused any write to Kian's document or name (45 of 45 offline checks first). It also counted every read and could force the server's next PIN draws. Opening export `2026-10-13T23-15-29Z`.
  - Production already has a main admin, so two test main admins were seeded directly: one on a generated PIN, and one shaped as Kian's document is today (a chosen PIN hashed by f135b03's own code, and a session made the way f135b03 makes them).
  - Builds: `8QpOsCsWHh_Lmias4hMFM` for checks 1–10; `dWTDbyW01INCfGeWL-90L` (the shared-PIN reads narrowed to main admins) for 11–14; `Zr9VPVyuu0rAaZZpWj5Lo` (the reveal's spacing) for 15–16. Check 12's lock was set on the first build and ran out on the second.
- **The checks:**
  1. **Sign-in by PIN alone**, through the API and at the gate: no name field, six masked boxes, the right admin named. A body carrying a name was refused (400). The first version's chosen PIN got 401.
  2. **Generated, unique, shown once.** Adding `__TEST__ Ada` showed her PIN once, in a dialog that neither Escape nor a click outside closed. After "I have noted it" the PIN was nowhere in the page, after a reload, or in the list's answer.

     Bo's draws were forced to Ada's PIN, then another number: he got the other one. Ada's own New PIN, forced onto Bo's PIN first, was drawn again.
  3. **Refused:** Ada, an admin, got 403 on all 8 main-admin requests and wrote nothing.
  4. **Who did it:** Ada added a test cleaner, Bo set her rate, the main admin deactivated her. Each was recorded under the right name, in her history and in the activity log.
  5. **Levels and main admins:**
     - Bo was made a main admin and stepped down himself.
     - Nine requests by a main admin to remove, demote or re-PIN another (Bo, the test main admin, Kian) were refused (409), with nothing written.
     - A new PIN for oneself through the Admins route was refused (409 `ADMIN_IS_YOU`).
  6. **Change name** from the menu. Another admin's name, case and spacing aside, got 409; `__x__` and a blank name got 422; a case-only change kept the index entry. The history holds each name before and after. The old name was free for someone new.
  7. **New PIN, own menu:** a wrong current PIN was refused and counted. The right one gave a new PIN, shown once. Her other session got 401, the old PIN 401, the new one 200.
  8. **New PIN for an admin,** from the main admin's page: asked first, shown once, the history's `pin_reset` naming the main admin.
  9. **The lock:**
     - Four wrong PINs got 401, the fourth with the warning; the fifth got 429.
     - The right PIN during the lock got 429 (one read, no hash).
     - Another connection signed in. Two addresses in one /64 shared a lock; the next /64 did not.
     - The stored locks hold only the count and the times, under keyed-hash IDs.
     - Lift on the Admins page re-opened sign-in.
     - At the gate: "Five wrong PINs. Locked until 7:41 pm.", with the boxes disabled. A local browser counts as 127.0.0.1.
     - Wrong current PINs in New PIN locked the connection, and the session kept working.
  10. **Kian's path,** on the test copy of his document: his open session showed the dot and the chosen PIN in the menu. New PIN with the chosen PIN gave a generated one, shown once. The document went from the salted hash to a lookup key, with an index entry and `pin_generated` (from `own`).
  11. **Timing.** With nobody on the shared PIN:

      | Try | Tries | Median | Reads |
      |---|---|---|---|
      | The shared PIN, four digits | 40 | 300 ms | the same 3 |
      | Other four digits | 40 | 291 ms | the same 3 |
      | Six digits, wrong (one hash) | 20 | 339 ms | 3 |

      Per connection, shared minus other ran from −28 to +102 ms, median 10: noise. A hash's worth of time would show.
  12. **The real fifteen minutes:** at 14.5 minutes the right PIN got 429; at 15.08 it got 200.
  13. **Recovery:**
      - The script refused an ordinary admin, then put the test main admin on the shared PIN and deleted their index entry. It refused a second main admin while one was on it.
      - Their session got 401 and their old PIN 401.
      - The shared PIN alone, at the gate, showed the new-PIN card first. After it, the shared PIN got 401 and the generated one 200.
      - The test main admin was on the shared PIN for 12.3 s at most.
  14. **A PIN-signed session from before dispatch 38** got 401 everywhere, with the cookie cleared.
  15. **The final build:** the reveal with 14 px under it, in both dialogs; the header's name cut at 130 px. A PIN just shown signed in alone.
  16. **Removal** ended sessions and freed PINs and names. Sign out took the cookie off the browser. Both test main admins removed themselves while Kian remained.
- **Measured costs** (document lookups found or not, and writes):

  | Sign-in try | Reads | Writes | Hash |
  |---|---|---|---|
  | Connection locked | 1 | 0 | none |
  | Wrong, six digits | 3 (the lock twice, the index) | 1 | 1 |
  | Wrong, the shared PIN's length | 2, plus 1 per main admin | 1 | none |
  | Right PIN | 4 (the lock twice, the index, the admin) | 1, plus 1 when the connection had a count | 1 |
  | Lift | 1 for the session, 1 for the lock | 1 delete, 1 activity line | — |

  The lock is read twice: once before any hash, so a locked connection costs none, and once inside the transaction that counts the try.
- **Cleanup.** The guard recorded 307 writes, none refused, none in Storage, and none to Kian's document or name.
  - Through the app: every test admin, name, PIN index entry and the cleaner.
  - By exact ID after export `2026-10-13T23-39-50Z`: the 28 activity lines, the retired test code and 5 lock documents, each checked for what it held and deleted with its update time as a precondition, 34 of 34.
  - The closing export, `2026-10-13T23-41-16Z`, is byte-identical to the opening one, file for file. Storage's 6,622 objects are identical by name and generation.

### 43.6 Not exercised live

- **The first main admin of an empty database:** production has one.
- **The last main admin's refusal:** Kian is always another main admin; the rule is in the test.
- **Forced collisions** for the main admin's New PIN and for the shared sign-in's draw (the same pattern as the two forced).
- **The 503 paths** with a key missing.
- **Production:** Kian's own New PIN or recovery after the deploy is his to do.
- **The header** at 1280 px: sections and actions did not fit side by side on the Admins page. That predated this round; Kian's ruling fixed it (§43.7).

### 43.7 The header's section links on their own row (Kian's ruling of 2026-10-13, evening)

The ruling is in `CLAUDE.md` under *Admin header*: below 1400 px wide, the admin header's section links sit on their own row under the brand and the actions, on every admin page.

- **What was built.** `page.module.css` puts the links on their own row below 1400 px, the layout phones already had, without its sideways scroll above 860 px. Phones keep theirs.
- **A decision, not a ruling: the header measures as well.** One row needs the brand, the links and the actions side by side. With a long name it needs more than the header ever has: the header is at most 1440 px wide, 1,376 px inside. Measured on the Admins page with a 36-character name, one row needs 1,534 px.

  So from 1400 px up, `AdminHeader` puts the links on their own row whenever the three do not fit on one, and back on the brand's row when they do. It measures the links' own widths, which do not change with the layout, so it cannot flip back and forth. It measures again before the first paint and whenever a width changes.
- **The name** in the header now shows whole up to about 40 characters (§43.3).
- **How it was checked** (2026-10-13, 20:41–20:45 Toronto). Build `syfDnDWmm23nBEFX_Wqzy` on 127.0.0.1:4500, under the same guard. Opening export `2026-10-14T00-40-56Z`.
  - A main admin named `__TEST__ Main admin with a long name` was seeded and signed in with the PIN alone. The Admins page and the property list were checked at 1280, 1400 and 1700 px.
  - Each check printed what overlaps, what is cut off, whether the name shows whole and whether the page scrolls sideways: none, none, yes and no, in all six.

    | Page | One row needs | Room at 1280 / 1400 / 1700 | Links on their own row |
    |---|---|---|---|
    | Admins | 1,534 px | 1,216 / 1,336 / 1,376 | all three |
    | Property list | 1,441 px | 1,216 / 1,336 / 1,376 | all three |
  - With "Kian" in place of the name, set in the page alone with nothing written, one row needs 1,315 px on the Admins page and 1,223 on the property list. The links sat on their own row at 1280 and on the brand's row at 1400 and 1700, with no overlap and nothing cut off.
  - At 1024, 860 and 800 px nothing overlapped and nothing scrolled sideways.
  - At 390 px the links scroll inside their row, as on phones before. The page's own buttons run past the edge, as they did on the live site; phones were not in the ruling.
  - **Cleanup.** The test admin removed itself from the Admins page, with Kian remaining, and was signed out. Its one activity line was deleted by exact ID after export `2026-10-14T00-44-34Z`. The guard recorded 8 writes, none refused, none to Kian's document or name. The closing export `2026-10-14T00-44-55Z` is byte-identical to the opening one. Storage's 6,622 objects are identical.


## 44. PINs set by the main admin, stored readably: Kian's rulings of 2026-10-13 (night)

Kian's rulings are in `CLAUDE.md` under *Admin PINs*, with the accepted risk under *Accepted risks*:
- the main admin sets each admin's PIN when adding them, and can change any ordinary admin's; Nubnb no longer generates PINs; an admin can still change their own;
- main admins see every admin's PIN, their own included, on the Admins page; PINs are stored readably, so any copy of the database holds every admin PIN, and a main admin can act as any admin;
- admin PINs stay six digits; PINs stay unique; sign-in stays PIN only; the connection lock stays;
- the Add an admin dialog opens on Admin.

They replace the evening's generated PINs, shown once, and its sign-in with the shared PIN giving a generated one. `firestore.rules` and `storage.rules` are unchanged.

### 44.1 The design, as reported before building

- **How a PIN finds its admin now.** The PIN itself is the ID of its index document, `admin_pins/{PIN}` → `{ adminId }`, the way `cleaner_codes/{code}` works.
  - The admin's document holds `pin: { state: 'readable', value }`.
  - Sign-in reads the one index document, then the admin's, and compares the stored PIN in constant time. No hash.
  - `create()` on the index keeps PINs unique.
  - `ADMIN_PIN_KEY` stays for the connection's keyed hash, and for checking an older PIN when its holder sets theirs.
- **Kian's document** (the first version's chosen PIN, a salted hash) is not rewritten by anything. It moves to the readable shape the first time he types his PIN to the new code:
  - with a session he holds, the gate asks him to set his PIN before anything else: his current PIN, checked against the hash, then the one he wants, which may be the same;
  - without one, through the recovery script and the shared PIN, then the same step.

  His leftover `failedTries` and `lockedUntil` fields stay.
- **A consequence reported then.** Refusing a PIN because another admin holds it tells the chooser that admin's PIN. For main admins that is no news. For an ordinary admin changing their own, every change counts toward the connection's lock like a sign-in try, so choosing is no faster than guessing at the door.

### 44.2 What was built

- **The library.**
  - `admins/model.ts`: the `readable` state; `pinProblem` (six digits, not too easy); the `set-pin` action; `AdminSummary.pinValue`; `pin_set` in the history.
  - `admins/pin.ts`: `samePin` for comparing two PINs; the evening's `pinLookup` and the first version's `pinMatches` kept for checking older PINs; no generation.
  - `firebase/server-admins.ts`:
    - sign-in by the PIN's own index;
    - `changeOwnPin` for one's own menu and the gate, counted;
    - `createAdmin` with the PIN set;
    - `setAdminPin` for an ordinary admin;
    - removal deletes the readable index entry or the evening's.
- **Routes:**
  - `POST /api/admin/admins` takes `{ name, level, pin }`;
  - `POST /api/admin/admins/[id]/pin` takes `{ pin }`;
  - `POST /api/admin-auth/pin` takes `{ currentPin, newPin }`.

  The refusals: 409 `ADMIN_PIN_TAKEN`, 409 `ADMIN_PIN_SAME`, and 422 for a PIN that is not six digits, is too easy, or is the shared PIN.
- **Pages:**
  - The gate's **Set your PIN** card replaces the evening's generated-PIN card. It shows for a session holding a PIN that is not readable, and after a sign-in with the shared PIN, which is carried over as the current one.
  - The menu's **Change PIN** replaces New PIN: current PIN, new PIN, again, all masked.
  - The Admins page:
    - shows each readable PIN to the main admin, and "Kept before: not readable" or "Shared PIN" otherwise;
    - the Add dialog takes a PIN in a plain field and opens on Admin;
    - an ordinary admin's row has Change PIN….

  `PinReveal`, `NewPinDialog` and the dialog's `dismissible` option are gone.
- **Script:** the recovery script deletes a readable index entry too.
- **Schema:** new admin documents carry `schemaVersion: 3`.
- **Tests:** `admin-accounts` re-recorded. The PIN rules, comparing PINs and the older PINs' checks replace the generation checks.

### 44.3 Decisions, not rulings

- **Every change of one's own PIN counts toward the connection's lock,** successful ones included (§44.1). Otherwise a run of successful changes would let someone probe for free. A change to the PIN one already has does not count. Kian confirmed this on 2026-10-13.
- **The main admin types a PIN in a plain field** with the digits shown, adding an admin or changing one's PIN: they see every PIN, and hand this one on. One's own PIN is typed in masked boxes.
- **Too-easy PINs are refused,** as cleaner codes refuse theirs. So is the shared PIN, should `ADMIN_PIN` ever be six digits.
- **Set your PIN comes before anything else** for a session whose PIN is not readable, and after a sign-in with the shared PIN. It has a Sign out link.
- **A PIN of the first version or the evening no longer signs in.** The main admin sets an ordinary admin's; a main admin sets their own through a session or the recovery path.
- **The shared PIN's digits are not shown;** its row reads "Shared PIN".

### 44.4 Before deploying

1. Nothing new to set: `ADMIN_SESSION_SECRET`, `ADMIN_PIN_KEY` and `ADMIN_PIN` stay.
2. Kian's way to a readable PIN:
   - With his session from 22:21Z on 13 October, which lasts until 22:21Z on 14 October, the admin opens on Set your PIN: his chosen PIN, then the one he wants, which may be the same.
   - After that: export, `node scripts/admin-recover.mjs Kian --write`, then the shared PIN alone, then the same step.
3. An admin added on the live site before this deploys has an evening PIN. After the deploy it no longer signs in, and Kian sets a PIN for them on the Admins page.
4. No rules deploy.

### 44.5 How it was checked (2026-10-13, 21:40–21:49 Toronto)

- **Byte-identical:** the seven other test suites; the 40 version-3 statements; `tsc` clean; lint at the baseline.
- **The setup.** A local build reading production, with throwaway keys and the write guard, now taking six-digit `admin_pins` IDs (49 of 49 offline). Builds `jQqcUq20rMu8cgJj7HuNh` for checks 1–9, `GoQ_g-XoDXedRDUgwNTkI` (schema 3, the recovery script's wording) for check 10. Opening export `2026-10-14T01-40-05Z`. Seeded directly:
  - a main admin on a readable PIN;
  - `__TEST__ Legacy`, shaped as Kian's document, with a session made as f135b03 makes them;
  - `__TEST__ Eve`, an admin on an evening PIN.
- **The checks:**
  1. **Sign-in by PIN alone:** 4 reads for a right PIN, 3 for a wrong one, no hash. The session's answer holds no PIN. Legacy's chosen PIN and Eve's evening PIN got 401.
  2. **The Add dialog** opened with Admin checked and highlighted; its button read "Add admin". Ada was added with the PIN typed, shown as typed, and signed in with it alone.
  3. **A PIN another admin holds:** refused at adding, on the page and through the API, and at changing Bo's PIN. Too easy and four digits got 422.
  4. **The main admin changed Bo's PIN:** his session got 401, the old PIN 401, the new one 200, and his history records `pin_set` by the main admin.
  5. **Visible to a main admin, and nobody else.** The main admin's page shows his own, Ada's and Bo's PINs, each in its row, and the list's PINs are each admin's own. Ada got 403 on the list. No PIN appeared in her session's answer, in any page she opened, in the activity log or in the server's log.
  6. **Ada's own Change PIN,** in masked boxes:
     - a wrong current PIN, Bo's PIN and her own PIN were each refused with their own words;
     - a free PIN was set;
     - wrong, taken and set each counted on the connection; "already" did not;
     - five changes in a row from one connection locked it, so the sixth change and a sign-in from there got 429.
  7. **The lock:** five wrong PINs got 429, and the right PIN during the lock got 429 with one read. Lift on the page cleared both locks; both connections signed in.
  8. **Kian's path:** Legacy's session opened on Set your PIN, with no admin page behind it. He kept his chosen PIN. The document went to `readable`, with its index entry and `pin_changed` from `own`. The old session got 401, and his PIN signed in at the door.
  9. **Recovery and the evening admin:**
     - **Eve:** the main admin set her PIN from her row. Her lookup entry was deleted and a readable one created; the evening PIN got 401, the new one 200.
     - **Recovery:** the script refused an ordinary admin and a second main admin. On the test main admin, the shared PIN at the gate opened Set your PIN with only the new PIN's boxes. Afterwards the shared PIN and the old PIN got 401. It was on the shared PIN for 19.6 s at most.
  10. **On the final build:**
      - an ordinary admin was refused all 8 main-admin routes and wrote nothing;
      - nine attempts by a main admin on another main admin's account got 409, three of them on Kian's, and a PIN for oneself through the Admins route got 409;
      - a PIN-signed session from before dispatch 38 got 401;
      - a name change was recorded;
      - a new admin was written with schema 3;
      - removal ended sessions and freed PINs, and a freed PIN was set again;
      - sign out cleared the cookie.
- **Cleanup.** The guard recorded 148 writes, none refused, none to Kian's document or name.
  - Through the app: every test admin, name and PIN index entry.
  - By exact ID after export `2026-10-14T01-48-45Z`: 26 activity lines and 4 lock documents, 30 of 30.
  - The closing export `2026-10-14T01-49-28Z` is byte-identical to the opening one, file for file. Storage's 6,622 objects are identical.

### 44.6 Not exercised live

- **The first main admin of an empty database:** production has one.
- **Two changes of one's own PIN at the same moment,** and a change racing a sign-in.
- **Production:** Kian's own Set your PIN after the deploy is his to do.

## 45. Four-digit admin PINs, never a cleaner code: Kian's rulings of 2026-10-13 (late night)

Kian's rulings are in `CLAUDE.md` under *Admin PINs and cleaner codes*:
- admin PINs are four digits;
- no admin PIN may equal any cleaner code ever issued, current or retired, and no cleaner code may be issued or changed to any admin PIN; both doors check the same index;
- the connection lock stays (five wrong PINs, 15 minutes), and twenty wrong PINs from one connection in a Toronto day lock it until a main admin lifts it;
- everything else from the night stands: main admins set and see every PIN, sign-in by PIN alone, unique PINs, Admin as the default level;
- the too-easy list is the one cleaner codes use, and ADMIN_PIN stays refused as any admin's own PIN;
- Kian's account: the recovery script puts him on the shared PIN, and Set your PIN takes four digits.

They replace the six digits of dispatch 38 and of the night. `firestore.rules` and `storage.rules` are unchanged.

### 45.1 The design, as reported before building

- **Production, read only:**
  - Kian's document is `own` (the first version's chosen PIN, a salted hash), epoch 2, last signed in 22:21:18Z on 13 October;
  - `admin_pins` is empty;
  - one lock record holds 3 wrong PINs at 03:10Z on 14 October, not locked; it was left alone;
  - `cleaner_codes` holds 10 documents, 2 current and 8 retired, all four digits.
- **No collisions:** no admin PIN is stored readably, so none can equal a code, and the shared PIN equals no code.
- **The two indexes, checked in one transaction.**
  - An admin PIN stays `admin_pins/{PIN}`, and a cleaner code `cleaner_codes/{code}`.
  - Every write that hands out four digits reads both documents for those digits in its transaction before it writes:
    - adding an admin, setting an admin's PIN, an admin changing their own;
    - a typed or drawn cleaner code, at creation or in a change.
  - Firestore's transactions lock what they read, missing documents included. A PIN and a code for the same digits written at the same moment therefore conflict, and the retried one sees the other.
  - "Both doors check the same index" was read as both doors reading the same pair of documents. If one collection was meant, admin PINs can move into `cleaner_codes`.
- **A consequence reported then.** A refusal because an admin holds the digits tells whoever typed them that admin's PIN. Typed cleaner codes therefore count on the typist's connection lock, as one's own PIN changes do (§45.3).

### 45.2 What was built

- **The library.**
  - `admins/model.ts`:
    - `PIN_LENGTH` 4;
    - `isTooEasyPin` is the cleaner codes' `isTooEasyCode`;
    - `DAILY_TRIES` 20; the lock state gains `dayKey`, `dayTries` and `capped`; `torontoDayOf`;
    - `afterTry` checks the day's twentieth before the fifth in a row; a right PIN clears the tries in a row, not the day's;
    - `lockHolding` returns `{ until: null }` while capped;
    - a try's `untilLifted` says which lock the next one brings, and `lastTryWords` puts it in words.
  - `admins/pin.ts`: only `samePin`, the connection's keyed hash, and the shared PIN, which must be four digits. The first version's and the evening's checks are gone.
  - `firebase/server-admins.ts`:
    - `countTry`, `readConnectionLock` and `adminPinHolds`, shared with the cleaner side;
    - sign-in by the four-digit PIN's index;
    - `createAdmin`, `setAdminPin` and `changeOwnPin` read `cleaner_codes/{PIN}` as well;
    - a PIN kept before (the first version's, the evening's, the night's six digits) no longer signs in, and its holder cannot change it themselves.
  - `firebase/server-cleaners.ts`:
    - every code handed out reads `admin_pins/{code}`;
    - a typed code, at creation or in a change, is one transaction: an ordinary admin's lock, the refusals, the try counted whatever the answer, then the write;
    - a drawn code that is an admin's PIN is drawn again.
- **Routes:**
  - 409 `ADMIN_PIN_IS_A_CODE` when adding an admin or setting a PIN;
  - one's own change answers 409 `ADMIN_PIN_TAKEN` "That PIN is taken." for an admin's PIN and a cleaner code alike, and 409 `ADMIN_PIN_KEPT_BEFORE` for a PIN kept before;
  - the cleaner routes answer 422 `CLEANER_CODE_IS_ADMIN_PIN` "That is an admin PIN." for the shared PIN and every admin's, and 429 when an ordinary admin's connection is locked;
  - a lock until lifted is 429 with `lockedUntil: null`, `capped: true` and no Retry-After;
  - the warning before the locking try names its lock.
- **Pages:**
  - the gate: four masked boxes that go by themselves;
  - Set your PIN takes four digits, the shared PIN carried over; a PIN kept before shows "Your PIN is from before" with Sign out and what to do;
  - Change PIN shows the server's warning;
  - the Admins page:
    - "Needs a new PIN" for a PIN kept before;
    - "Until lifted" on a capped connection;
    - the Add dialog's PIN field takes four digits.
- **Script:** the recovery script deletes a six-digit index entry too, and its words ask for four digits: `ADMIN_PIN` in Vercel, then one's own. It reads no `ADMIN_PIN` itself.
- **Schema:** new admin documents carry `schemaVersion: 4`.
- **Tests:** `admin-accounts` re-recorded:
  - the 24 too-easy codes;
  - four-digit comparisons;
  - the day, the cap and Toronto's midnight;
  - which lock the warning names.

### 45.3 Decisions, not rulings

- **An ordinary admin's typed cleaner code counts on their connection's lock,** whatever the answer, successes included.
  - A refusal names an admin's PIN, and a success says the digits are not one.
  - The Team page's Generate fills the field, so every new member arrives typed. Five in a row from one connection lock its sign-in for 15 minutes; the admin's session keeps working.
  - Drawn codes and a cleaner's own code typed again are not counted.
- **A main admin's typed codes are not counted.** Main admins see every admin's PIN, so a refusal tells them nothing. This came after checking the Team page; Kian adds team members as a main admin.
- **The day's twenty counts what the five in a row counts:** wrong PINs, changes of one's own PIN (Kian confirmed the night's) and an ordinary admin's typed codes.
  - A right PIN between them does not reset the day.
  - Lift clears both counts.
  - The tries in a row carry over midnight.
- **What each admin is told:**
  - a main admin adding or setting a PIN is told it is a cleaner code;
  - an admin choosing their own PIN is told only that it is taken.
- **A PIN kept before** (none readable in production) shows "Needs a new PIN" on the Admins page and "Your PIN is from before" at the gate:
  - a main admin goes through the recovery script;
  - an ordinary admin's PIN is set by a main admin.

### 45.4 Before deploying

1. Nothing new to set. `ADMIN_PIN` must be four digits in Vercel, as it is in `.env.local`. Vercel's value cannot be read from here.
2. **Kian's way in after the deploy:** export, then `node scripts/admin-recover.mjs Kian --write`, then the shared PIN alone at `/admin`, then Set your PIN with four digits.
   - His session from 22:21Z on 13 October, if he still has it, opens on "Your PIN is from before".
   - The 3 wrong PINs at 03:10Z still stand on that connection: two more wrong ones there lock it for 15 minutes, and a right PIN clears them.
3. No rules deploy.

### 45.5 How it was checked (2026-10-13, 23:31 – 2026-10-14, 00:07 Toronto)

- **The setup.** A local build reading production, with throwaway keys and a four-digit throwaway `ADMIN_PIN`, behind the write guard. The guard took four-digit `admin_pins` IDs and three test codes: A to be current, B retired, C drawn.
  - The guard's tests passed 56 of 56 offline.
  - The opening export was `2026-10-14T03-31-52Z`, and the opening Storage inventory was taken at 03:32Z.
  - Two admins were seeded: a main admin on four readable digits, and `__TEST__ Legacy`, a main admin shaped as Kian's document.
  - Builds:
    - `MSzFvqjVhEr9MRlC5HeLz`: checks 1–3;
    - `IV8VRuztOKJRYSizJMFor`: checks 4–5, with the warning fix;
    - `LVI7uxQXzuqVgz2urRGrv`: checks 6–8;
    - `lVBHx5LTo55X-99ie-kmI`, the final build with main admins' codes not counted: checks 9 and 10.
- **The checks:**
  1. **Four digits:** a four-digit PIN signed in with 4 reads, and a six-digit PIN got 401. The gate showed four masked boxes that went by themselves. The Add dialog opened on Admin, with a four-digit field; Ada was added and signed in.
  2. **A typed code is counted:** Ada created Cleo with B, then changed it to A, so B is retired and A current; her connection counted 2.
     - The first attempt was refused by the guard: Ada's address was missing from its list. The transaction wrote nothing, the address was added, and it was run again.
  3. **A PIN refused because a code holds it:**
     - A (current) and B (retired), adding an admin and setting Ada's PIN: 409 `ADMIN_PIN_IS_A_CODE`, 0 writes;
     - Ada choosing either: 409 "That PIN is taken.", counted;
     - the Add dialog showed "A cleaner code, current or retired, is those four digits."
  4. **A code refused because an admin holds it:**
     - Ada typed the main admin's PIN for a new cleaner, then her own and the main admin's for Cleo: 422 "That is an admin PIN." each, counted 3, nothing written;
     - a drawn create forced to draw the main admin's PIN first skipped it ("admin PIN candidate skipped") and issued C, uncounted.
  5. **Kian's path, on Legacy:**
     - the Admins page read "Needs a new PIN" on Kian's and Legacy's rows;
     - Legacy's session opened on "Your PIN is from before", with nothing behind it;
     - the recovery script refused Ada, ran dry, then wrote: shared PIN, epoch 3;
     - the shared PIN at the gate went by itself to Set your PIN, with only New PIN and New PIN again, four boxes each;
     - four masked digits later Legacy was in;
     - afterwards: readable, epoch 4, an index entry; the old session got 401, the shared PIN 401, the new PIN 200;
     - Legacy was on the shared PIN for 18.0 s at most.
  6. **The Admins page** at 1280, 1400 and 1700 px: no sideways scroll, every button whole. "Needs a new PIN" takes 3, 2 and 2 lines.
     - A first version kept it on one line, which cut "Remove…" off at 1280 px; that was dropped.
  7. **The earlier checks:**
     - Ada was refused all 8 main-admin routes and wrote nothing;
     - no PIN reached her session or her pages;
     - Bo, promoted, saw four-digit PINs and none for Kian;
     - 12 attempts on main admins' accounts got 409, three of them on Kian's, and a PIN for oneself through the Admins route got 409;
     - a PIN-signed session from before dispatch 38 got 401;
     - a name change was recorded;
     - a new admin was written with schema 4.
  8. **The lock and the cap,** after Toronto's midnight so that one day held every try:
     - **Five in a row:** the fourth warned "for 15 minutes"; the fifth got 429 with Retry-After 900; the right PIN during the lock got 429 with one read; Lift, then 200.
     - **Ada's Change PIN dialog:** the fourth wrong current PIN warned of the 15 minutes.
     - **The cap, on the browsers' connection:** four wrong PINs and a right one, three times, then two wrong.
       - The gate showed the 19th try's "One more wrong PIN locks sign-in from here until a main admin lifts it."
       - The 20th showed "Twenty tries today. Locked until a main admin lifts it." with the boxes disabled.
       - The right PIN then got 429 with `lockedUntil: null`, `capped: true` and no Retry-After.
       - The Admins page showed "Until lifted"; Lift cleared it, and the gate signed in.
     - **Midnight:** a connection with 2 tries on the 13th went to 3 in a row and 1 for the 14th.
  9. **Whose codes count, on the final build:**
     - Ada's typed success and refusal were counted;
     - the main admin's typed success (Eli, with A) and two refusals read no lock and wrote none;
     - on the Team page, the New team member dialog showed "That is an admin PIN." for each: the main admin's left no try, Ada's left one.
  10. **Removal and sign out:**
      - the three cleaners were deleted, each retiring its code;
      - Ada, Bo and Cy were removed: their sessions and PINs got 401, and a freed PIN was set again for Fay, then removed;
      - Legacy and the test main admin removed themselves;
      - sign out cleared the cookie.
- **Unchanged:**
  - the seven other test suites are identical to their recorded outputs;
  - `tsc` is clean outside stale `.next/` files;
  - lint on `app`, `scripts` and `tests` has the baseline's 10 problems.
- **Cleanup.** The guard recorded 150 writes: 149 allowed, the 1 refusal above, none to Kian's document or name.
  - Through the app: every test admin, name, PIN entry and cleaner.
  - By exact ID after export `2026-10-14T04-05-25Z`: 24 activity lines, 3 retired test codes and 7 lock documents, 34 of 34.
  - The closing export `2026-10-14T04-06-10Z` is byte-identical to the opening one, file for file, Kian's lock record included. Storage's 6,622 objects have the same names and generations.

### 45.6 Not exercised live

- A PIN and a code for the same digits written at the same moment.
- `ADMIN_PIN` of another length in Vercel. The recovery script checks only the local one; production would then refuse the shared PIN until Vercel's is four digits.
- **Production:** Kian's recovery and Set your PIN are his to do.
- Statements were not re-rendered: no money or statement code changed.

## 46. The cleaning schedule, phase 1: Kian's rulings of 2026-10-14

Kian's rulings are in `CLAUDE.md` under *Cleaning schedule*: the eight of the morning, and the evening's:
- the plan's recommendations 1–4: same dates under a new ID keep the job; a cleaning's day is the checkout day; Undo lasts until a finished statement prints the cleaning; until the function is deployed, jobs come from Refresh now only;
- jobs link cleanings to bookings, replacing 37B's "no link";
- the cleaner door gets the admin door's lock;
- the hourly calendar copy deploys as the existing Cloud Function, with the job sync inside it;
- the plan's §9 choices accepted except those touching money, a statement or what an owner receives, which were put to him first; his four answers are in CLAUDE.md.

The design is `CLEANING-SCHEDULE-PLAN.md`. `firestore.rules` changes (two deny lines), so its deploy is part of the release.

### 46.1 What was built

- **The calendar copy** keeps a stay through its checkout day (`eventsFromFeed`: `end < today` is dropped, no longer `end <= today`). An event ending today covers no night from today on, so no night's state changes.
- **`app/lib/schedule/`**, pure and copied into the function by `scripts/functions-sync.mjs`:
  - `model.ts`: the job, its assignments and history, read strictly; `jobIdOf`, `markRefusal`, `isDone`, `changedAfterMark`, `changeWords`; the views the pages read;
  - `sync.ts`: `planCreates` (reservations ending today to two days ahead, on calendars read this run) and `planJob` (booking changed: moved, gone, calendar changed or removed, property deleted; a new UID on the same day keeps the job; reopen; check-in and next check-in changes; settled after the checkout day);
  - `store.ts`: `syncJobs`, one query and `create()` per new job, a transaction per changed job; never throws.
- **`availability/refresh.ts`** runs `syncJobs` right after writing the copy; `RefreshOutcome.jobs`; the function logs it; Refresh now answers it.
- **Cleanings, schema version 2:** `jobId`; `amountCents` null only on a job's cleaning. `cleaningEntryView` reads a null amount as a pending cost with no lines (`NO_AMOUNT_YET`); `suggestedAmount` skips a cleaning with no amount; the workbooks print "No amount yet". New hand-logged cleanings are written as version 2 with `jobId: null`.
- **`firebase/server-cleaning-jobs.ts`:** `readSchedule`, `setAssignees`, `cleanerJobs` and `oneCleanerJob`, `markCleaned`, `undoMark`, `unmarkedJobsOf`, and `readUnmarkedJobs` with `takeOffJobs` for the Team page's transactions.
- **The cleaner door's lock:** `cleaners/lock.ts` (the connection's keyed hash under `CLEANER_SESSION_SECRET`, its own label); `signInCleaner` in `server-cleaners.ts` on the admin door's `afterTry` and `lockHolding` (`lockStateOf` now exported from `server-admins.ts`); `cleaner_signin_locks/{hash}`; the session route answers 429 `CLEANER_SIGN_IN_LOCKED` and the warning before a lock; `findCleanerByCode` removed, its checks now inside `signInCleaner`.
- **The Team page:** deactivating and deleting take the person off every job they have not marked, inside the same transaction; the routes answer `jobsTakenOff`; the dialogs name the jobs first (`GET /api/admin/cleaners/[id]/jobs`); a "Cleaner sign-in locks" block, shown only while one holds, with Lift.
- **Routes:** `GET /api/admin/cleaning-jobs`, `PATCH /api/admin/cleaning-jobs/[id]`, `POST /api/cleaner/jobs/[id]` (mark, undo), `GET /api/admin/cleaners/locks`, `DELETE /api/admin/cleaners/locks/[id]`; `GET /api/cleaner/start` adds `jobs` and `today`.
- **Pages:** `/admin/schedule` (header section "Schedule"); the cleaner app's jobs above everything else (`JobsSection.tsx`); the code screen's warning and lock; the Cleanings tab's "No amount yet" and "· marked"; the Costs list's "No amount yet".
- **Rules and export:** deny lines for `cleaning_jobs` and `cleaner_signin_locks`; the export lists both. The activity log names the two new admin writes.
- **Tests:** `tests/schedule/jobs.mjs` (check `cleaning-jobs`); `admin-accounts` re-recorded for the five new admin handlers.

### 46.2 Decisions, not rulings

Two touch a cleaning record, and were put to Kian first (§9 of the evening's rulings); his rulings of the night settle both (§46.6):
- **A job's cleaning keeps its cleaner.** The Cleanings tab refuses changing the cleaner of a cleaning made by Mark cleaned (409 `CLEANING_FROM_JOB`): remove it, and log one by hand for the other cleaner. Otherwise the job's assignment would point at another cleaner's cleaning. *Accepted by Kian (night).*
- ~~An admin's Delete of a job's cleaning clears that cleaner's mark on the job, so the cleaner can mark it again.~~ *Replaced by Kian's ruling of the night: the job keeps the mark as "removed by the office", the cleaner cannot mark it again, and an admin can reopen it for them from the Schedule (§46.6).*

The rest:
- The lock counts only four-digit codes: anything else is refused before any read and is no guess, as at the admin door.
- **A lift clears both counts**, as the admin door's does: lifting a 15-minute lock also restarts that connection's twenty for the day. The day's twenty therefore build up only across locks that run out.
- The cleaner lock's key is the cleaner key with its own label: the doors share no key. Rotating `CLEANER_SESSION_SECRET` orphans the lock records, which then never match.
- Mark cleaned pressed again after a lost answer answers with the existing mark; nothing is made twice.
- A booking-changed job the cleaner has not marked leaves their list once its checkout day has passed.
- The Schedule opens on seven days back to the furthest job (two days ahead); at most 92 days at a time.
- A moved booking's job offers "Same cleaners to <day>" when the job at the new checkout is on the page.
- Cleaner-facing names everywhere in the cleaner app (dispatch 21); the Schedule uses the real names.

### 46.3 Before deploying

- Deploy `firestore.rules` with the commit (two deny lines; the catch-all already denied both).
- Set each cleaner's default rate on the Team page: without one, and with no amount last paid for the property, every Mark cleaned waits for an admin to type its amount.
- The function: the Google Cloud steps and the deploy plan are in the report of 2026-10-14 (evening).

### 46.4 How it was checked (2026-10-14, 19:57 – 20:25 Toronto)

- **Offline:** `node tests/run.mjs` 10 of 10 identical; dispatch 36's `v3-hash.mjs` 40 of 40 statements byte-identical; `tsc --noEmit` and `eslint` clean on every file touched; `npm --prefix functions run build` compiles.
- **Live**, on a build of the tree (`G08F1fuzCOrY1-6CSlSbb`, after one UI fix round on `_lFNelo7twXMwUz_KRMKa`) served on 127.0.0.1:4500, reading production, throwaway admin and cleaner secrets, a write guard allowing only the test's own records, a minted session for a `__TEST__` admin, an unlisted `__TEST__` property whose calendar link was answered from a local file, and `__TEST__` cleaners Ana ($60.00 rate), Ben (none) and Cy:
  - Refresh calendars read 53 calendars: 12 reservations ending 14–16 October, 12 jobs, the same stays; 4 blocks ending in those days, no job;
  - assignments, a stale page (409) and a cleaner who does not exist (422);
  - each cleaner's list, soonest first; Mark cleaned: Ana's at $60.00 (`suggested: default`), Ben's with no amount (`suggested: none`); too early 409, not on the job 403, pressed again nothing twice;
  - the statement: Ben's cleaning left out and Finish's pending warning counting it; typed at $55.00, "Expense - Cleaning · 2 · (rate empty) · -$115.00"; no cleaner named in the PDF;
  - Undo while unprinted (the cleaning deleted, the job's history keeping $60.00), marked again; October finished; Undo refused for both, "on the finished October 2026 statement";
  - booking changed: R2 extended under its UID, the job marked moved, Ana's mark refused, no one added;
  - Cy deactivated with a job: named first, taken off, session ended; reactivated onto none; deleted with a job: taken off again;
  - the lock: five wrong codes, 15 minutes, a right code refused unread, lifted, the right code works; the day's twenty across three locks that ran out (the server restarted with the app's clock past each), the nineteenth warning "until the office lifts it", the twentieth capped; lifted from the Team page;
  - the app's clock at 00:30 on 15 October: Ben's mark started from what he was last paid ($55.00, `suggested: last`), and printed on November's statement as "(from October 2026)";
  - the function's compiled code run once in node: 53 calendars, its job sync watching 12 jobs.
- **Cleanup:** the statement and its PDF, the three cleanings, Ana and Ben and the property through the app; 54 records by exact ID from the test's ledger; `availability_snapshots/current` set back to the opening export's. Exports `2026-10-14T23-57-27Z` and `2026-10-15T00-22-58Z`: 17 of 17 files byte-identical. The one Storage object saved (the statement's PDF) is gone. 236 guarded writes, none refused.
- **Reads:** 12,499 counted by the test (builds 3,890 and 3,952; exports 948 each; server 2,541); Cloud Monitoring 11,413 project-wide, 23:00Z – 00:24Z.

### 46.5 Not exercised live

- The Cloud Scheduler run itself: the function is not deployed.
- A handyman offered for a job (refused by role in `setAssignees`; not run).
- The "No amount yet" rows on screen (the stored shape, the statement and Finish were checked). Checked on the night (§46.6), which found the Costs page refusing to load with one; fixed.
- A real phone: the cleaner app at 390 px in headless Chromium only.
- A new UID on the same day, and a changed calendar link, live: made-up calendars only (`cleaning-jobs`).

### 46.6 Kian's rulings of the night (2026-10-14): removed by the office, and reopen

Kian's rulings are in `CLAUDE.md` under *Cleaning schedule — Kian's rulings of 2026-10-14 (night)*: a job's cleaning keeps its cleaner (choice 1 accepted); when an admin deletes a job's cleaning, the job keeps the mark as "removed by the office", that cleaner cannot mark it again, and an admin can reopen it for them from the Schedule page, recorded in the job's history (replacing choice 2); the cleaner-codes risk wording accepted as written.

**Built:**
- **The assignment** gains `removedAt` and `removedBy` (null, or when and which admin). A removed mark keeps `cleaningId` and `markedAt`: it is still a mark (`markedCount`), so deactivating or deleting the cleaner leaves it, and the Schedule's picker keeps them on the job. Read strictly: both or neither, and only on a mark. `JOB_SCHEMA_VERSION` stays 1: no job was ever stored in the earlier shape (production held none; the evening's test jobs were deleted).
- **History actions:** `cleaning-deleted` and `cleaning-removed` (the admin, the cleaning, its amount), and `mark-reopened` (the admin, the cleaner, the cleaning removed). The calendar's `reopened` (a changed booking's day ending a stay again) is unchanged. The old `unmarked` with reason "the cleaning was deleted" is no longer written.
- **`deleteCleaning` and `removeCleaning`** (`server-cleanings.ts`) keep the mark on the job in the same transaction (`markOnJob`, `keepMarkRemoved`), only when the assignment's mark made that cleaning. A cleaning deleted after being removed keeps the first removal's time and admin, and adds its own event.
- **The cleaner:** `markRefusal` answers `removed` before `already-marked`; Mark cleaned 409 `JOB_MARK_REMOVED`, Undo 409 `CLEANING_REMOVED`; their list shows the job among the done, with ✕ and "Removed by the office", no Undo.
- **Reopen:** `POST /api/admin/cleaning-jobs/[id]/reopen` `{ cleanerId, seen }` (`reopenMark`): the mark comes off (cleaning, marked, removed all null), recorded as `mark-reopened`; their next Mark cleaned makes a new cleaning at once, at 37B's amount. Refused: a stale page (409 `JOB_CHANGED`), nothing removed (409 `JOB_MARK_NOT_REMOVED`), a booking that changed (409), a job older than the 45 days their list reaches (409, log it by hand), a cleaner deactivated, deleted or a handyman (409 `CLEANER_NOT_ACTIVE`). In the activity log: "Reopened a cleaning job for a cleaner".
- **The Schedule:** the chip reads "removed by the office" (amber); the badge "Removed by the office"; a small Reopen beside the name of an active cleaner on an unchanged job, behind Nubnb's own question ("Reopen … for Ana? Ana can mark it cleaned again. Their mark logs a new cleaning at once.").
- **The Cleanings tab's Remove and Delete questions** for a job's cleaning add: "Its job keeps the cleaner's mark as removed by the office: they cannot mark it again until it is reopened on the Schedule."

**Decisions, not rulings:**
- **Remove, as well as Delete, leaves the mark "removed by the office"**, reopenable the same way. The ruling names Delete; a removed cleaning already kept its mark, and without this the office could reopen a deleted cleaning's mark but never a removed one's (a removed cleaning a finished statement prints cannot be deleted). Reopening changes no amount and no statement: a removed cleaning counts nowhere, and a new mark is a new cleaning under 37B. Drop it by not calling `keepMarkRemoved` in `removeCleaning`.
- **Reopen asks first** (Nubnb's dialog), since the cleaner's next tap logs a charge with no admin in between.
- **Reopen is refused where the cleaner could never mark again** (inactive, booking changed, out of reach), rather than leaving an unmarked assignment nobody can act on.

**Found and fixed while checking:** the Costs page refused to load whenever any cleaning had no amount yet ("the server's answer was not in the expected form"): `isCleaningView` in `costs-client.ts` still required a number. It now accepts null. The evening's check had not shown a "No amount yet" row on screen (§46.5).

**How it was checked (2026-10-14, 21:13 – 21:23 Toronto):**
- **Offline:** `node tests/run.mjs` 10 of 10 identical: `cleaning-jobs` re-recorded with six new lines (a removed mark refused and still a mark; reopen refused for Ben, for someone not on it and after the booking changed; reopened, can mark; three shapes refused), `admin-accounts` with the new route (73 handlers). `tsc --noEmit` (no errors outside the repo's stale `.next`), `eslint` on every file touched, `npm --prefix functions run build`.
- **Live**, on a build of the tree (`MI6yvNz7YbSpUTZpKfiiK`, after `F2rIzPEBewuiUvJePtoE1` and a layout fix, `q8gy7bqvMUQzVudHNw3eH`) served on 127.0.0.1:4500, reading production, throwaway secrets, a write guard allowing only the test's own records (jobs only for the test property; no calendar copy), a minted session for a `__TEST__` admin, an unlisted `__TEST__` property, `__TEST__` cleaners Ana ($60.00) and Ben (none). The job was made by the app's `syncJobs` from a copy holding the test property alone (created 1, watched 0):
  - Ana and Ben assigned and marked: Ana's cleaning $60.00, Ben's with no amount;
  - **delete:** Ana's cleaning deleted from the Cleanings route; the job kept her mark, `removedAt`/`removedBy` the admin, `cleaning-deleted … $60.00`; her list `markRefusal removed`, no Undo;
  - **refused re-mark:** Mark cleaned 409 `JOB_MARK_REMOVED`; Undo 409 `CLEANING_REMOVED`;
  - Ben's cleaning removed (not deleted): the same, `cleaning-removed`;
  - the Schedule: both chips "removed by the office", the badge, Reopen beside each; Ana's app "Removed by the office";
  - **reopen:** from the Schedule page, the question, Reopen: "Reopened … for __TEST__ Ana", `mark-reopened` by the admin naming the deleted cleaning; a stale page 409 `JOB_CHANGED`; again 409 `JOB_MARK_NOT_REMOVED`; Ana's app back on top with Mark cleaned;
  - **re-mark:** a new cleaning at $60.00 (`suggested: default`);
  - Ben deactivated: his removed mark kept (`jobsTakenOff []`), reopen 409 `CLEANER_NOT_ACTIVE`; reactivated, reopened through the API, signed in again, marked: a new cleaning with no amount;
  - with that pending cleaning, after the fix: the Costs page, the Cleanings tab ("No amount yet"), the Delete question's new line (cancelled), the property page's Costs tab and its statement ("Expense - Cleaning · 1 · -$60.00", one pending).
- **Cleanup:** the three cleanings, Ana, Ben and the property through the app; 23 records by exact ID from the test's ledger (8 already gone). Exports `2026-10-15T01-11-17Z` and `2026-10-15T01-23-19Z`: 17 of 17 files byte-identical. 82 guarded writes, none refused; no Storage write.
- **Reads:** 16,155 counted (three builds 11,794; exports 948 each; server 2,393).

## 47. Calendar refresh: no scheduled job (Kian's ruling of 2026-10-14, night)

Kian's ruling is in `CLAUDE.md` under *Calendar refresh*. It replaces the evening's "the hourly calendar copy deploys as the existing Cloud Function", and with it dispatch 22's "Hourly" and "Schedule it on Firebase, not Vercel" (marked there).

### 47.1 What was built

- **The refresh's state:** `availability_snapshots/refresh` (`app/lib/availability/run-state.ts`), in the collection firestore.rules already denies: the run holding the lease (`running`: id, source, trigger, startedAt, leaseUntil), the last run that wrote the copy and synced the jobs (`lastDone`, with its Toronto day), the last that did not finish (`lastFailed`). Read strictly. The decisions are pure (`decideClaim`, `afterRun`) and tested offline (`calendar-refresh`); `claimRefresh` and `finishRefresh` run them in transactions.
- **One at a time:** every refresh claims the lease in a transaction; while one holds it, every other trigger does nothing. The lease is 6 minutes, longer than the 300 s a route allows a run, so a run the time limit or a crash stops lets go by itself.
- **The day's first visit** (`app/lib/availability/daily.ts`, `refreshIfFirstToday`): GET and POST `/api/admin-auth` (every admin page's sign-in check, and a sign-in) and GET `/api/cleaner/start` call it once their answer is decided. Before the response it does nothing but compare the Toronto day with the one this server instance last saw refreshed; `after()` (next/server; on Vercel, waitUntil) then reads the state once and, when today has no finished run, no lease is held and no try failed in the last 15 minutes, claims the lease and runs the refresh.
- **Refresh calendars** (POST `/api/admin/availability/refresh`) claims the same lease; while another run holds it, it answers 409 `REFRESH_RUNNING`, "The calendars are being read now (started 21:13)", and starts nothing; the Schedule and Availability pages show that as a plain notice. It waits for no pause after a failure, only for a lease.
- **maxDuration 300** on the three routes (the refresh route was 60).
- **The copy's `run.source`:** "daily" or "manual"; "schedule" is kept in the type for a copy the never-deployed function may have written.
- **The pages:** the Schedule's line and the Availability page's line read "Calendars read Oct 15, 00:05", amber past 24 hours (`STALE_AFTER_MINUTES = 24 * 60`; the Schedule's was 120 minutes, the Availability page's 120); the Availability page adds how the read began ("on the day's first visit", "by hand").
- **The Cleanings tab:** "Earned in these dates" adds, beside each cleaner's total, how many of their cleanings wait for an amount; the list's total uses the same words ("waiting for an amount", was "without an amount").
- **Removed:** `functions/` (its index, package, lock file, tsconfig, .gitignore, and the local build output), `scripts/functions-sync.mjs`, the `functions` block of `firebase.json`, the ESLint ignore and the tsconfig exclude for it. Comments that named the function now name the first-visit refresh. AVAILABILITY-SEARCH-PLAN.md §2.3 is marked superseded. Nothing in Google Cloud changed.

### 47.2 Decisions, not rulings

- **No listing-page check in either refresh.** It was the scheduled function's, subject to the datacenter test, which never ran; from Vercel a blocked answer (403, 429) would replace a stored "gone" verdict with "unknown". The verdicts of 30 September stay. The code stays, unused (`checkPages: false` everywhere).
- **A run counts as done only when the copy is written and the job sync ran through.** A failed sync is retried by the next first-visit 15 minutes on, rather than waiting a day.
- **The first-visit refresh waits 15 minutes after a try that did not finish**: at most four tries an hour while pages open. Refresh calendars does not wait.
- **The triggers are the routes every admin page and the cleaner app already call**, so no extra request is made; a sign-in counts as opening the admin.
- **`firestore.rules` is unchanged**, so no rules deploy: its comment on `cleaning_jobs` still names "the scheduled function". Fix it in a release that deploys the rules.

### 47.3 How it was checked (2026-10-15, 00:00 – 00:07 Toronto)

- **Offline:** `node tests/run.mjs` 11 of 11 identical, the new check `calendar-refresh` holding the decisions: the day's first visit, a lease held, two claims in order, a lease run out, a try that failed and its 15-minute pause, Refresh calendars waiting for no pause, how a run ends, the strict reader, and Toronto's midnight (03:59Z still the 14th's, 04:00Z the 15th's). `tsc --noEmit` (no errors outside the repo's stale `.next`), `eslint` on every file touched.
- **Live**, on one build of the tree (`bZKkSm7zxkECgYKswE_KY`) served on 127.0.0.1:4500, reading production, throwaway secrets, a write guard allowing only the test's records and what a refresh writes, a minted session for a `__TEST__` admin, an unlisted `__TEST__` property whose calendar link the stub answered (after a delay, to hold a run open), and a `__TEST__` cleaner, Ben, with no rate. Days after the first by dispatch 36's clock preload (the app's own code only):
  - **15 October (real clock), the first admin page** (the Schedule): its sign-in check answered in 0.24 s; the state then showed the lease held by `admin-page`; the second admin page (Availability), opened while that run went, started nothing; after it, one copy, one day document, 12 jobs, the state's claim and finish. Two more pages: nothing. The Schedule's line amber before ("Calendars read Oct 5, 15:32 · jobs for checkouts since then may be missing"), normal after ("Calendars read Oct 15, 00:00"); the Availability page's "Calendars read Oct 15, 00:00 · on the day's first visit · 53 of 53 calendars read".
  - **The earned fix:** Ben on the test job, his mark with no rate, and one cleaning logged for him at $50.00: "__TEST__ Ben · 2 cleanings · $50.00 · 1 waiting for an amount"; the list's total "2 cleanings · $50.00 · 1 waiting for an amount".
  - **16 October, 09:00, the first cleaner app:** Ben's start answered in 0.70 s, then one run (`cleaner-app`): copy, day, 3 jobs. Ben again, and an admin page: nothing.
  - **17 October, 08:00:** the copy 23 hours old reads normal; the day's first admin page ran once.
  - **18 October, 10:00, the copy 26 hours old:** two admin sign-in checks and two cleaner-app starts at once: one run (one copy written, one "started" line; the guard recorded a second claim 14 ms after the first, a transaction attempt Firestore aborted and retried, which then found the lease). The Schedule amber ("Calendars read Oct 17, 08:00"). Refresh calendars during the run, by the API and on the page: 409 `REFRESH_RUNNING`, "The calendars are being read now (started 10:00).", nothing written. Idle, it ran (`manual`).
  - **Page speed while a run goes:** the page routes warm and idle — cleaning-jobs 0.59 s, availability 0.40–0.46 s, properties 1.05–1.12 s; during the run 0.39–0.42, 0.34–0.37, 1.00–1.17 s; the Schedule's data on screen at 0.61 s during it, 0.70–0.76 s idle. The four-at-once cleaner starts (1.22 s) took as long with nothing running (0.75–1.20 s; one alone 0.58 s): the four at once, not the run.
  - Every run read 53 feeds, 0 failed. From claim to finish, writes and job sync included: 2.63 s for the one run with no hold (Refresh calendars, idle); 5.19 s with the stub's 3-second hold, 10.48–12.15 s with its 8-second one.
- **Cleanup:** the two cleanings, Ben and the property through the app; 41 records by exact ID from the test's ledger (the 23 jobs, 4 day documents, the refresh state, the test admin and its records, Ben's code), 5 already gone; `availability_snapshots/current` set back to the opening export's. Exports `2026-10-15T03-45-58Z` and `2026-10-15T04-06-57Z`: 17 of 17 files byte-identical. 115 guarded writes, none refused; no Storage write.
- **Reads:** 8,846 counted, under the 15,000 asked (the build 3,890; exports 948 each; the server 2,923; the rest the test's own).

## 48. Team pay: Kian's rulings of 2026-10-15

Kian's rulings are in `CLAUDE.md` under *Team pay*. The design is TEAM-PAY-PLAN.md (kept out of the repo), accepted as designed with its §7 choices. None of those choices changes a statement or what an owner receives: the card flag is read by pay alone, and the receipt stays the property's cost on the ledger, its exports and the statements.

### 48.1 What was built

- **The payment:** `team_payments/{id}` (`app/lib/pay/model.ts`), server-only (a deny line in `firestore.rules`): the member, their name then, the amount in cents, the day paid (Toronto, never after today, at most 12 months back), e-transfer, cash or other, an optional note, who recorded it, and a history. Recorded with `create()`; deleted in a transaction that checks the history's length as the page saw it, marking it `deleted` with who and when. Never edited, never erased by the app. Read strictly. Routes: GET and POST `/api/admin/payments`, DELETE `/api/admin/payments/[id]`; the activity log names "Recorded a payment" and "Deleted a payment".
- **The card flag:** `paidWith` on a receipt's own entry (absent reads "team-member"), set and unset from the Costs page's entry pane (Nubnb's tick, "Paid with Nubnb's card"), POST `/api/admin/cost-entries/[id]/paid-with`, through the review transaction, one `paid_with_changed` history event each way ("Marked who paid for a receipt"). Refused on work and office entries.
- **The balance:** one pure function, `memberPay` (`app/lib/pay/balance.ts`): earned = logged cleanings with an amount, approved receipts not on the card (their total now, every correction applied), approved work; paid = recorded payments; balance = earned − paid over all time. Every item and payment listed newest first with its state in words and the changes that moved what it adds, replayed from its history; a change after a payment that may have included the item marked for amber. With a range: what fell in it and the balance at its start and end. The Team page, a person's pay, the cleaner app and the member delete all call it.
- **The refusals (Kian's rulings of 2026-10-15):** deleting a cleaning, receipt or work entry dated on or before a recorded payment to its person — 409 `CLEANING_BEFORE_PAYMENT` / `ENTRY_BEFORE_PAYMENT`, naming the payment, "Remove it instead" — checked in the delete's transaction (`paymentOnOrAfter`, `app/lib/firebase/server-pay.ts`); deleting a member whose balance is not zero — 409 `MEMBER_HAS_BALANCE`, naming it, "Deactivate them instead" — worked out in the delete's transaction, and refused too when any of their records cannot be read.
- **The Team page:** Earned, Paid and Balance on each row ("$8.20 owed", "$40.00 overpaid" in amber, "—"); the name and Pay open the person's pay; the other actions behind "⋯" (`RowMenu.tsx`); the ID moved to the person's pay. Delete… on a member with a balance answers on the page, without a dialog.
- **A person's pay** (`PayView.tsx`, at `/admin/cleaners?pay={id}`): who; the three figures, earned split by kind; what waits and what cannot add up; Record a payment (amount, Nubnb's date field, method, note); the date filter (this month, last month, the last 90 days, all time) with what fell in it; the list — uncounted amounts struck through, waiting ones muted, changes after a payment in amber, Delete… on a recorded payment through Nubnb's dialog.
- **The cleaner app:** "Your pay", Earned, Paid and Balance ("owed to you", "Overpaid $40.00", "All paid"), under the jobs in a cleaner's app and at the top of a handyman's; `GET /api/cleaner/start` adds `pay`, worked out on the server from their own cleanings, entries and payments only.
- **The start call's jobs:** `where('cleanerIds', 'array-contains', id)`, filtered to the 45 days in code; it read every job from 45 days back.
- **Also:** `team_payments` in `scripts/export-firestore.mjs`'s list; `firestore.rules`'s comment on `cleaning_jobs` names the calendar refresh, not the scheduled function (§47.2).

### 48.2 Decisions, not rulings

- **A person's pay is on the Team page, at `?pay={id}`**, not a route of its own (TEAM-PAY-PLAN.md §4 wrote `/admin/cleaners/pay?id=`): drawn from what the page holds, opening a person and going back read nothing, the figure §5 gave. A reload of the address loads the Team page's data, as the Team page would.
- **"⋯"** holds Change code, Set rate (a cleaner's), Deactivate or Reactivate, and Delete…, as the plan's mock showed: with the three columns, the row's buttons ran off a 1440-pixel window.
- **A cleaner's Undo is refused like a delete** for a cleaning dated on or before a payment to them (Undo deletes it): not offered, and 409 `CLEANING_BEFORE_PAYMENT` if sent.
- **Marking who paid counts as looking at an automatic approval** (the existing rule: any admin action), so the receipt leaves the review queue.
- **Amber** when the item counted before the change and a payment recorded before the change is dated on or after the item. An amount typed on a cleaning that had none is not amber: it counted nowhere before.
- **An entry that cannot add up** counts nowhere, is named beside the balance, and none of its changes is said to move what it adds.
- **A payment no one can read** marks every balance not whole: it cannot be told whose it was.
- **The form** starts on the balance owed, today and e-transfer; **the filter** on this month.
- **The jobs read grows with the person's own jobs, ever:** 1 read today for a person on no job; a cleaner on most turnovers would pass the old read (every job of 45 days, about 190 once the schedule runs a while) within weeks. Bounding it to 45 days needs a composite index (`cleanerIds` array-contains, `checkout`), an index deploy, which this release does not make.

### 48.3 How it was checked (2026-10-15, 10:04 – 10:20 Toronto)

- **Offline:** `node tests/run.mjs` 12 of 12 identical, the new `pay-balance` holding every rule above on made-up data (earned, the card and taking it off, waiting, rejected, removed, given to another cleaner, deleted payments, changes after a payment, overpaid, entries that cannot add up, ranges with open ends, the words, the day paid, the strict reader, the schemas); `admin-accounts` re-recorded for the four new handlers (73 → 77, nothing else changed). The 40 version-3 statements byte-identical. `tsc --noEmit` (no errors outside the stale `.next`), `eslint` on every file touched.
- **Live**, on two builds of the tree (the second for "⋯") served on 127.0.0.1:4500, reading production, throwaway secrets, a write guard allowing only the test's records (receipt photos only for a test cleaner), a minted session for a `__TEST__` admin, an unlisted `__TEST__` property with no calendar link, and three `__TEST__` members: Ana (cleaner, $60.00 rate), Ben (cleaner, no rate), Sam (handyman). Production's calendar refresh had run that morning, so none started.
  - **Earned:** two cleanings logged for Ana ($60.00 each); four receipts from her app — $43.20 approved automatically, $250.00 waiting, $210.00 rejected, $25.00 approved automatically; Sam's $120.00 of work approved; Ben's job mark with no rate. Team page: Ana $188.20, Sam $120.00, Ben $0.00.
  - **Payments, on the screens:** $100.00 recorded to Ana, deleted through Nubnb's dialog ("Delete __TEST__ Ana's payment of $100.00 on Oct 15 (e-transfer, recorded by …)?"), listed struck through, "Deleted Oct 15 by … · recorded Oct 15 by …"; $150.00 recorded with a note; back to Team (0 reads), Ana $188.20 · $150.00 · $38.20 owed. Sam $160.00 as Other: "Overpaid $40.00", amber.
  - **The card:** the tick on the $25.00 receipt — "Marked paid with Nubnb's card. Not owed to __TEST__ Ana. Its statement line is unchanged."; its history "Marked paid with Nubnb's card by …"; on Ana's pay struck through, "Paid with Nubnb's card · …, Oct 15 · was owed $25.00 · after the payment of Oct 15" (amber); the property's ledger still counting it.
  - **A change after the payment:** the Oct 14 cleaning $60.00 → $55.00: "Changed Oct 15 by …: $60.00 → $55.00 · after the payment of Oct 15", amber. Ana: $158.20 · $150.00 · $8.20 owed.
  - **Refused:** the Oct 12 cleaning and the $43.20 receipt (before Ana's $150.00 payment), Sam's work (before his $160.00), Ana ("balance is $8.20 owed") and Sam ("$40.00 overpaid"), each 409 and nothing changed; Delete… on Ana's row answered on the page with no dialog.
  - **The cleaner app:** Ana $158.20 · $150.00 · $8.20 owed to you, 1 waiting; Sam overpaid $40.00; Ben $0.00, 1 waiting, his one job — each the Team page's figures.
  - **The start call's reads** (`readCleanerStart`, the same data, committed 49ccd4c against this tree): Ana 137 → 131, Ben 136 → 128 (jobs 11 → 1 each), Sam 123 → 125 (his pay, 2). Over HTTP with the session: 132, 129, 126. A Team page load: 94.
- **Cleanup:** the two recorded payments deleted, the 3 cleanings and 5 entries (their 4 photos with them), the 3 members and the property, all through the app; 40 records by exact ID from the test's ledger (the 3 payments, the job, the 3 codes, the test admin and its records), 18 already gone; the 4 photos confirmed gone from Storage. Exports `2026-10-15T14-04-30Z` and `2026-10-15T14-20-22Z`: 18 of 18 files byte-identical. 3 writes refused, all before the guard allowed the admin connection's lock: an ordinary admin's typed codes count on it, and the creates stopped there, writing nothing.
- **Reads:** 12,406 counted, under the 15,000 asked (the two builds 3,890 and 3,952; exports 974 each; the server 1,737; the start-call comparison 780; the rest the test's own).
