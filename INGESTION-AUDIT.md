# nubnb.ca — Property Ingestion Path Audit

**Repository:** `/Users/kianbaban/Development/Nubnb` · branch `main` · HEAD `e73532e`
**Audit date:** 2026-09-20
**Scope:** the ingestion path only — Airbnb scraper, Google Maps geocoder, admin form, write API, and the 43 documents currently in Firestore.
**Method:** the real `POST /api/scrape-airbnb` handler was transpiled verbatim and executed locally against 6 live Airbnb listings (7 executions total); a read-only Firestore script read all 43 property documents; every image URL and every iCal feed in the catalogue was fetched and checked.

**Writes performed:** `./tmp-audit/` (scratch, excluded via `.git/info/exclude` so no project file was modified) and this report. **No Firestore write, no Storage write, and no scraped property was persisted.** `.gitignore` is unchanged; `git status` shows only the two report files.

**Legend** — claims are observed unless tagged `INFERRED:` (reasoned, not directly observed) or `UNKNOWN:` (not determinable).

### Harness fidelity

`app/api/scrape-airbnb/route.ts` and its 5 local imports were transpiled with the project's own TypeScript 5.9.3 into `tmp-audit/build/`. The emitted route received **14 added probe lines and 0 deletions** (`diff tmp-audit/route.original.js tmp-audit/build/.../route.js` → 0 `<`, 14 `>`), so the logic under test is the shipped logic. `NODE_ENV=development` and `CHROME_PATH` selected local Chrome, matching [route.ts:45-56](app/api/scrape-airbnb/route.ts#L45-L56). A valid admin cookie was minted with the same HMAC construction as [verify-admin.ts:68-74](app/lib/api/verify-admin.ts#L68-L74).

**Two self-corrections made during this audit**, both recorded because they would otherwise have become false findings:
- An initial 8-way-concurrent image check reported 9 dead image URLs. Re-checking each serially with retries returned HTTP 206 for all 9 — they were my own connection resets against the Airbnb CDN. **The true dead-image count is 0.**
- A first liveness pass reported 0 dead listings because it only matched Airbnb's *generic* title. The actual marker is `404 Page Not Found - Airbnb`. **The true count is 14 of 43.**

---

## TASK A — Scraper execution truth

### A.1 What was run

Six listings drawn from the live catalogue (`airbnbUrl` values on real Firestore documents), chosen to span the requested variety. Run 6 was additionally re-run standalone to test whether its failure was transient.

| run | listing | catalogue type / tag | Firestore reviews / totalReviewCount |
|---|---|---|---|
| 1 | Private Basement Near Yonge St | Basement / Entire home | 0 / **436** |
| 2 | Panoramic Bright Lakeview Condo | Apartment / Entire home | 6 / **103** |
| 3 | High-End & Brand New Condo At Perfect Location | Condo / Entire home | 0 / 134 |
| 4 | Bright Guest Suite Near Yonge St | House / Entire home | 1 / 1 |
| 5 | Nice Room In Renovated Basement | Basement / **Private room** (only one) | 5 / 5 |
| 6 | Custom & Exclusive Celebrity Home Near Post Road | House / Entire home, 44 images | 2 / 2 |

Full payloads: `tmp-audit/scrape-1.json` … `tmp-audit/scrape-6.json`.

### A.2 Headline result

**Three of the six runs (3, 5, 6) returned a completely empty payload — and all three reported HTTP 200 with `success: true`.**

Run 3, verbatim from `tmp-audit/scrape-3.json`:

```
httpStatus : 200
payload.success : true
payload.data.name : "Something went wrong"
payload.data.description : ""
guests/bedrooms/beds/bathrooms : 0 / 0 / 0 / 0
coverImage : ""     images : []     offers : []     amenities : []     highlights : []
checkIn : "4:00 PM"   checkOut : "11:00 AM"      <- hard-coded defaults, route.ts:1105-1106
```

Cause, confirmed by loading the three URLs directly (`tmp-audit/check-dead.mjs`): Airbnb serves **HTTP 200** with `<h1>Something went wrong</h1>` and "Airbnb may be undergoing maintenance", and zero `data-section-id` elements. A follow-up plain-HTTP check of all 43 catalogue URLs shows these listings return `<title>404 Page Not Found - Airbnb</title>` — they are delisted (see §C.2). Because Airbnb answers 200 rather than 404, **nothing in the scraper detects this**.

What the operator sees ([PropertyForm.tsx:294](app/admin/components/PropertyForm.tsx#L294)) is a green success banner:

> Imported data for **"Something went wrong"**. Review & edit below, then save.

and the form's `name` field is overwritten with `"Something went wrong"`, because the mapping uses `data.name || prev.name` ([PropertyForm.tsx:264](app/admin/components/PropertyForm.tsx#L264)) and a non-empty string wins.

Run 6 was re-run in isolation after the others finished and **failed identically**, so this is not rate-limiting or a transient block — those listings are simply gone.

### A.3 Which extraction strategy fired, per field group

Probe output across all six runs:

| run | offers | topAmenities | reviews step1 / step2 / step3 → final | images dom+tour=merged |
|---|---|---|---|---|
| 1 | **S1** embedded JSON (34) | derived_from_finalOffers | 0 / – / – → **0** | 5+4=9 |
| 2 | **S1** embedded JSON (41) | derived_from_finalOffers | 0 / **6** / – → 6 | 7+15=20 |
| 3 | S2 modal DOM (**0**) | derived_from_finalOffers | 0 / – / – → 0 | 0+0=0 |
| 4 | **S1** embedded JSON (36) | derived_from_finalOffers | 0 / **1** / – → 1 | 5+6=11 |
| 5 | S2 modal DOM (**0**) | derived_from_finalOffers | 0 / – / – → 0 | 0+0=0 |
| 6 | S2 modal DOM (**0**) | derived_from_finalOffers | 0 / – / – → 0 | 0+0=0 |

Read per field group:

- **Amenities / offers** — Strategy 1 (embedded JSON, [route.ts:83-197](app/api/scrape-airbnb/route.ts#L83-L197)) is the only one that ever produces data, and it works well: 34–41 offers, **1622 of 1628 stored offers carry an icon**. Strategy 2 (amenities modal, [route.ts:199-262](app/api/scrape-airbnb/route.ts#L199-L262)) returned 0 on every run — on successful runs its only contribution is SVG icons merged over the JSON names; on failed runs it is the fallback and yields nothing. The `S2` label on runs 3/5/6 means "S1 found nothing so S2 was used", not "S2 worked".
- **topAmenities** — `scriptData.previewAmenities` was empty in **6 of 6** runs, so the card badges always fall through to `finalOffers.filter(available).slice(0,6)` ([route.ts:297-299](app/api/scrape-airbnb/route.ts#L297-L299)). The preview-amenities path is dead in practice.
- **Core listing fields** — Strategy 3 (DOM, [route.ts:304-588](app/api/scrape-airbnb/route.ts#L304-L588)) is the sole source of name, description, guests, bedrooms, beds, bathrooms, location, images, highlights, propertyTypeTag, checkIn/checkOut, rules, the three `*Allowed` booleans, and price.
- **Images** — the main-page DOM contributes 5–7; the photo-tour modal adds 4–15. Both work when the page loads.
- **Reviews** — Step 1 (embedded JSON, [route.ts:781-895](app/api/scrape-airbnb/route.ts#L781-L895)) returned **0 reviews in 6 of 6 runs**; it is completely broken. Step 2 (visible DOM, [route.ts:897-1006](app/api/scrape-airbnb/route.ts#L897-L1006)) is the only step that ever produced reviews (runs 2 and 4). Step 3 (review modal, [route.ts:1008-1080](app/api/scrape-airbnb/route.ts#L1008-L1080)) **never fired in any run** — its "Show all N reviews" button was never found.
  *Probe caveat:* the step-2 probe sits inside `if (extractedReviews.length > 0)`, so a `–` means "ran and found none" (the `reviews.length === 0` guard was true in every such run) rather than "did not run".

### A.4 Duration, and where the time goes

| run | wall | % of 120s ceiling | browser.launch | page.goto | page.evaluate | fixed sleeps | HTTP |
|---|---|---|---|---|---|---|---|
| 1 | 44.9s | 37.4% | 0.6s | 4.8s | 22.6s | 16.8s | 200 |
| 2 | **62.4s** | **52.0%** | 0.7s | 4.1s | **40.7s** | 16.9s | 200 |
| 3 | 35.6s | 29.6% | 0.7s | 2.9s | 16.6s | 15.4s | 200 |
| 4 | 49.8s | 41.5% | 1.3s | 8.7s | 22.6s | 17.1s | 200 |
| 5 | 34.7s | 28.9% | 0.6s | 3.1s | 16.6s | 14.3s | 200 |
| 6 | 34.5s | 28.7% | 0.6s | 3.0s | 16.6s | 14.2s | 200 |

Two things stand out.

**The cost is dominated by constants, not by network or parsing.** In run 2 — the most complete scrape — the three photo-tour scroll passes took 14.0s + 14.0s + 12.6s = **40.6s of the 40.7s total evaluate time**, i.e. 65% of the entire request. Actual parsing is negligible: every other `page.evaluate` call rounded to 0.0s. On top of that, every run spends **14–17s in hard-coded `setTimeout` sleeps** ([route.ts:76,213,603,612,645,656,670,674,995,1074](app/api/scrape-airbnb/route.ts#L76) — 1500, 2500, 4000, 1000, 1500, 500, 1500, 2500, 3000, 500 ms, several inside the 3-pass photo-tour loop). Faster hardware does not shrink either of these.

**Failures are fast; successes are slow.** The three failed runs clustered at 34.5–35.6s because there was nothing to scroll or extract. The ceiling risk therefore lives entirely on *successful* scrapes of image-rich listings. Run 2 reached 52% of the 120s budget on a local Mac with warm local Chrome, a residential IP, and **zero Chromium download**. Production adds all three of those back (see Task E).

### A.5 Every field that came back null, empty, or wrong

Across all six runs (`tmp-audit/analyse.mjs` output):

**Broken in 6 of 6 runs — these extractors do not work at all:**

| field | always returns | responsible code |
|---|---|---|
| `location` | `""` | [route.ts:502](app/api/scrape-airbnb/route.ts#L502) |
| `rules` | `[]` | [route.ts:554-565](app/api/scrape-airbnb/route.ts#L554-L565) |
| `price` | `0` | [route.ts:567-581](app/api/scrape-airbnb/route.ts#L567-L581) |
| `averageRating` | `0` | [route.ts:791-800](app/api/scrape-airbnb/route.ts#L791-L800) |
| `propertyTypeTag` | `""` → defaults to `"Entire home"` | [route.ts:311-317](app/api/scrape-airbnb/route.ts#L311-L317), default at [:1101](app/api/scrape-airbnb/route.ts#L1101) |
| `petsAllowed` / `smokingAllowed` / `partyAllowed` | `false` | [route.ts:555-564](app/api/scrape-airbnb/route.ts#L555-L564) |

**Wrong rather than empty:**

| field | observed | why it is wrong |
|---|---|---|
| `checkIn` | `"4:00"` (runs 1, 4) or the `"4:00 PM"` default (runs 2, 3, 5, 6) | never a correctly extracted value — see below |
| `checkOut` | `"11:00"` or the `"11:00 AM"` default | same |
| `totalReviewCount` | run 1 → **454** for a listing with **zero** reviews | captures the *host's* lifetime count — see below |

**Empty only on the three failed runs** (i.e. the extractor is fine, the page was not): description, guests, bedrooms, beds, bathrooms, coverImage, images, highlights, amenities, offers, reviews.

### A.6 Root causes, observed in the live DOM

A focused selector probe (`tmp-audit/dom-probe.mjs`, output `tmp-audit/dom-probe.json`) run against two *successfully loading* listings explains every permanent failure. These are not "the page failed" — these are selectors that no longer match the site.

| # | Observation on the live page | Consequence |
|---|---|---|
| 1 | `[data-section-id="OVERVIEW_DEFAULT"] h2` → **0 matches**. The section IDs present include **`OVERVIEW_DEFAULT_V2`**. | `propertyTypeTag` always `''` → silently defaulted to `"Entire home"`. **Airbnb renamed the section; the scraper still asks for v1.** |
| 2 | `[data-section-id="POLICIES_DEFAULT"] li` → **0 matches** (the section exists, but contains 31–32 `div`s and no `li`). | `rules` always `[]`, and `petsAllowed`/`smokingAllowed`/`partyAllowed` can **never** become `true` — they are only set inside that same `li` loop. |
| 3 | Policies text reads `Check-in after 4:00 p.m.` — **"p.m." with periods**. The regex is `/after\s+([\d:]+\s*(am\|pm)?)/i`. | `(am\|pm)?` cannot match `p.m.`, so the capture stops at `4:00`. On the second listing the text is `Check-in: 4:00 p.m.–11:00 p.m.` with no "after" at all, so the hard-coded `'4:00 PM'` default is used instead. Both outcomes are wrong, in different ways. |
| 4 | `[data-testid="book-it-default"]` text is **"Add dates for prices"**. Spans matching `^\$[\d,]+$` → **[]**. Spans containing any dollar amount → **[]**. `._1y74zjx` → 0 matches. | **There is no price anywhere on an undated Airbnb listing page.** This is not fixable by changing selectors — the scraper must request the URL with check-in/check-out dates. Note `._1y74zjx` is a hashed Airbnb class that rotates; it was already dead. |
| 5 | `"overallRating"` → **not present in any embedded script**. `"reviewsCount"` / `"visibleReviewCount"` → **not present**. | `averageRating` always 0 and review step 1 always returns 0. Airbnb removed those keys from the embedded JSON. |
| 6 | `[data-section-id="LOCATION_DEFAULT"] span` → 2 matches; section text is `Where you'll beMarkham, Ontario, Canada…`. `getText` takes `querySelector(...)` — the **first** span — and returns `''`. | `location` always `''`. The data is right there; the selector takes the wrong node. |
| 7 | On run 1's listing the page carries **`REVIEWS_EMPTY_DEFAULT`** (no reviews) and the *only* `"<n> reviews"` text in the entire DOM is **`454 reviews` inside `MEET_YOUR_HOST`** — the host's lifetime total. The fallback at [route.ts:880-887](app/api/scrape-airbnb/route.ts#L880-L887) takes the first match in DOM order. | **`totalReviewCount` silently records the host's review count whenever a listing has no reviews of its own.** Corroborating: three different Firestore properties all store exactly `436`, and this listing now reads `454`. On run 2's listing (which does have reviews) the first seven matches are the correct `110` and the host's `214` is eighth — so the fallback happens to be right only when the listing has reviews. |

### A.7 Verdict

**The scraper partially works, and its failures are invisible.**

What still works: amenities/offers via embedded JSON (with good icon coverage), images from both the main page and the photo tour, description, and the numeric capacity fields — but only on listings that load.

What is broken: **price, location, house rules, the three house-rule booleans, property type, average rating, and the embedded-JSON review extractor — seven extractors, broken on 100% of runs.** The review modal never fires. `totalReviewCount` is actively wrong on any listing without reviews.

The most serious defect is not any single extractor. It is that a scrape which retrieves *nothing at all* returns `HTTP 200 { success: true }` and is presented to the operator as a success with the property name set to `"Something went wrong"`.

---

## TASK B — Field parity matrix

Columns: **scraped** = present in the handler's `result` object ([route.ts:1092-1115](app/api/scrape-airbnb/route.ts#L1092-L1115)) · **form** = mapped by `handleScrapeAirbnb`'s `setFormData` ([PropertyForm.tsx:246-290](app/admin/components/PropertyForm.tsx#L246-L290)) · **POST** = survives `CreatePropertySchema` ([schemas.ts:67-103](app/lib/api/schemas.ts#L67-L103); verified empirically that Zod **strips** unknown keys) · **Firestore** = documents populated / 43 · **public UI** = rendered in `app/components/*` or `app/about/guests`.

| field | scraped? | mapped into form? | written by POST? | on Firestore docs | rendered in public UI? |
|---|---|---|---|---|---|
| `id` | – | – | generated | 43/43 | internal keys only |
| `slug` | – | auto-gen at save | ✅ | 43/43 | ❌ **never read** — URLs recompute from `name` |
| `name` | ✅ | ✅ | ✅ | 43/43 | ✅ card, panel, URL |
| `location` | ✅ | ❌ **DROPPED** | ✅ | 43/43 (from geocoder) | ✅ card fallback, city filter |
| `coordinates` | – | geocoder | ✅ | 43/43 | ✅ map |
| `price` | ✅ (always 0) | ✅ | ✅ | 43/43 (manual) | ✅ card, map pin |
| `currency` | – | ❌ no input; hard-coded `"CAD"` | ✅ | 43/43 (all CAD) | ❌ UI hard-codes `$` |
| `bedrooms` | ✅ | ✅ | ✅ | 43/43 | ✅ |
| `beds` | ✅ | ✅ | ✅ | 43/43 | ✅ panel |
| `bathrooms` | ✅ | ✅ | ✅ | 43/43 | ✅ |
| `guests` | ✅ | ✅ | ✅ | 43/43 | ✅ + filter |
| `coverImage` | ✅ | ✅ | ✅ | 43/43 | ✅ |
| `images` | ✅ | ✅ | ✅ | 43/43 | ✅ panel carousel |
| `type` | – | CustomSelect | ✅ | 43/43 | ❌ **admin filter only** |
| `icalUrl` | – | manual input | ✅ | 43/43 | ✅ availability |
| `airbnbUrl` | – | ✅ | ✅ | 43/43 | ❌ **never shown** |
| `googleMapsUrl` | – | ✅ | ✅ | 43/43 | ❌ **never shown** |
| `reviews` | ✅ (0 in 4/6 runs) | ✅ | ✅ | 35/43 | ✅ panel |
| `averageRating` | ✅ (always 0) | ✅ | ✅ | 43/43 — but **0 on 24/43** | ✅ panel |
| `totalReviewCount` | ✅ (**host's count** when listing has none) | ✅ | ✅ | 43/43 | ✅ panel |
| `propertyTypeTag` | ✅ (always the default) | ✅ | ✅ | 43/43 — **42 = "Entire home" default** | ✅ panel |
| `highlights` | ✅ | ✅ | ✅ | 43/43 (all exactly 3) | ✅ panel |
| `amenities` | ✅ | ✅ | ✅ | 43/43 (all exactly 6) | ✅ panel |
| `offers` | ✅ | ✅ | ✅ | 43/43 (1622/1628 have icons) | ✅ panel |
| `description` | ✅ | ✅ | ✅ | 43/43 | ✅ panel |
| `priceInfo.nightly` | ✅ (from `price`, so 0) | ✅ | ✅ | 43/43 | ✅ |
| `priceInfo.weekly` | ❌ | form field | ✅ | **0 on 38/43** | ❌ **never shown** |
| `priceInfo.monthly` | ❌ | form field | ✅ | **0 on 36/43** | ❌ **never shown** |
| `priceInfo.weekend` | ❌ | form field | ✅ | **0 on 26/43** | ❌ **never shown** |
| `priceInfo.cleaningFee` | ❌ | form field | ✅ | 41/43 | ✅ panel total |
| `priceInfo.minNights` | ❌ | form field | ✅ | 43/43 — **28+ on 22/43** | ❌ **never shown, never enforced** |
| `addressDetails.city` | ❌ | geocoder | ✅ | 43/43 | ✅ card, filter |
| `addressDetails.state` | ❌ | geocoder | ✅ | 43/43 | ✅ card |
| `addressDetails.area` | ❌ | geocoder | ✅ | 43/43 | ✅ panel |
| `addressDetails.country` | ❌ | geocoder | ✅ | 43/43 | ❌ **never shown** |
| `details.checkIn` | ✅ (truncated/default) | ✅ | ✅ | 43/43 — **"4:00" on 37/43** | ✅ panel |
| `details.checkOut` | ✅ (truncated/default) | ✅ | ✅ | 43/43 — **"11:00" on 40/43** | ✅ panel |
| `terms.smokingAllowed` | ✅ (always false) | ✅ | ✅ | 43/43 | ✅ panel |
| `terms.petsAllowed` | ✅ (always false) | ✅ | ✅ | 43/43 | ✅ panel |
| `terms.partyAllowed` | ✅ (always false) | ✅ | ✅ | 43/43 | ✅ panel |
| `terms.childrenAllowed` | ❌ | form default `true` | ✅ | 43/43 | ✅ panel |
| `terms.cancellationPolicy` | ❌ | form default `"Flexible"` | ✅ | 43/43 (41 Flexible, 2 Firm) | ✅ panel |
| `terms.rules` | ✅ (always `[]`) | ✅ | ✅ | **0 / 43** | ✅ panel — section never renders |

### Breaks in the chain, called out explicitly

**Captured, then silently dropped:**

1. **`location`** — the scraper extracts it ([route.ts:1098](app/api/scrape-airbnb/route.ts#L1098)) and `handleScrapeAirbnb`'s `setFormData` **has no `location` key**. The value is discarded in the browser. Currently harmless only because the extractor returns `''` anyway and the geocoder supplies the field — but fix the extractor and the value still never lands.

**Captured, written, and always empty because the extractor is broken:**

2. **`terms.rules`** — scraped → mapped → validated → stored → **`[]` on all 43 documents**. `PropertyDetailPanel` has a rules list that has never displayed anything.
3. **`terms.petsAllowed` / `smokingAllowed` / `partyAllowed`** — all three are `false` on all 43. Because they are initialised `false` and only flipped by the dead `li` loop, **"no pets" is indistinguishable from "never extracted"**, and the public UI states each as fact.
4. **`propertyTypeTag`** — 42 of 43 read `"Entire home"`, which is the hard-coded fallback. The single `"Private room"` was hand-corrected by an operator (run 5 confirms the scraper returns the default for that very listing).
5. **`price` / `priceInfo.nightly`** — scraped as `0` every time; every price in the catalogue was typed by hand.

**Stored and never shown to a guest:** `slug`, `currency`, `type`, `airbnbUrl`, `googleMapsUrl`, `priceInfo.weekly`, `priceInfo.monthly`, `priceInfo.weekend`, `priceInfo.minNights`, `addressDetails.country`.

Two of those deserve emphasis. **`airbnbUrl` is present on all 43 documents and rendered nowhere** — the site holds a working outbound booking link for every property and never shows it. And **`minNights` is stored (28+ nights on 22 of 43) but enforced nowhere** — it appears only as a type constraint in [schemas.ts:37](app/lib/api/schemas.ts#L37). The detail-panel calendar will happily accept a 2-night selection on a property with a 28-night minimum and answer "Great news! These dates are available."

**Schema behaviour, verified empirically:** `CreatePropertySchema` **strips** unknown keys (Zod default — confirmed by parsing a payload with an extra field). `UpdatePropertySchema` carries `.passthrough()` and would *not* strip — it is also never imported, so `PUT /api/properties/[id]` validates nothing at all. A form-default payload (`guests: 0`, `coverImage: ""`) fails `CreatePropertySchema` with three 422 issues: `slug`, `guests`, `coverImage`. None of them ever reach the operator (Task D).

---

## TASK C — Existing data health

Script: `tmp-audit/read-firestore.mjs` (only `.get()` calls; no write client constructed). Raw output in `tmp-audit/firestore-audit.json`.

### C.1 Totals

**43 properties** in the `properties` collection. No document carries a key outside the `Property` type.

### C.2 Image URLs

**871 image URLs** across `coverImage`, `images[]`, and `reviews[].avatar`. Every one is on a single host:

| host | total | HTTP 200/206 | dead |
|---|---|---|---|
| `a0.muscache.com` | 871 | **871** | **0** |

**Zero dead images today.** As noted in the preamble, an initial concurrent pass reported 9 failures; each returned 206 on serial retry, so those were measurement artifacts, not data loss.

This is the good news with a short shelf life. Every image in the catalogue is hot-linked from Airbnb's CDN, and **14 of the 43 source listings are already 404** (§C.6). `INFERRED:` muscache URLs for delisted listings are the ones most likely to be garbage-collected. There is no copy of any of these 871 images under your control — `next.config.mjs` allowlists `firebasestorage.googleapis.com`, but nothing in the catalogue uses it. Mirroring them into your own Storage bucket is a time-sensitive, currently-still-possible action.

### C.3 Properties with no `icalUrl`

**0 of 43.** Every property has an iCal feed, all on `www.airbnb.ca` (41) or `www.airbnb.com` (2). The homepage's "assume available when there is no feed" branch ([HomePage.tsx:265](app/components/HomePage.tsx#L265)) is currently unreachable.

What the feeds actually contain is a different matter — see §C.6.

### C.4 `location` vs `addressDetails.city`

**0 mismatches.** All 43 documents have `location` containing `addressDetails.city` as a substring (43 MATCH, 0 MISMATCH, 0 missing either field).

The field-mismatch risk in the city filter ([HomePage.tsx:243](app/components/HomePage.tsx#L243) tests `location`, while [MapFilters.tsx:44](app/components/MapFilters.tsx#L44) builds options from `addressDetails.city`) is **real in code but not currently triggered**, because both fields are written together by the geocoder, which composes `location` as `"city, state"` ([parse-google-maps/route.ts:164-166](app/api/parse-google-maps/route.ts#L164-L166)). It will trigger the first time an operator hand-edits `location`, or the first time Nominatim returns no city (in which case `location` falls back to `"lat, lng"` and `city` is `''`).

### C.5 Stored `slug` vs slug recomputed from current `name`

**27 of 43 (63%) have diverged.** Decomposed:

| cause | count |
|---|---|
| property was **renamed** after creation; slug never regenerated | 23 |
| the two slug algorithms differ on `&` (name never edited) | 2 |
| both | 2 |

The rename mechanism is exact: `handleSubmit` regenerates the slug only when it is empty —

```js
if (!finalData.slug && finalData.name) { finalData.slug = … }
```
— [PropertyForm.tsx:549-550](app/admin/components/PropertyForm.tsx#L549-L550). On an edit, `finalData.slug` is already populated from `initialData`, so it is never recomputed.

The two pure-algorithm cases are the properties with `&` in the name. The form's generator ([PropertyForm.tsx:550](app/admin/components/PropertyForm.tsx#L550)) drops `&`; the URL generator ([HomePage.tsx:16-22](app/components/HomePage.tsx#L16-L22)) converts it to `and`:

| name | stored slug | slug the URL actually uses |
|---|---|---|
| Custom **&** Exclusive Celebrity Home Near Post Road | `custom-exclusive-celebrity-home-near-post-road` | `custom-and-exclusive-celebrity-home-near-post-road` |
| High-End **&** Brand New Condo At Perfect Location | `high-end-brand-new-condo-at-perfect-location` | `high-end-and-brand-new-condo-at-perfect-location` |

Representative rename cases — note that the stored slug preserves the *original scraped Airbnb title*, which is how you can tell the rename happened:

| current name | stored slug (original title) |
|---|---|
| Corner Penthouse l Tall Ceiling | `corner-penthouse-2-bedroom-2-bathroom-free-parking` |
| Private Basement Near Yonge St | `1-bedroom-private-basement-suite-in-prime-location` |
| 7000 Sqft Estate l Indoor Pool | `6-level-heritage-mansion-with-indoor-pool` |
| Executive Townhome In Vaughan | `luxurious-heritage-home-in-the-heart-of-vaughan` |

Because the site derives URLs from `name` consistently, the *current* site works. The damage is historical: **every link shared before a rename now 200s and silently bounces the visitor to `/`**, and 23 properties have been renamed at least once.

### C.6 Catalogue freshness — the finding that is not in the data model

Fetching all 43 `airbnbUrl` values (`tmp-audit/check-listings.mjs`, output `tmp-audit/listing-liveness.json`):

| status | count |
|---|---|
| **LIVE** | 29 / 43 |
| **404 Page Not Found - Airbnb** | **14 / 43 (33%)** |

The two `airbnb.com` URLs initially looked like redirects; resolved against `airbnb.ca`, both are also 404.

Every one of those 14 still returns **HTTP 200** — Airbnb serves a soft 404. Re-scraping any of them produces the "Something went wrong" payload from §A.2.

**All 14 iCal feeds still return HTTP 200.** Inspecting their contents (`tmp-audit/ical-classify.mjs`):

| property state | count |
|---|---|
| blocked for ~a year by a single `SUMMARY:Airbnb (Not available)` event | **13 / 43** |
| — of those, Airbnb listing is 404 | 6 |
| — of those, Airbnb listing is LIVE | 7 |
| bookable on at least some dates in the next year | **30 / 43** |

Example, `Corner Penthouse l Tall Ceiling` (listing 404):

```
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260918
DTEND;VALUE=DATE:20270921
SUMMARY:Airbnb (Not available)
END:VEVENT
```

Two consequences, pointing in opposite directions:

- **13 properties can never be booked on any date for the next year**, yet all 13 appear in the list and on the map with a price whenever the visitor has not chosen dates. The availability filter only engages once dates are picked, at which point they silently vanish.
- **8 of the 14 dead listings have only a partial block** (96–186 days). Those will read as *available* for dates beyond the blocked window even though the Airbnb listing no longer exists. A guest choosing dates five months out gets "Great news! These dates are available" on a property that cannot be sold.

### C.7 Field-level completeness

All 43 documents populate every `Property` field with two exceptions:

| field | populated | note |
|---|---|---|
| `reviews` | **35 / 43** | 8 have no reviews array |
| `terms.rules` | **0 / 43** | empty array on every document — extractor broken since inception |

Nested objects are otherwise 43/43. But *populated* is not the same as *correct*. The distribution of stored values exposes the scraper's defects:

| field | distribution | reading |
|---|---|---|
| `details.checkIn` | `"4:00"` ×37, `"4:00 pm"` ×3, `"4:00 PM"` ×3 | 37 are **ambiguous** (no AM/PM); the 3 `"4:00 PM"` are the hard-coded default from failed scrapes |
| `details.checkOut` | `"11:00"` ×40, `"11:00 am"` ×3 | same |
| `averageRating` | `0` ×24, real values ×19 | **56% have no rating** |
| `propertyTypeTag` | `"Entire home"` ×42, `"Private room"` ×1 | 42 are the fallback default |
| `totalReviewCount` | includes `436` ×3, `433`, `322`, `198`, `134` | the high values are **host lifetime counts**, not listing counts — the three `436`s are three different properties |
| `priceInfo.weekly` | `0` on 38/43 | never scraped, rarely filled, never displayed |
| `priceInfo.monthly` | `0` on 36/43 | same |
| `priceInfo.weekend` | `0` on 26/43 | same |
| `priceInfo.minNights` | `28` ×20, `31` ×2, `1` ×19, `2` ×2 | **22 properties require a ~1-month stay; nothing enforces it** |
| `highlights` | exactly 3 on all 43 | form cap |
| `amenities` | exactly 6 on all 43 | form cap |
| `offers` | 1628 total, **1622 with an icon** | the icon matcher genuinely works |
| `currency` | `CAD` ×43 | no input exists to change it |
| `terms.cancellationPolicy` | `Flexible` ×41, `Firm` ×2 | 41 are the form default |

The most serious of these is `totalReviewCount`. For the 8 properties with high counts and zero stored reviews, the public detail panel hides the review block entirely (it requires `reviews.length > 0`), so nothing is shown. But for properties like *Panoramic Bright Lakeview Condo* the panel renders **"4.69 · 103 reviews"** while displaying 6 — and the live page's true figures are 4.75 and 110. The site publishes a review count it did not verify and a rating that is stale.

---

## TASK D — Silent failure surface

### D.1 The save path, traced end to end — confirmed

Three links, each of which independently destroys the error:

**1. The API returns a structured error.** A create with missing fields returns HTTP 422 with a field-level `issues` array ([safe-response.ts:60-67](app/lib/api/safe-response.ts#L60-L67)). Verified empirically against `CreatePropertySchema`: a form-default payload yields `slug: Too small`, `guests: Too small: expected number to be >0`, `coverImage: Invalid URL`.

**2. The data layer converts the error into a falsy return.** [properties.ts:57-76](app/lib/firebase/properties.ts#L57-L76):

```js
if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to create property'); }
…
} catch (error) { console.error("Error adding property:", error); return null; }
```

It throws, then catches its own throw, logs to a console nobody is watching, and returns `null`. The `issues` array is discarded without ever being read. `updateProperty` and `deleteProperty` do the same, returning `false`.

**3. The form discards the return value.** [PropertyForm.tsx:553-563](app/admin/components/PropertyForm.tsx#L553-L563):

```js
try {
  if (initialData?.id) { await updateProperty(initialData.id, finalData); }
  else { await addProperty(finalData as Omit<Property, "id">); }
  onSave();                       // <- unconditional
} catch (error) { console.error("Failed to save property", error); }
```

Because neither function can throw, **the `catch` is unreachable for any API error**, and `onSave()` always runs — closing the modal and refetching the list.

**Confirmed.** The operator fills in a property, clicks Save, the modal closes normally, and the property is simply absent from the list. There is no error, no toast, no retained form state. The work is gone.

### D.2 Every other swallowed or misreported failure in the ingestion path

| # | Where | What the operator sees | What actually happened |
|---|---|---|---|
| 1 | **Scrape of a delisted listing** — [route.ts:1092-1117](app/api/scrape-airbnb/route.ts#L1092-L1117), message at [PropertyForm.tsx:294](app/admin/components/PropertyForm.tsx#L294) | Green: *Imported data for "Something went wrong". Review & edit below, then save.* | Airbnb served a soft-404 error page. Every field empty; `name` overwritten with `"Something went wrong"`; check-in/out silently set to hard-coded defaults. **Observed in 3 of 6 runs.** |
| 2 | **Scrape status indicators** — [PropertyForm.tsx:225-245](app/admin/components/PropertyForm.tsx#L225-L245), applied at 10 call sites | Green/red borders on 10 inputs | `scrapedFields` tracks 11 fields and `scrapeClass()` is applied to only **10 of the 24 returned fields**. There is **no indicator at all** for `location`, `coverImage`, `images`, `amenities`, `offers`, `rules`, the three `*Allowed` booleans, `reviews`, `averageRating`, `totalReviewCount`, `propertyTypeTag` or `highlights` — i.e. no signal for any of the seven permanently broken extractors. |
| 3 | **`propertyTypeTag` fallback** — [route.ts:1101](app/api/scrape-airbnb/route.ts#L1101) | Field pre-filled `"Entire home"` | Extraction returned `''`. Indistinguishable from a real value. 42/43 documents carry it. |
| 4 | **check-in/out fallback** — [route.ts:1105-1106](app/api/scrape-airbnb/route.ts#L1105-L1106) | Field pre-filled `"4:00 PM"` | Extraction returned `''`. A plausible, wrong value. |
| 5 | **Photo-tour failure** — [route.ts:757-760](app/api/scrape-airbnb/route.ts#L757-L760) | Nothing; scrape reports success | `console.error('Photo tour scraping error (non-fatal)')` server-side only. The listing silently loses most of its images. |
| 6 | **Review-modal failure** — [route.ts:1078-1080](app/api/scrape-airbnb/route.ts#L1078-L1080) | Nothing | `console.error('Review modal scraping error (non-fatal)')`. Step 3 never fired in any of 6 runs and nobody would know. |
| 7 | **All review extraction fails** — [route.ts:1086-1088](app/api/scrape-airbnb/route.ts#L1086-L1088) | Nothing | `console.error('Review scraping error (non-fatal)')`; `reviews: []`, `averageRating: 0` returned as success. |
| 8 | **Eight further `catch { /* ignore */ }` blocks** — [route.ts:77,143,168,186,215,425,613,867,1076](app/api/scrape-airbnb/route.ts#L77) | Nothing | Banner dismissal, amenity-modal click, JSON parse failures, modal close. 14 catch sites in the file; 11 produce no client-visible signal. |
| 9 | **Single cover-image upload failure** — [PropertyForm.tsx:365-370](app/admin/components/PropertyForm.tsx#L365-L370) | Spinner stops; **nothing else** | `console.error` only, and the file input is reset. The operator concludes the click did not register. (The *multi*-image handler does `alert()` on failure — [PropertyForm.tsx:412-414](app/admin/components/PropertyForm.tsx#L412-L414) — so the two paths behave inconsistently.) |
| 10 | **Delete failure** — [admin/page.tsx:88-93](app/admin/page.tsx#L88-L93) | List refetches; property still there | `await deleteProperty(id)` return value ignored. A 401 from an expired session looks identical to a UI glitch. |
| 11 | **Property list fails to load** — [admin/page.tsx:29-34](app/admin/page.tsx#L29-L34) + [properties.ts:30-33](app/lib/firebase/properties.ts#L30-L33) | *"No properties yet — Get started by creating your first listing"* with a **Create Property** button | `getProperties()` caught a Firestore error and returned `[]`. There is no error state in the admin at all. A backend outage is presented as an empty database, inviting the operator to re-create records that already exist. |
| 12 | **Geocoder partial failure** — [parse-google-maps/route.ts:159-166](app/api/parse-google-maps/route.ts#L159-L166) | Green: *Location set: (43.8561, -79.3193)* | If Nominatim fails, `city/state/area/country` stay `''` and `location` falls back to `"lat, lng"`. `parts.join(', ')` is empty so the success message has a blank where the address should be. An empty `city` silently removes the property from the city-filter dropdown and breaks the card's location line. Not yet triggered — 43/43 have a city — but nothing prevents it. |
| 13 | **Rate limiter disabled** — [rate-limit.ts:76-90](app/lib/api/rate-limit.ts#L76-L90) | Nothing | Observed live during this audit: `[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured. Rate limiting is disabled.` One `console.warn`, once per process, server-side. Fails open. `UNKNOWN:` whether the vars are set in Vercel. |

The common thread: **the ingestion path has no concept of partial failure.** A scrape either throws (rare — only on an invalid URL or a browser crash) or returns 200 with whatever it managed to collect, and the UI renders "success" for both. Every one of the seven broken extractors in Task A has been failing on every import since the field was added, and nothing in the product could have told anyone.

---

## TASK E — Production divergence

Not executed against production. Each row is traced from code.

| # | Divergence | Local (as run in this audit) | Production (Vercel, `INFERRED:` from `maxDuration`, `@sparticuz/chromium-min`, and the comments at [admin.ts:20](app/lib/firebase/admin.ts#L20) / [rate-limit.ts:5](app/lib/api/rate-limit.ts#L5)) | Failure mode and how it presents to the operator |
|---|---|---|---|---|
| 1 | **Chromium source** — [route.ts:15-16,53-55](app/api/scrape-airbnb/route.ts#L15-L16) | `CHROME_PATH` → installed Chrome, 0.6–1.3s to launch | `await chromium.executablePath(CHROMIUM_PACK_URL)` downloads a tarball from `github.com/Sparticuz/chromium/releases/download/v143.0.4/…` **at runtime** | GitHub slow, rate-limited, or the release retagged → the launch throws → caught by the outer handler → HTTP 500 *"Failed to scrape the Airbnb listing. Make sure the URL is valid and the page is accessible."* The operator is told **their URL is wrong** when the real cause is a third-party download. This is the one failure the operator does see, and its message misdirects. |
| 2 | **The `NODE_ENV` gate** — [route.ts:45](app/api/scrape-airbnb/route.ts#L45) | `NODE_ENV=development` → local-Chrome branch | `next build`/`next start` set `NODE_ENV=production`, so **any** non-dev environment takes the serverless branch | A self-hosted or `next start` deployment — including a local production smoke test — tries to download Chromium instead of using the installed browser. Presents as #1. |
| 3 | **Duration ceiling** — `export const maxDuration = 120` ([route.ts:9](app/api/scrape-airbnb/route.ts#L9)) | No ceiling; measured 34.5–62.4s | Hard 120s kill | Local worst case was **62.4s = 52% of budget**, with zero Chromium download and a warm browser. Add a cold-start download plus slower serverless CPU and an image-rich listing plausibly exceeds 120s. The function is killed mid-flight: no JSON body, so `res.json()` in `addProperty` throws, is caught, returns `null` — and per Task D the operator sees the modal close with nothing saved. **A timeout is indistinguishable from a successful save.** |
| 4 | **Where the time goes** | 65% of run 2 was three photo-tour scroll passes (14.0+14.0+12.6s); 14–17s of every run is hard-coded `setTimeout` | Identical — these are wall-clock constants, not CPU-bound work | Faster production hardware buys nothing. The 120s budget is consumed by fixed sleeps and scroll passes that scale with photo count, so the listings most worth importing are the ones most likely to time out. |
| 5 | **Memory** | Whatever the Mac has | `UNKNOWN:` — there is no `vercel.json` and no memory configuration anywhere in the repo, so the account default applies | Headless Chromium on a 1024 MB serverless function is tight for an image-heavy page. OOM kills the function with no response body, presenting exactly as #3. Worth checking, since it is invisible from the repo. |
| 6 | **IP reputation** | Residential IP; 29 of 43 catalogue URLs loaded fine | Shared AWS/Vercel egress IPs | `INFERRED:` Airbnb bot-detection is far more likely to serve the interstitial to datacentre IPs. Critically, **this audit proved the scraper cannot distinguish a block from a real page** — it would return `name: "Something went wrong"` with `success: true`. In production this could be happening on *every* scrape and the green banner would look the same. Distinguishing this from the delisted-listing case requires the fix in the recommendations, not more investigation. |
| 7 | **Rate limiting** — [rate-limit.ts:72-90](app/lib/api/rate-limit.ts#L72-L90) | Confirmed **disabled** (no Upstash vars in `.env.local`); warning logged | 3 requests / 5 min / IP **if** the Upstash vars are set; unlimited if not | The limit keys on `x-forwarded-for` ([rate-limit.ts:47-51](app/lib/api/rate-limit.ts#L47-L51)), so a team behind one office IP **shares** a 3-per-5-minute budget. The fourth import in five minutes returns 429; `addProperty`'s error is swallowed, so the operator sees the scrape button do nothing. |
| 8 | **Hard-coded macOS Chrome path** — [route.ts:53-54](app/api/scrape-airbnb/route.ts#L53-L54) | Worked — the path exists on this machine | Not used in production (guarded by `NODE_ENV`) | Affects developers, not production: any Linux or Windows contributor running `next dev` gets a launch failure and the same misleading *"Make sure the URL is valid"* message. |
| 9 | **Cold start** | None | Download + extract Chromium, then launch, on every cold invocation | Adds to the #3 budget. Because imports are bursty and infrequent, **most production scrapes will be cold**, so the cold path is the normal path — the opposite of the local measurements. |

---

## Verdict

| subsystem | status | evidence | what it blocks |
|---|---|---|---|
| **Airbnb scraper — page load** | **broken for 1/3 of the catalogue** | 3 of 6 runs returned Airbnb's soft-404 as `HTTP 200 success:true`; 14 of 43 catalogue URLs are 404 (`tmp-audit/listing-liveness.json`) | Re-importing or refreshing a third of existing properties. Silently corrupts records with `"Something went wrong"`. |
| **Scraper — amenities/offers** | **working** | S1 embedded JSON returned 34–41 offers on all 3 loading runs; 1622/1628 stored offers have icons | — |
| **Scraper — images** | **working** | 5–7 from DOM + 4–15 from photo tour; 871 stored URLs all live | — but costs 65% of the runtime |
| **Scraper — price** | **broken** | `0` in 6/6 runs; live page shows *"Add dates for prices"*, zero dollar amounts in the DOM | Every price is typed by hand. Not selector-fixable: needs dated URLs. |
| **Scraper — location** | **broken** | `""` in 6/6; `LOCATION_DEFAULT span` matches but `getText` takes the wrong node ([route.ts:502](app/api/scrape-airbnb/route.ts#L502)) | Masked by the geocoder; value is also dropped by the form. |
| **Scraper — house rules + pets/smoking/party** | **broken** | `rules` `[]` in 6/6 and **0/43** in Firestore; `POLICIES_DEFAULT li` → 0 matches | The rules UI has never rendered. Three booleans are published as fact but never measured. |
| **Scraper — property type** | **broken** | `''` in 6/6; `OVERVIEW_DEFAULT` renamed to `OVERVIEW_DEFAULT_V2`; 42/43 stored = the default | Every property claims "Entire home". |
| **Scraper — check-in/out** | **broken** | `"4:00"` ×37 in Firestore; regex cannot match Airbnb's `"p.m."` | Guests see an ambiguous check-in time on 86% of listings. |
| **Scraper — reviews (embedded JSON)** | **broken** | 0 reviews in 6/6; `"overallRating"`/`"reviewsCount"` absent from page scripts | `averageRating` is 0 on 24/43. |
| **Scraper — reviews (visible DOM)** | **partial** | Worked in 2 of 6 runs (6 and 1 reviews) | Only source of review text. |
| **Scraper — reviews (modal)** | **broken** | Never fired in 6/6 runs | The ≥10-review deep fetch has never run. |
| **`totalReviewCount`** | **broken — publishes wrong data** | Run 1: listing has `REVIEWS_EMPTY_DEFAULT`, scraper stored **454** from `MEET_YOUR_HOST`; three Firestore properties share exactly `436` | The public panel shows counts the site never verified. |
| **Scraper — duration** | **partial / at risk** | 34.5–62.4s locally (max **52% of the 120s ceiling**) with no Chromium download | Image-rich listings plus cold start plausibly exceed 120s; a timeout presents as a silent no-op. |
| **Google Maps geocoder** | **working** | 43/43 have city/state/area/country and valid coordinates; 0 city/location mismatches | — but reports success even when Nominatim returns nothing. |
| **Admin save path** | **broken — reports success on failure** | `addProperty` returns `null` on error; `handleSubmit` calls `onSave()` unconditionally ([PropertyForm.tsx:553-563](app/admin/components/PropertyForm.tsx#L553-L563)); 422 `issues` never read | Operators cannot tell a saved property from a lost one. Root cause of the three "admin edits failing" commits at HEAD. |
| **`PUT /api/properties/[id]` validation** | **broken (absent)** | No schema; `UpdatePropertySchema` never imported | Arbitrary keys writable to Firestore by any authenticated caller. |
| **Slug lifecycle** | **broken** | 27/43 diverged — 23 renames (slug never regenerated) + 2 `&`-algorithm + 2 both | Every link shared before a rename silently bounces to `/`. |
| **Operator failure visibility** | **broken** | 13 distinct swallowed/misreported failure points; scrape indicators cover 10 of 24 fields and none of the 7 broken extractors | The single reason all of the above went unnoticed. |
| **Image hosting** | **working today, fragile** | 871/871 live, **100% hot-linked from `a0.muscache.com`**, 14 source listings already 404 | No owned copy of any listing image. Time-sensitive. |
| **iCal availability** | **working** | 43/43 feeds return 200 and parse; correctly blocks 13 fully-unavailable properties | — |
| **Catalogue freshness** | **broken** | 14/43 listings 404; 13/43 blocked ~a year; only **30/43 bookable on any date** | A third of the catalogue is unsellable and nothing surfaces it to the team. |
| **`minNights` enforcement** | **broken (absent)** | Stored 28+ on 22/43; referenced only in [schemas.ts:37](app/lib/api/schemas.ts#L37) | Guests can select 2 nights on a 28-night-minimum property and be told it is available. |

### The three things worth fixing first

1. **Make failure visible.** Have the scraper reject a page with no `data-section-id` elements or an `h1` of "Something went wrong" and return a real error; have `addProperty`/`updateProperty` return the 422 `issues`; have `handleSubmit` only close the modal on success. This is a few hours' work and it is the prerequisite for trusting anything else — five of the seven broken extractors would have been caught years earlier by it.
2. **Re-point the dead selectors.** `OVERVIEW_DEFAULT` → `OVERVIEW_DEFAULT_V2`, `POLICIES_DEFAULT li` → `div`, the `p.m.` regex, and `LOCATION_DEFAULT` taking the right span are all small, well-understood fixes that recover property type, house rules, the three booleans, check-in/out and location. Price is the exception: it needs dated URLs, not a new selector.
3. **Deal with the 14 dead listings and the 871 hot-linked images.** Both are time-sensitive in a way the rest of this report is not — a delisted listing's CDN assets are the ones most likely to disappear, and there is no copy under your control.
