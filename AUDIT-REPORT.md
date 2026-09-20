# nubnb.ca — Foundational Codebase Audit

**Repository:** `/Users/kianbaban/Development/Nubnb` · branch `main` · HEAD `e73532e` (2026-05-06)
**History:** 23 commits, 1 author (`floKianB`)
**Codebase size:** 97 tracked files — 6,197 lines TSX, 3,612 lines TS, 9,040 lines CSS (~18.8k total)
**Audit date:** 2026-09-20
**Method:** direct source reading, plus inspection of the committed-adjacent Turbopack build output in `.next/` (build `Kd4nNc3XTXQbANJJvh39f`, 2026-05-06 17:21, one commit behind HEAD — the homepage render path is unchanged by that commit). Read-only; no project files were modified.

**Legend** — claims are observed directly from source unless tagged `INFERRED:` (reasoned, not directly observed) or `UNKNOWN:` (not determinable from this repository).

**Verification note:** TypeScript compiles clean (`tsc --noEmit`, exit 0). There are no tests of any kind in the repo.

---

## 1. Stack & Infrastructure Map

### 1.1 Framework and versions

Versions are the **installed** versions resolved from `package-lock.json`, not the caret ranges in `package.json`.

| Package | Version | Role |
|---|---|---|
| `next` | 16.1.6 | App Router framework (Turbopack — `.next/server/chunks/[turbopack]_runtime.js`) |
| `react` / `react-dom` | 19.2.3 | UI runtime |
| `typescript` | 5.9.3 | `strict: true` — [tsconfig.json:7](tsconfig.json#L7) |
| `firebase` | 12.10.0 | Client SDK — Firestore reads, Storage uploads |
| `firebase-admin` | 13.8.0 | Server SDK — all Firestore writes |
| `zod` | 4.3.6 | Schema validation (only partially wired — see §5) |
| `maplibre-gl` / `react-map-gl` | 5.20.1 / 8.1.0 | Map rendering |
| `puppeteer-core` / `@sparticuz/chromium-min` | 24.40.0 / 143.0.4 | Airbnb scraping in serverless |
| `nodemailer` | 8.0.7 | Contact-form email |
| `@upstash/ratelimit` / `@upstash/redis` | 2.0.8 / 1.37.0 | Distributed rate limiting |
| `dompurify` | 3.4.1 | SVG sanitisation before `dangerouslySetInnerHTML` |
| `framer-motion` | 12.37.0 | Marketing-page animation |
| `date-fns` / `react-day-picker` | 4.1.0 / 9.14.0 | Dates and calendars |
| `lucide-react` | 0.577.0 | Icons |

Build scripts are stock: `next dev` / `next build` / `next start` / `eslint` ([package.json:5-10](package.json#L5-L10)). No test script, no typecheck script, no format script.

### 1.2 Hosting and deployment signals

There is **no deployment configuration in the repository at all** — no `vercel.json`, no `Dockerfile`, no `docker-compose.yml`, no `.github/` directory, no `netlify.toml`, no CI of any kind.

`INFERRED:` the target is **Vercel**, from five converging signals:

1. `.vercel` is gitignored ([.gitignore:34](.gitignore#L34)) and `public/vercel.svg` is committed.
2. `@sparticuz/chromium-min` is a Chromium build made specifically for AWS-Lambda-class serverless runtimes, and `serverExternalPackages` is set for it ([next.config.mjs:4](next.config.mjs#L4)).
3. `export const maxDuration = 120` ([app/api/scrape-airbnb/route.ts:9](app/api/scrape-airbnb/route.ts#L9)) is the Vercel function-duration directive.
4. Source comments name it: *"recommended for Vercel"* ([app/lib/firebase/admin.ts:20](app/lib/firebase/admin.ts#L20)); *"Works correctly across Vercel serverless cold starts"* ([app/lib/api/rate-limit.ts:5](app/lib/api/rate-limit.ts#L5)).
5. `getClientIP` reads `x-vercel-forwarded-for` ([app/lib/api/rate-limit.ts:57](app/lib/api/rate-limit.ts#L57)).

`UNKNOWN:` the actual Vercel project, its environment-variable values, its domains, and whether a staging/preview environment exists. None of that is in the repo.

**No security headers are configured.** `next.config.mjs` defines no `headers()` function, and the built `routes-manifest.json` confirms `"headers": []`. There is no CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy`.

### 1.3 Database, CMS and storage

There is no CMS. The backing store is **Google Firestore**, with **Firebase Storage** for images.

| Collection | Purpose | Defined at |
|---|---|---|
| `properties` | The entire listing catalogue | [app/lib/firebase/properties.ts:16](app/lib/firebase/properties.ts#L16), [firestore.rules:10](firestore.rules#L10) |
| `contact_submissions` | Contact-form records | [app/api/contact/route.ts:62](app/api/contact/route.ts#L62) |

Firestore security rules ([firestore.rules](firestore.rules)) are correct and minimal: `properties` is world-readable and client-write-denied; everything else is default-deny. All writes are intended to go through Admin-SDK API routes, which bypass rules.

**Storage rules are absent.** `firebase.json` declares only `{"firestore": {"rules": "firestore.rules"}}` — there is no `storage.rules` file and no storage block. See §5 Critical-4; this is the single largest unknown in the security posture.

Credential references:

| Variable | Used at | Notes |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_*` (6 vars) | [config.ts:6-11](app/lib/firebase/config.ts#L6-L11) | Browser-exposed by design |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | [admin.ts:21](app/lib/firebase/admin.ts#L21) | Full service-account JSON |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | [admin.ts:33](app/lib/firebase/admin.ts#L33) | ADC fallback path |
| `ADMIN_PIN` | [verify-admin.ts:28](app/lib/api/verify-admin.ts#L28) | Also used as the HMAC signing secret |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CONTACT_NOTIFY_EMAIL` | [contact/route.ts:23-24,73](app/api/contact/route.ts#L23-L24) | SMTP |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | [rate-limit.ts:72-73](app/lib/api/rate-limit.ts#L72-L73) | Rate limiting — **fails open if absent** |
| `CHROME_PATH`, `NODE_ENV` | [scrape-airbnb/route.ts:45,53](app/api/scrape-airbnb/route.ts#L45) | Local-dev Chrome |

**No secrets are committed.** `.env*` is gitignored ([.gitignore:29](.gitignore#L29)); `git ls-files` returns no env file and `git log --all -- ".env*"` is empty — nothing was ever committed and later removed. A populated `.env.local` does exist in the working tree containing a live service-account key, the Gmail app password, and the admin PIN. It is *not* in git, but it is plaintext on a developer laptop (§5 Medium-32). Notably, `UPSTASH_*` is **not** in it.

### 1.4 Third-party services

| Service | Purpose | Wired in | Credential |
|---|---|---|---|
| **Firebase Firestore** | Listing + contact data | [config.ts](app/lib/firebase/config.ts), [admin.ts](app/lib/firebase/admin.ts) | Yes |
| **Firebase Storage** | Property images | [PropertyForm.tsx:362](app/admin/components/PropertyForm.tsx#L362) | Client SDK, no auth |
| **CARTO basemaps** | Map tiles (`basemaps.cartocdn.com/gl/positron-gl-style`) | [MapView.tsx:78](app/components/MapView.tsx#L78), [PreviewMap.tsx:11-12](app/components/PreviewMap.tsx#L11-L12) | **None** — anonymous free tier |
| **OSM Nominatim** | Reverse geocoding | [parse-google-maps/route.ts:121](app/api/parse-google-maps/route.ts#L121) | **None** — free tier, UA `Nubnb Property Manager/1.0` |
| **Gmail SMTP** | Contact notifications | [contact/route.ts:28-31](app/api/contact/route.ts#L28-L31) | App password |
| **Upstash Redis** | Rate limiting | [rate-limit.ts:92-100](app/lib/api/rate-limit.ts#L92-L100) | REST token |
| **Airbnb** (scraped) | Listing import + review import | [scrape-airbnb/route.ts](app/api/scrape-airbnb/route.ts) | None — headless browser |
| **GitHub Releases** | Runtime Chromium binary download | [scrape-airbnb/route.ts:15-16](app/api/scrape-airbnb/route.ts#L15-L16) | None |
| **Google Fonts** | Manrope, Playfair Display | [layout.tsx:2,14-24](app/layout.tsx#L14-L24) | None |

**Not present anywhere in the codebase:** payments (no Stripe/PayPal/Square — no payment dependency in `package.json`), authentication (no `firebase/auth`, no NextAuth, no session/user model — `grep` for `getAuth|signIn|onAuthStateChanged|currentUser` returns zero hits), analytics (no GA, no Plausible, no Vercel Analytics, no Sentry or any error reporting).

---

## 2. Architecture & Data Flow

### 2.1 Route inventory

Rendering modes are taken from the build's `app-path-routes-manifest.json`, `routes-manifest.json`, and `prerender-manifest.json` — not inferred.

#### Pages

| Path | Purpose | Rendering mode |
|---|---|---|
| `/` | Homepage: map + listing list + filters + detail panel | **SSG** — prerendered to `index.html`, `initialRevalidateSeconds: false`. Listing data fetched client-side only. |
| `/about` | Guests-vs-Partners split router | **SSG**; page body is `"use client"` ([about/page.tsx:1](app/about/page.tsx#L1)), metadata from [about/layout.tsx:5](app/about/layout.tsx#L5) |
| `/about/guests` | Guest marketing page | **SSG**; client component, fetches live properties for city counts ([guests/page.tsx:171-173](app/about/guests/page.tsx#L171-L173)) |
| `/about/partners` | Host/partner marketing page | **SSG**; client component |
| `/contact` | Contact form | **SSG**; client component |
| `/fund` | "The Fund" investment offering | **SSG**; client component. **No `layout.tsx` → no own metadata** |
| `/admin` | Property CRUD dashboard | **SSG** shell; gated client-side by `PinGate` |
| `/property/[slug]` | Deep-link to a property | **Dynamic, on-demand SSR.** No `generateStaticParams`; `prerender-manifest.dynamicRoutes` is `{}`. Renders the same client `HomePage` with an `initialSlug` ([property/[slug]/page.tsx:6-9](app/property/[slug]/page.tsx#L6-L9)) |
| `/robots.txt` | Robots | Static route handler ([robots.ts](app/robots.ts)) |
| `/sitemap.xml` | Sitemap | Static route handler ([sitemap.ts](app/sitemap.ts)) |
| `/icon.png`, `/apple-icon.png` | Favicons | Static route handlers |
| `/_not-found`, `/_global-error` | Framework defaults | SSG — **no custom `not-found.tsx`, `error.tsx`, or `loading.tsx` exists** |

#### API routes

All are Node-runtime App Router handlers. "Auth" = admin session cookie required.

| Path | Method | Purpose | Auth | Rate limit | Input validation |
|---|---|---|---|---|---|
| `/api/admin-auth` | POST | Verify PIN, set session cookie | — | **None** ⚠ | Type check only ([verify-admin.ts:40](app/lib/api/verify-admin.ts#L40)) |
| `/api/admin-auth` | GET | Check session validity | — | None | n/a |
| `/api/properties` | POST | Create property | Yes | None | Zod `CreatePropertySchema` ✓ |
| `/api/properties/[id]` | PUT | Update property | Yes | None | **None** ⚠ |
| `/api/properties/[id]` | DELETE | Delete property | Yes | None | ID presence only |
| `/api/contact` | POST | Contact form → Firestore + email | — | 5 / 15 min | Zod `ContactSchema` ✓ |
| `/api/check-availability` | POST | iCal overlap check for a date range | — | 30 / min | URL allowlist + ISO date ✓ |
| `/api/fetch-booked-dates` | POST | Return booked ranges from an iCal feed | — | 30 / min | URL allowlist ✓ |
| `/api/parse-google-maps` | POST | Resolve a Maps URL → coords + address | **None** ⚠ | 20 / min | Domain allowlist ✓ |
| `/api/scrape-airbnb` | POST | Headless-browser import of an Airbnb listing | Yes | 3 / 5 min | Airbnb domain + `/rooms/` ✓ |

Outbound fetches from the iCal, Maps, and scrape routes go through [`guardedFetch`](app/lib/api/url-guard.ts#L97) — a genuinely solid SSRF guard covering private/reserved IPv4 and IPv6 ranges, localhost, protocol allowlisting, post-redirect re-validation, timeouts, and a `Content-Length` cap ([url-guard.ts:17-148](app/lib/api/url-guard.ts#L17-L148)). This is the best-engineered module in the repo.

### 2.2 Data model

**There is exactly one entity.**

`Property` — [app/types/property.ts:18-77](app/types/property.ts#L18-L77). 30 fields across identity (`id`, `slug`, `name`, `location`, `coordinates`, `type`, `propertyTypeTag`), capacity (`bedrooms`, `beds`, `bathrooms`, `guests`), pricing (`price`, `currency`, plus a nested `priceInfo` with `nightly`/`weekly`/`monthly`/`weekend`/`cleaningFee`/`minNights`), media (`coverImage`, `images`), content (`description`, `highlights`, `amenities`, `offers`), external links (`airbnbUrl`, `googleMapsUrl`, `icalUrl`), imported social proof (`reviews`, `averageRating`, `totalReviewCount`), and nested `addressDetails` / `details` / `terms`.

Supporting interfaces: `Offer` ([property.ts:3-8](app/types/property.ts#L3-L8)) and `Review` ([property.ts:10-16](app/types/property.ts#L10-L16)).

Runtime schemas in [app/lib/api/schemas.ts](app/lib/api/schemas.ts):
- `CreatePropertySchema` ([schemas.ts:67-103](app/lib/api/schemas.ts#L67-L103)) — used by the POST route.
- `UpdatePropertySchema` ([schemas.ts:112-148](app/lib/api/schemas.ts#L112-L148)) — **defined but never imported anywhere.** Dead code; the PUT route it was written for validates nothing.

The contact submission has **no type and no schema file** — its shape is an inline object literal at [contact/route.ts:62-69](app/api/contact/route.ts#L62-L69) (`name`, `email`, `subject`, `message`, `status: 'new'`, `createdAt`). Nothing reads the collection back; there is no admin view for it.

**Entities that do not exist in any form:** `Booking`, `Reservation`, `User`, `Guest`, `Host`, `Payment`, `Payout`, `Message`, `Availability`, `Organization`. There is no `lib/db` layer beyond the Firestore wrapper, no migrations, no seed script outside dead admin code.

`app/data/properties.ts` holds 36 mock properties with Unsplash imagery. Its own header says it is seed-only ([properties.ts:1-8](app/data/properties.ts#L1-L8)), and the only import is a dynamic one inside `handleSeedDatabase` ([admin/page.tsx:113](app/admin/page.tsx#L113)) — which is itself unreachable (§4).

### 2.3 The complete path of a listing to the rendered homepage

```
Firestore `properties` collection
  ↓  client Firebase SDK, getDocs(query(collection(db,'properties')))
     app/lib/firebase/properties.ts:20-34  — runs IN THE BROWSER ONLY
     (all errors caught → returns [])
  ↓  useEffect(..., []) inside a "use client" component
     app/components/HomePage.tsx:137-167   — DOES NOT RUN DURING SSR/PRERENDER
  ↓  setProperties(data)  → React state, initial value []
     app/components/HomePage.tsx:32
  ↓  filteredProperties = properties.filter(...)
     app/components/HomePage.tsx:235-269   — text, city, guests, availability
  ↓  <PropertyList properties={filteredProperties}/>  → <PropertyCard/>
     app/components/PropertyList.tsx:44-62
     <MapView  properties={filteredProperties}/>      → clustered markers
     app/components/MapView.tsx
```

Nothing in this chain executes on the server. There is no `generateStaticParams`, no `revalidate`, no server action, no `fetch` with Next caching, and no server-side Firestore read on any page — `getAdminDb()` is only ever called from API routes. The consequence is §3.

---

## 3. Priority Investigation — the homepage empty state

### 3.1 The answer

**The listing fetch is client-side only, and `/` is statically prerendered at build time.** The HTML that ships to every visitor and every crawler was generated once, at build, with an empty `properties` array baked in. This is not an SSR failure, and it is not (necessarily) an empty data source — the served HTML would be byte-identical if Firestore held five hundred listings.

### 3.2 Direct evidence from the build output

`/` appears in `prerender-manifest.json` under `routes` (static prerender) with:

```json
"/": { "initialRevalidateSeconds": false, "srcRoute": "/", "dataRoute": "/index.rsc" }
```

`initialRevalidateSeconds: false` means pure SSG — no ISR, no revalidation, no per-request rendering. `dynamicRoutes` in the same manifest is `{}`.

The resulting `.next/server/app/index.html` is 15,093 bytes. Stripped of `<script>` and `<style>`, **its complete visible text is**:

> NUBNB | Premium Property Discovery | Where | Search destinations | Who | Add guests | When | Add dates | **No properties found** | Try adjusting your search or filters to explore more locations. | About Us | Where | Search destinations | Who | Add guests | When | Add dates | About Us

Also confirmed against that file:
- `property-card-*` element IDs: **0 occurrences** — zero listings rendered.
- `<h1>`: **none.** The only heading of any level is `<h3>No properties found</h3>`.
- `application/ld+json`: **0 blocks.**
- `errorState` / `errorCard`: **0 occurrences** — see §3.4.

### 3.3 The responsible code

Five lines, in order:

1. **[app/page.tsx:3-5](app/page.tsx#L3-L5)** — the route's server component does nothing but render the client component. No data is fetched or passed down.
   ```tsx
   export default function Page() { return <HomePage />; }
   ```

2. **[app/components/HomePage.tsx:1](app/components/HomePage.tsx#L1)** — `"use client"`. Next still server-renders this for the initial HTML, but effects do not run.

3. **[app/components/HomePage.tsx:32](app/components/HomePage.tsx#L32)** — the initial state the server renders against:
   ```tsx
   const [properties, setProperties] = useState<Property[]>([]);
   ```

4. **[app/components/HomePage.tsx:137-167](app/components/HomePage.tsx#L137-L167)** — the *only* place listings are ever fetched, inside `useEffect`, which is browser-only:
   ```tsx
   useEffect(() => { /* ... */ const data = await getProperties(); /* ... */ }, []);
   ```

5. **[app/components/PropertyList.tsx:32-42](app/components/PropertyList.tsx#L32-L42)** — the string itself:
   ```tsx
   if (properties.length === 0) {
     return (<div className={styles.emptyState}> … <h3>No properties found</h3> … </div>);
   }
   ```

### 3.4 Which "No properties found" it is

There are two different strings in the codebase and it matters:

- `PropertyList.tsx:37` — `"No properties found"` (no trailing sentence). Rendered whenever the array is empty, **including during prerender**.
- `HomePage.tsx:148` and `:280` — `"No properties found. Please check back later."`, assigned to `fetchError` and rendered inside `styles.errorState`.

`errorState` appears **zero** times in the prerendered HTML, because `fetchError` starts as `null` and is only set inside the effect. So the production HTML string is the `PropertyList` one. The `errorState` card can only ever appear after hydration.

### 3.5 Ruling out the other two hypotheses

**"Is it failing during SSR?"** No. The build completed and emitted valid HTML for every static route. There is no server-side Firestore call on any page to fail. Separately, even a real failure would be invisible: `getProperties()` catches every error and returns `[]` ([properties.ts:30-33](app/lib/firebase/properties.ts#L30-L33)), so a total Firestore outage and an empty collection produce identical UI. That is its own defect (§5 Medium-19).

**"Is the data source empty at build/request time?"** `UNKNOWN:` I cannot read the live Firestore collection from this repository, and the audit is read-only. But it is *irrelevant to the served HTML* — the data source is never consulted at build or request time, only in the browser. If Firestore is also empty, that is a second, independent problem stacked on top of this one.

### 3.6 A compounding defect: the opaque loading overlay also ships

`isLoading` initialises to `true` ([HomePage.tsx:33](app/components/HomePage.tsx#L33)), so `.loadingOverlay` is present in the prerendered HTML (confirmed: 1 occurrence in `index.html`). Its CSS is full-bleed and opaque:

```css
.loadingOverlay { position:absolute; top:0; left:0; right:0; bottom:0;
                  background: var(--brand-navy); z-index: 9999; … }
```
— [page.module.css:252-263](app/page.module.css#L252-L263)

So the first paint for every visitor is a solid dark screen with a spinner. Real content cannot appear until JS has loaded, hydrated, opened a Firestore connection, and completed a round trip. There is no server-rendered content underneath worth showing, so this is currently masking nothing — but it means the perceived load time is bounded by the slowest of those four steps.

### 3.7 SEO consequence of the current rendering mode

This is the most damaging finding in the audit. The homepage is the commercial core of a discovery marketplace, and in its current mode it is functionally invisible to search:

1. **Zero indexable inventory.** No property name, price, city, image URL, or detail link exists in the HTML. Google's renderer may execute the JS and eventually see listings, but rendered-content indexing is best-effort, deferred, and unreliable; it is never the basis for a listings business. Bing, most AI crawlers, and every social/link-preview unfurler will only ever see the empty state.

2. **The one thing that *is* indexable says the business has no inventory.** The single `<h3>` on the page is "No properties found" — that is the strongest content signal Google receives about nubnb.ca's homepage.

3. **No `<h1>` anywhere on `/`.** Heading hierarchy starts and ends at `<h3>`.

4. **No structured data on `/`.** Zero `ld+json`. A rental marketplace should be emitting `Organization`/`LocalBusiness` plus an `ItemList` of `Accommodation`/`LodgingBusiness` entries with `Offer` pricing. `/about/guests` and `/about/partners` each carry one `WebPage` block ([guests/page.tsx:189-209](app/about/guests/page.tsx#L189-L209), [partners/page.tsx:176-196](app/about/partners/page.tsx#L176-L196)) — the marketing pages have schema, the money page has none.

5. **Every property page is a duplicate of the homepage, as declared by the site itself.** `/property/[slug]` has no `layout.tsx` and no `generateMetadata`, so it inherits the root layout's metadata — including `alternates: { canonical: "/" }` ([layout.tsx:29-31](app/layout.tsx#L29-L31)). Verified in the build: `/fund`, which has the same gap, ships `<link rel="canonical" href="https://nubnb.ca">` and `<title>NUBNB | Premium Property Discovery</title>`. Every property URL is telling Google "I am a duplicate of the homepage — drop me." Combined with client-only rendering, property pages cannot rank under any circumstances.

6. **Soft 404s on every property URL.** `/property/anything-at-all` returns HTTP 200. If no property matches the slug, `selectedId` stays `null` and the URL-sync effect rewrites the address bar back to `/` via `pushState` ([HomePage.tsx:88-92](app/components/HomePage.tsx#L88-L92)). Crawlers see an infinite supply of 200-OK near-duplicate pages.

7. **No property URLs in the sitemap.** [sitemap.ts](app/sitemap.ts) is a hardcoded four-entry list (`/`, `/about`, `/about/guests`, `/about/partners`). `/fund` and `/contact` are also missing.

**The fix shape** (not in scope to implement, stated for scoping): move the listing read to the server — either a server component using the Admin SDK, or `generateStaticParams` + ISR on the property route — and give `/property/[slug]` real `generateMetadata` with its own canonical, an `Accommodation` JSON-LD block, and a dynamic sitemap. That one change converts the site from zero indexable inventory to one indexable page per listing.

---

## 4. Feature Inventory

| Feature | Status | Evidence |
|---|---|---|
| **Text search** (name + location) | Working, client-only | [HomePage.tsx:237-239](app/components/HomePage.tsx#L237-L239), [TopFilters.tsx:20-26](app/components/TopFilters.tsx#L20-L26) |
| **City filter** | **Partial / likely broken** — options come from `addressDetails.city`, matching runs against `location` | Options: [MapFilters.tsx:41-49](app/components/MapFilters.tsx#L41-L49) · Match: [HomePage.tsx:242-243](app/components/HomePage.tsx#L242-L243) |
| **Guest-count filter** | Working | [HomePage.tsx:246](app/components/HomePage.tsx#L246), [MapFilters.tsx:185-203](app/components/MapFilters.tsx#L185-L203) |
| **Date-availability filter** | Partial — only filters properties that have an `icalUrl`; the rest are "assumed available" | [HomePage.tsx:248-266](app/components/HomePage.tsx#L248-L266) (comment at :265), debounce at [:173-233](app/components/HomePage.tsx#L173-L233) |
| **Filter UI on touch devices** | **Broken** — WHERE/WHO/WHEN open on `onMouseEnter` only, on non-interactive `<div>`s, with no `(hover:none)` fallback | [MapFilters.tsx:104,117,130](app/components/MapFilters.tsx#L104); rendered on mobile at [HomePage.tsx:346-359](app/components/HomePage.tsx#L346-L359) |
| **Map** (clustering, hover sync, zoom) | Working, well built | [MapView.tsx](app/components/MapView.tsx) — memoised markers ([:24-61](app/components/MapView.tsx#L24-L61)), greedy pixel clustering ([:90-130](app/components/MapView.tsx#L90-L130)) |
| **Property detail** | Working as a **slide-in panel**, not a page — no SSR, no metadata, no server-addressable URL | [PropertyDetailPanel.tsx](app/components/PropertyDetailPanel.tsx), routed at [property/[slug]/page.tsx](app/property/[slug]/page.tsx) |
| **Share property link** | Working (copies `window.location.href`) | [PropertyDetailPanel.tsx:149-160](app/components/PropertyDetailPanel.tsx#L149-L160) |
| **Availability check** | Working — real iCal fetch, parse, overlap test | [PropertyDetailPanel.tsx:97-136](app/components/PropertyDetailPanel.tsx#L97-L136) → [check-availability](app/api/check-availability/route.ts) → [ical-parser.ts](app/lib/api/ical-parser.ts) |
| **Price breakdown** (nights × rate + cleaning) | Working, display-only | [PropertyDetailPanel.tsx:538-575](app/components/PropertyDetailPanel.tsx#L538-L575) |
| **Booking flow** | **Absent.** The primary CTA is `Check Availability`; the fine print reads "You won't be charged to verify" | [PropertyDetailPanel.tsx:576-594](app/components/PropertyDetailPanel.tsx#L576-L594) |
| **Payments** | **No code at all.** No payment dependency in `package.json` | — |
| **Auth / accounts** | **No code at all.** No Firebase Auth, no user model, no sessions beyond the shared admin PIN | `grep getAuth\|signIn\|onAuthStateChanged\|currentUser` → 0 hits |
| **Host / partner side** | Marketing page only. No portal, no listing submission, no payouts, no host dashboard. CTA → `/contact` | [about/partners/page.tsx](app/about/partners/page.tsx) |
| **Contact form** | Working end to end: validated → Firestore → Gmail, rate-limited | [contact/page.tsx:26-51](app/contact/page.tsx#L26-L51) → [contact/route.ts](app/api/contact/route.ts) |
| **"The Fund"** | Working page. Funnel terminates in the generic contact form, whose subject enum has **no investment option** | [fund/page.tsx](app/fund/page.tsx) · enum at [contact/route.ts:13-17](app/api/contact/route.ts#L13-L17) |
| **Fund return calculators** | Working (12% and 30% sliders) | [fund/page.tsx:10-88](app/fund/page.tsx#L10-L88), instantiated at [:337,382](app/fund/page.tsx#L337) |
| **Admin: list / search / sort / stats** | Working | [admin/page.tsx:43-86](app/admin/page.tsx#L43-L86) |
| **Admin: create / edit / delete** | Working — but save failures are silently reported as success (§5 Medium-18) | [PropertyForm.tsx:541-564](app/admin/components/PropertyForm.tsx#L541-L564), [properties.ts:57-114](app/lib/firebase/properties.ts#L57-L114) |
| **Admin: Airbnb scrape import** | Working — 1,131 lines, multi-strategy (embedded JSON → DOM → review modal), with guaranteed browser cleanup | [scrape-airbnb/route.ts](app/api/scrape-airbnb/route.ts), cleanup at [:1124-1129](app/api/scrape-airbnb/route.ts#L1124-L1129) |
| **Admin: Google Maps geocode** | Working | [parse-google-maps/route.ts](app/api/parse-google-maps/route.ts), UI at [PropertyForm.tsx:301-354](app/admin/components/PropertyForm.tsx#L301-L354) |
| **Admin: image upload** | Working, but unvalidated and client-SDK-direct | [PropertyForm.tsx:356-410](app/admin/components/PropertyForm.tsx#L356-L410) |
| **Admin: amenity icon picker** | Working — 163-line internal SVG library, DOMPurify-sanitised | [amenityIcons.ts](app/data/amenityIcons.ts), [IconPicker.tsx](app/admin/components/IconPicker.tsx) |
| **Admin: PIN gate** | Working as UI; the underlying auth is critically weak (§5 Critical-1) | [PinGate.tsx](app/admin/components/PinGate.tsx), [verify-admin.ts](app/lib/api/verify-admin.ts) |
| **Global error boundary** | Working (client render errors only) | [ErrorBoundary.tsx](app/components/ErrorBoundary.tsx), mounted at [Providers.tsx:6](app/components/Providers.tsx#L6) |
| **"Seed database" action** | **Dead code** — defined, never rendered | `handleSeedDatabase` at [admin/page.tsx:110-121](app/admin/page.tsx#L110-L121); zero JSX references |
| **`UpdatePropertySchema`** | **Dead code** — never imported | [schemas.ts:112-148](app/lib/api/schemas.ts#L112-L148) |
| **`Property.slug`** | **Written, never read.** Routing recomputes a slug from `name` at runtime | Written: [PropertyForm.tsx:549-550](app/admin/components/PropertyForm.tsx#L549-L550) · Routing: [HomePage.tsx:16-22](app/components/HomePage.tsx#L16-L22) |
| **`Property.airbnbUrl`** | **Stored and validated, never rendered publicly.** No outbound booking link exists anywhere on the site | Only admin-side references; zero in `app/components/` |
| **`Property.googleMapsUrl`** | Same — admin input only | [PropertyForm.tsx:625](app/admin/components/PropertyForm.tsx#L625) |
| **`validateString` / `validateUrl`** | Internal helpers only; no route calls them directly | [validate.ts:14,34](app/lib/api/validate.ts#L14) |
| **`app/data/properties.ts`** (36 mocks) | Reachable only through dead code | [admin/page.tsx:113](app/admin/page.tsx#L113) |

---

## 5. Bug Candidates

### Critical

**C-1 · A 4-digit PIN with no rate limiting is the only thing protecting all write access.**
*Severity:* critical · *Consequence:* complete takeover of the property catalogue — create, edit, or delete every listing; trigger the expensive scraper at will.
`POST /api/admin-auth` imports no rate limiter and applies none ([admin-auth/route.ts:18-44](app/api/admin-auth/route.ts#L18-L44)) — compare every other public route, which does. The PIN space is 10,000 (`PIN_LENGTH = 4`, [PinGate.tsx:7](app/admin/components/PinGate.tsx#L7); digits-only, [:68](app/admin/components/PinGate.tsx#L68); the configured `ADMIN_PIN` is 4 characters). There is no lockout, no backoff, no CAPTCHA, no attempt logging. An unauthenticated attacker exhausts the keyspace in seconds. Every admin route — `POST /api/properties`, `PUT`/`DELETE /api/properties/[id]`, `POST /api/scrape-airbnb` — sits behind this one door.
*Files:* [app/api/admin-auth/route.ts:18](app/api/admin-auth/route.ts#L18), [app/lib/api/verify-admin.ts:39-60](app/lib/api/verify-admin.ts#L39-L60), [app/admin/components/PinGate.tsx:7](app/admin/components/PinGate.tsx#L7)

**C-2 · The admin PIN is also the HMAC signing secret for session tokens.**
*Severity:* critical · *Consequence:* session forgery collapses to the same 10,000-guess problem, offline; and the PIN cannot be rotated without invalidating all sessions, nor the signing key rotated without changing the PIN.
`getSecret()` returns `process.env.ADMIN_PIN` and is fed directly to `createHmac('sha256', …)` ([verify-admin.ts:27-31](app/lib/api/verify-admin.ts#L27-L31), [:70](app/lib/api/verify-admin.ts#L70), [:96](app/lib/api/verify-admin.ts#L96)). The token is `<timestamp>.<HMAC(PIN, timestamp)>` — no nonce, no user binding, no server-side session record. Given any one valid cookie, the PIN is recoverable offline in well under a second. Tokens are also unrevocable: there is no session store, so the only way to kill a leaked session is to change the PIN, which is also the password.
*Files:* [app/lib/api/verify-admin.ts:27-31,68-110](app/lib/api/verify-admin.ts#L27-L31)

**C-3 · Rate limiting fails open when Upstash is unconfigured.**
*Severity:* critical · *Consequence:* if the two Upstash env vars are missing in production, every "rate-limited" route in the table in §2.1 becomes unlimited — free unauthenticated SSRF-guarded proxying, contact-form spam into Firestore and the team inbox, and unbounded Nominatim traffic.
`createRateLimiter` returns a permissive pass-through and logs one warning when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are absent ([rate-limit.ts:76-90](app/lib/api/rate-limit.ts#L76-L90)). Those vars are **not** in `.env.local`, so local development runs entirely unprotected. `UNKNOWN:` whether they are set in Vercel — this is the first thing to check. A missing-credential condition on a security control should fail closed, or at minimum hard-fail the build.
*Files:* [app/lib/api/rate-limit.ts:72-90](app/lib/api/rate-limit.ts#L72-L90)

**C-4 · Firebase Storage rules are absent from the repo, and the upload path has no authentication.**
*Severity:* critical · *Consequence:* `INFERRED:` the Storage bucket is very likely open to unauthenticated public writes — anyone can fill it with arbitrary files at your expense, or host content under your domain.
Uploads use the **client** Firebase SDK directly from the browser ([PropertyForm.tsx:362-363](app/admin/components/PropertyForm.tsx#L362-L363), [:391-392](app/admin/components/PropertyForm.tsx#L391-L392)). There is no Firebase Auth anywhere in the codebase, so the browser presents **no credential** to Storage. `firebase.json` declares only Firestore rules ([firebase.json](firebase.json)) and there is no `storage.rules` file — meaning Storage rules are not version-controlled, not code-reviewed, and not deployed by this config. For the admin UI to function at all, those console-side rules must permit unauthenticated writes.
*Verify immediately* in the Firebase console; then move uploads behind a server route using the Admin SDK, or adopt Firebase Auth.
*Files:* [app/admin/components/PropertyForm.tsx:356-410](app/admin/components/PropertyForm.tsx#L356-L410), [firebase.json](firebase.json)

**C-5 · `PUT /api/properties/[id]` performs no schema validation whatsoever.**
*Severity:* critical (post-auth) · *Consequence:* arbitrary keys and values are written into Firestore property documents — unbounded strings, wrong types, injected fields that later crash the renderer, or attacker-controlled `coverImage`/`icalUrl` values.
The handler parses JSON, strips `id`, deep-strips `undefined`, and calls `docRef.update(updateData)` with no shape checking ([properties/[id]/route.ts:54-82](app/api/properties/[id]/route.ts#L54-L82)). `UpdatePropertySchema` was written for exactly this and is never imported ([schemas.ts:112](app/lib/api/schemas.ts#L112)). Git history shows this was deliberate: `4beff76 fix: admin property update failing due to strict Zod validation` → `4116789 fix: remove Zod validation from property updates — unblocks admin edits`. The schema was removed rather than loosened. Note it already carries `.passthrough()` ([schemas.ts:148](app/lib/api/schemas.ts#L148)), so re-enabling it would be permissive — worth re-testing against the original failure.
*Files:* [app/api/properties/[id]/route.ts:54-82](app/api/properties/[id]/route.ts#L54-L82), [app/lib/api/schemas.ts:112-148](app/lib/api/schemas.ts#L112-L148)

**C-6 · `/fund` publicly solicits investment with a "Guaranteed 12% annual return."**
*Severity:* critical (legal/regulatory, not technical) · *Consequence:* `INFERRED:` potential securities-law exposure in Ontario. This is flagged as a business risk for counsel, not as legal advice.
A page reachable by anyone, with no gating and no accredited-investor check, advertises two investment products: **"12% Annual Return — Guaranteed. Paid monthly."** with a $50,000 minimum ([fund/page.tsx:307-313](app/fund/page.tsx#L307-L313)), and **"Up to 30% Estimated Return"** with a $100,000 minimum ([:355-361](app/fund/page.tsx#L355)), each with a live return calculator ([:337](app/fund/page.tsx#L337), [:382](app/fund/page.tsx#L382)). Supporting claims: "$2M+ Capital Deployed", "70+ Properties in Portfolio", "100% Payment Track Record" ([:135-138](app/fund/page.tsx#L135-L138)); "Your principal is secured against NuBnb's managed property portfolio" ([:313](app/fund/page.tsx#L313)).
Three specific problems beyond the general exposure:
- The disclaimer contradicts the page. It says returns "are not guaranteed unless explicitly stated in a signed agreement" and that the page "does not constitute a public offering" ([:420-431](app/fund/page.tsx#L420-L431)) — while the card headline says *Guaranteed*, and the page is on the public internet with no access control.
- The page is **crawlable and indexable**. `robots.ts` disallows only `/admin` and `/api/` ([robots.ts:9](app/robots.ts#L9)); an `Allow` list does not exclude unlisted paths.
- "70+ Properties in Portfolio" sits on the same site whose listing page currently renders zero.
*Files:* [app/fund/page.tsx:135-138,307-320,355-368,420-431](app/fund/page.tsx#L135-L138), [app/robots.ts:5-13](app/robots.ts#L5-L13)

### High

**H-7 · The homepage ships zero indexable listing content.** *Severity:* high · *Consequence:* the discovery marketplace cannot be found by search. Full analysis in §3. *Files:* [app/page.tsx:3-5](app/page.tsx#L3-L5), [app/components/HomePage.tsx:1,32,137-167](app/components/HomePage.tsx#L137-L167)

**H-8 · `/fund`, `/admin`, and every `/property/*` URL declare `canonical: https://nubnb.ca`.** *Severity:* high · *Consequence:* Google is explicitly instructed to treat the Fund page and all property pages as duplicates of the homepage and drop them. Root layout sets `alternates: { canonical: "/" }` ([layout.tsx:29-31](app/layout.tsx#L29-L31)); only `/about`, `/about/guests`, `/about/partners`, and `/contact` override it via their own `layout.tsx`. Verified in the build: `fund.html` ships `<link rel="canonical" href="https://nubnb.ca">` and the homepage's `<title>`. *Files:* [app/layout.tsx:29-31](app/layout.tsx#L29-L31); missing `app/fund/layout.tsx` and `app/property/[slug]/layout.tsx`

**H-9 · No `<h1>` on the homepage.** *Severity:* high · *Consequence:* no primary heading signal on the most important page; the only heading is `<h3>No properties found</h3>`. `/about` has a visually-hidden `<h1>` ([about/page.tsx:58-60](app/about/page.tsx#L58-L60)) — the pattern exists, it just was not applied to `/`. *Files:* [app/components/HomePage.tsx:302-429](app/components/HomePage.tsx#L302-L429)

**H-10 · Every `/property/*` URL returns HTTP 200, then silently rewrites to `/`.** *Severity:* high · *Consequence:* infinite soft-404 surface; a shared link to a deleted or renamed property looks broken to the user and near-duplicate to a crawler. When `initialSlug` matches nothing, `selectedId` stays `null` and the sync effect `pushState`s back to `/` ([HomePage.tsx:88-92](app/components/HomePage.tsx#L88-L92)). There is no `notFound()` call and no `not-found.tsx`. *Files:* [app/property/[slug]/page.tsx:6-9](app/property/[slug]/page.tsx#L6-L9), [app/components/HomePage.tsx:57-93](app/components/HomePage.tsx#L57-L93)

**H-11 · Renaming a property breaks every previously shared link to it.** *Severity:* high · *Consequence:* silent link rot across social shares, emails, and any inbound backlinks. URLs are built from `toSlug(p.name)` computed at runtime ([HomePage.tsx:16-22](app/components/HomePage.tsx#L16-L22), used at [:61,82,102](app/components/HomePage.tsx#L61)), while the persisted `Property.slug` field — written once at creation ([PropertyForm.tsx:549-550](app/admin/components/PropertyForm.tsx#L549-L550)) — is never read. The two silently diverge on the first rename. *Files:* [app/components/HomePage.tsx:16-22](app/components/HomePage.tsx#L16-L22), [app/admin/components/PropertyForm.tsx:549-550](app/admin/components/PropertyForm.tsx#L549-L550)

**H-12 · City filter compares the wrong field and can silently return nothing.** *Severity:* high · *Consequence:* a core filter appears functional but returns an empty list whenever `location` is not a superstring of `addressDetails.city`. Dropdown options are built from `p.addressDetails.city` ([MapFilters.tsx:44](app/components/MapFilters.tsx#L44)); the filter tests `p.location.includes(selectedCity)` ([HomePage.tsx:242-243](app/components/HomePage.tsx#L242-L243)). These are populated independently — `location` is a free-text field the admin can edit, and the geocoder builds it as `"city, state"` only when Nominatim returns a city ([parse-google-maps/route.ts:164-166](app/api/parse-google-maps/route.ts#L164-L166)). *Files:* [app/components/HomePage.tsx:242-243](app/components/HomePage.tsx#L242-L243), [app/components/MapFilters.tsx:41-49](app/components/MapFilters.tsx#L41-L49)

**H-13 · The WHERE / WHO / WHEN filters are hover-only and keyboard-inaccessible.** *Severity:* high · *Consequence:* the primary search controls are unreliable or unusable on phones and tablets — the majority of traffic for a travel product — and unusable by keyboard entirely. The three sections are `<div>`s whose only handler is `onMouseEnter` ([MapFilters.tsx:104,117,130](app/components/MapFilters.tsx#L104)) — no `onClick`, no `onFocus`, no `onKeyDown`, no `role`, no `tabIndex`. There is no `@media (hover: none)` block in `MapFilters.module.css`, although four other stylesheets use exactly that pattern. `HomePage.tsx:346-359` renders this component *specifically for mobile*. *Files:* [app/components/MapFilters.tsx:98-143](app/components/MapFilters.tsx#L98-L143), [app/components/HomePage.tsx:346-359](app/components/HomePage.tsx#L346-L359)

**H-14 · The property-update route returns raw internal error messages to the client.** *Severity:* high · *Consequence:* leaks Firestore internals, field paths, and project structure to any authenticated caller — and directly contradicts the documented contract of the response helper. `apiError` exists precisely so that "Internal error details are logged server-side only" ([safe-response.ts:1-4,17-22](app/lib/api/safe-response.ts#L17-L22)), and every other route passes a fixed public string. The PUT handler instead forwards `err.message` as the public message ([properties/[id]/route.ts:88-89](app/api/properties/[id]/route.ts#L88-L89)). This was added in the same debugging push that removed validation. *Files:* [app/api/properties/[id]/route.ts:86-90](app/api/properties/[id]/route.ts#L86-L90)

**H-15 · No security headers are set anywhere.** *Severity:* high · *Consequence:* no defence-in-depth against clickjacking, MIME sniffing, or referrer leakage; no CSP to contain the three `dangerouslySetInnerHTML` sinks. `next.config.mjs` has no `headers()` ([next.config.mjs](next.config.mjs)); the built `routes-manifest.json` confirms `"headers": []`. The SVG sinks are DOMPurify-sanitised with the SVG profile ([PropertyDetailPanel.tsx:322,382](app/components/PropertyDetailPanel.tsx#L322), [IconPicker.tsx:88,157,173](app/admin/components/IconPicker.tsx#L88)) — good practice — but a CSP is the layer that catches a sanitiser bypass. *Files:* [next.config.mjs](next.config.mjs)

**H-16 · `/api/parse-google-maps` is unauthenticated.** *Severity:* high · *Consequence:* an open, SSRF-guarded proxy anyone can drive. Abuse routes traffic to OSM Nominatim under your `User-Agent` ([parse-google-maps/route.ts:125](app/api/parse-google-maps/route.ts#L125)), risking a Nominatim IP block that silently breaks the admin geocoding workflow. Every other admin-only capability calls `verifyAdminSession` first; this one does not ([route.ts:9-12](app/api/parse-google-maps/route.ts#L9-L12)) — compare [scrape-airbnb/route.ts:20-21](app/api/scrape-airbnb/route.ts#L20-L21), which gets it right. It is only ever called from the admin form ([PropertyForm.tsx:315-318](app/admin/components/PropertyForm.tsx#L315-L318)). *Files:* [app/api/parse-google-maps/route.ts:9-12](app/api/parse-google-maps/route.ts#L9-L12)

### Medium

**M-17 · Image uploads have no type or size validation.** Any file of any size is accepted and pushed to Storage ([PropertyForm.tsx:356-380](app/admin/components/PropertyForm.tsx#L356-L380), [:381-410](app/admin/components/PropertyForm.tsx#L381-L410)). Only the filename is sanitised. Combined with C-4, this is a storage-cost and content-hosting risk.

**M-18 · Admin save failures are reported to the user as success.** `updateProperty`/`addProperty` catch every error internally and return `false`/`null` — they never throw ([properties.ts:78-96](app/lib/firebase/properties.ts#L78-L96), [:57-76](app/lib/firebase/properties.ts#L57-L76)). `handleSubmit` ignores the return value and calls `onSave()` unconditionally, so the `try/catch` around it can never fire for an API error ([PropertyForm.tsx:553-563](app/admin/components/PropertyForm.tsx#L553-L563)). The modal closes, the list refetches, and the admin believes the edit landed. Directly relevant to the three "admin edits failing" commits at HEAD — the failure mode was invisible in the UI.

**M-19 · A Firestore outage is indistinguishable from an empty catalogue.** `getProperties()` catches all errors and returns `[]` ([properties.ts:30-33](app/lib/firebase/properties.ts#L30-L33)). The caller then interprets `length === 0` as "no properties" and shows "No properties found. Please check back later." ([HomePage.tsx:147-149](app/components/HomePage.tsx#L147-L149)) — so a total backend failure renders as a business with no inventory, and the carefully built error/retry UI at [HomePage.tsx:314-328](app/components/HomePage.tsx#L314-L328) is effectively unreachable.

**M-20 · Domain inconsistency between the app and the Storage CORS policy.** The app uses `nubnb.ca` throughout (17 references). `cors.json` allows only `https://nubnbsuites.com` and `https://www.nubnbsuites.com` ([cors.json:3](cors.json#L3)). `<img>` and CSS `background-image` are unaffected by CORS, so images still display — but any future canvas read, `fetch`, or direct XHR against Storage from `nubnb.ca` will fail, and the mismatch signals unresolved ambiguity about which domain is canonical. `UNKNOWN:` which domain is actually live.

**M-21 · Sitemap `lastmod` is frozen at build time.** `new Date()` is evaluated once at module scope ([sitemap.ts:6](app/sitemap.ts#L6)) and the route is statically generated with no revalidation — the built `sitemap.xml` carries `2026-05-06T21:21:24.246Z` on all four URLs while declaring `changefreq: daily`. Every crawl sees the same stale timestamp until a redeploy.

**M-22 · Sitemap omits `/fund`, `/contact`, and all property URLs.** Hardcoded four-entry array ([sitemap.ts:8-33](app/sitemap.ts#L8-L33)). `/fund` is additionally reachable from only one link site-wide ([about/page.tsx:88](app/about/page.tsx#L88)).

**M-23 · Focus outlines are disabled on both date pickers.** `--rdp-outline: none !important` and `--rdp-outline-selected: none !important` at [MapFilters.module.css:183-184](app/components/MapFilters.module.css#L183-L184) and [PropertyDetailPanel.module.css:876-877](app/components/PropertyDetailPanel.module.css#L876-L877). WCAG 2.4.7 failure on the date-selection flow.

**M-24 · No `prefers-reduced-motion` support anywhere.** Zero occurrences across all 15 stylesheets. `/about`, `/about/guests`, `/about/partners`, and `/fund` run unconditional Framer Motion entrance, stagger, scroll-triggered, and count-up animations. WCAG 2.3.3 / vestibular-safety concern.

**M-25 · The main search input has no accessible name.** Placeholder only — no `<label>`, no `aria-label` ([TopFilters.tsx:20-26](app/components/TopFilters.tsx#L20-L26)). The admin search has the same issue ([admin/page.tsx:196-202](app/admin/page.tsx#L196-L202)).

**M-26 · The `/about` page's primary navigation choice is a non-focusable `<div>`.** Both panels are `<motion.div onClick={...}>` with no `role`, `tabIndex`, or key handler ([about/page.tsx:91-98](app/about/page.tsx#L91-L98) and the mirrored Partners panel). Keyboard and screen-reader users cannot proceed past `/about` except via the nav links.

**M-27 · Hardcoded marketing statistics contradict each other and the live catalogue.** `/about`: "40+ Properties", "8 GTA Cities", "4.9★" ([about/page.tsx:116,120,124](app/about/page.tsx#L116)). `/about/partners`: "6 GTA Cities", "85% Occupancy", "$70+ Avg Nightly" ([partners/page.tsx:92-96](app/about/partners/page.tsx#L92-L96)). `/fund`: "70+ Properties in Portfolio" ([fund/page.tsx:136](app/fund/page.tsx#L136)). Meanwhile `/about/guests` derives its city breakdown from live data ([guests/page.tsx:178-186](app/about/guests/page.tsx#L178-L186)) and will render zero cities on the very next page. 8 vs 6 cities, and 40+ vs 70+ properties, are visible on adjacent pages.

**M-28 · Property imagery bypasses `next/image` on the highest-value surface.** The detail-panel hero and thumbnails use CSS `background-image` ([PropertyDetailPanel.tsx:170,215](app/components/PropertyDetailPanel.tsx#L170)) and review avatars use a raw `<img>` ([:428](app/components/PropertyDetailPanel.tsx#L428)) — no optimisation, no responsive `srcset`, no modern formats, no LCP priority hint. `PropertyCard` does it correctly ([PropertyCard.tsx:37-44](app/components/PropertyCard.tsx#L37-L44)) but sets `priority={false}` on every card, so the above-the-fold cards are never preloaded.

**M-29 · `alert()` is used for user-facing errors.** [PropertyDetailPanel.tsx:99,107](app/components/PropertyDetailPanel.tsx#L99) on the public booking path, and [PropertyForm.tsx:359,385](app/admin/components/PropertyForm.tsx#L359) in admin. Blocking, unstyled, and off-brand on a "premium" product.

**M-30 · No custom `not-found.tsx`, `error.tsx`, or `loading.tsx`.** Every 404 and every server-side error renders the stock Next.js page. The `ErrorBoundary` in `Providers` covers client render errors only ([Providers.tsx:6](app/components/Providers.tsx#L6)).

**M-31 · Live production secrets sit in plaintext in the working tree.** `.env.local` contains a full Firebase service-account key, the Gmail app password, and the admin PIN. It is correctly gitignored and was never committed — but there is no secret manager, no rotation record, and no documented recovery path if the laptop is lost.

**M-32 · The scraper downloads its Chromium binary at runtime from a pinned GitHub release.** [scrape-airbnb/route.ts:15-16](app/api/scrape-airbnb/route.ts#L15-L16). A third-party availability dependency on the admin's primary content-ingestion path, plus cold-start cost on every invocation.

**M-33 · Hardcoded macOS Chrome path for local development.** `'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` ([scrape-airbnb/route.ts:53-54](app/api/scrape-airbnb/route.ts#L53-L54)). `CHROME_PATH` overrides it, but the default silently breaks scraping for any Linux or Windows developer.

### Low

**L-34 · PIN length leaks before the constant-time comparison.** `pin.length !== adminPin.length ||` short-circuits ahead of `timingSafeEqual` ([verify-admin.ts:55](app/lib/api/verify-admin.ts#L55)). Moot in practice — the UI already announces "Enter the 4-digit PIN" ([PinGate.tsx:146](app/admin/components/PinGate.tsx#L146)) — but the constant-time intent is defeated.

**L-35 · Sessions cannot be revoked.** No server-side session store; the only revocation is changing `ADMIN_PIN`, which is also the password (see C-2).

**L-36 · `getProperties().then(setProperties)` with no `.catch()`.** [guests/page.tsx:173](app/about/guests/page.tsx#L173). Harmless today because `getProperties` never rejects, but it is a latent unhandled rejection if that ever changes.

**L-37 · `MAP_STYLE` is duplicated.** [MapView.tsx:78](app/components/MapView.tsx#L78) and [PreviewMap.tsx:11-12](app/components/PreviewMap.tsx#L11-L12).

**L-38 · CARTO basemaps are used anonymously.** No account, no API key ([MapView.tsx:78](app/components/MapView.tsx#L78)). Fine at low volume; subject to the provider's free-tier limits and attribution terms at scale.

**L-39 · `README.md` is unmodified `create-next-app` boilerplate.** No setup instructions, no env-var list, no architecture notes, no deploy runbook. There is no `CLAUDE.md` or contributor doc either.

**L-40 · No tests and no CI.** Zero `*.test.*` / `*.spec.*` files, no test runner in `package.json`, no `.github/workflows`. Nothing prevents a regression like C-5 from shipping again.

**L-41 · `.DS_Store` present in the working tree.** Gitignored, but indicates no pre-commit hygiene tooling.

### Explicitly checked and found clean

Worth recording so these are not re-audited:

- **No secrets in git.** No env file is tracked, and none appears anywhere in history.
- **No broken internal links.** All 44 `href="/…"` values across the codebase resolve to real routes.
- **SSRF protection is genuinely good.** [url-guard.ts](app/lib/api/url-guard.ts) covers private/reserved IPv4 and IPv6, localhost variants, protocol allowlisting, post-redirect re-validation, timeouts, and response-size caps.
- **XSS sinks are sanitised.** All three `dangerouslySetInnerHTML` HTML sinks pass through DOMPurify with the SVG profile; the two JSON-LD sinks serialise trusted static objects.
- **Firestore rules are correct** for the `properties` collection and default-deny everywhere else.
- **The scraper cleans up reliably** — `browser.close()` in a `finally` with its own try/catch ([scrape-airbnb/route.ts:1124-1129](app/api/scrape-airbnb/route.ts#L1124-L1129)).
- **TypeScript is strict and compiles clean** (`tsc --noEmit`, exit 0).
- **The availability debounce and fetch-cancellation logic are correct** ([HomePage.tsx:138-166](app/components/HomePage.tsx#L138-L166), [:171-233](app/components/HomePage.tsx#L171-L233)).
- **`PreviewMap` is not dead code** — it is dynamically imported by the guests page ([guests/page.tsx:24-26,520](app/about/guests/page.tsx#L24-L26)).

---

## 6. Product Gaps & SEO / Performance

### 6.1 SEO and metadata

**Present and working:** `robots.ts` and `sitemap.ts` both generate correctly; per-page `metadata` exports with canonical, OpenGraph, and Twitter cards for `/about`, `/about/guests`, `/about/partners`, and `/contact`; `metadataBase` is set ([layout.tsx:27](app/layout.tsx#L27)); `WebPage` JSON-LD with `Organization`/`LocalBusiness` publisher blocks on the two deep About pages.

**Missing:**

| Gap | Impact | Evidence |
|---|---|---|
| No structured data on `/` | The commercial page has zero schema. Needs `Organization` + `ItemList` of `Accommodation`/`LodgingBusiness` with `Offer` pricing | 0 `ld+json` blocks in `index.html` |
| No `Accommodation`/`Product`/`Offer` schema for any listing | No rich results, no price/rating/availability in SERPs — table stakes for rental search | No listing schema anywhere in `app/` |
| No `generateMetadata` on `/property/[slug]` | Every property shares the homepage title, description, and canonical | [property/[slug]/page.tsx](app/property/[slug]/page.tsx) has no metadata export |
| No `layout.tsx` for `/fund` | Inherits homepage title + canonical (verified in `fund.html`) | Missing `app/fund/layout.tsx` |
| No `BreadcrumbList` schema | — | No breadcrumbs anywhere |
| No per-property OG images | Every share unfurls as the same 512×512 logo | [layout.tsx:40](app/layout.tsx#L40) |
| `twitter.card: "summary"` on root, `/about`, `/contact` | Small-thumbnail cards instead of large-image; guests/partners correctly use `summary_large_image` | [layout.tsx:45](app/layout.tsx#L45), [about/layout.tsx:22](app/about/layout.tsx#L22), [contact/layout.tsx:22](app/contact/layout.tsx#L22) |
| `/fund`, `/contact`, property URLs absent from sitemap | Not discoverable via sitemap | [sitemap.ts:8-33](app/sitemap.ts#L8-L33) |
| Stale `lastmod` (M-21) | Crawl-budget signal is wrong | [sitemap.ts:6](app/sitemap.ts#L6) |
| No analytics or error monitoring of any kind | No traffic, funnel, conversion, or crash data — you cannot measure any fix in this report | No GA/Plausible/Sentry/Vercel Analytics dependency |

### 6.2 Accessibility

| Issue | WCAG | Evidence |
|---|---|---|
| No `<h1>` on `/`; heading hierarchy jumps to `<h3>` | 1.3.1, 2.4.6 | `index.html` |
| Filter controls are hover-only, non-focusable `<div>`s | 2.1.1 (keyboard) | [MapFilters.tsx:102-136](app/components/MapFilters.tsx#L102-L136) |
| `/about` panel choices are non-focusable `<div>`s | 2.1.1 | [about/page.tsx:91-98](app/about/page.tsx#L91-L98) |
| Focus outlines removed from date pickers | 2.4.7 | [MapFilters.module.css:183](app/components/MapFilters.module.css#L183), [PropertyDetailPanel.module.css:876](app/components/PropertyDetailPanel.module.css#L876) |
| No `prefers-reduced-motion` anywhere | 2.3.3 | 0 hits across 15 stylesheets |
| Search inputs have no accessible name | 3.3.2, 4.1.2 | [TopFilters.tsx:20](app/components/TopFilters.tsx#L20), [admin/page.tsx:196](app/admin/page.tsx#L196) |
| Modals (`PropertyForm`, `PinGate`) have no focus trap, no `role="dialog"`, no Escape handler | 2.1.2, 4.1.2 | [PropertyForm.tsx:566](app/admin/components/PropertyForm.tsx#L566), [PinGate.tsx:137](app/admin/components/PinGate.tsx#L137) |
| Carousel state changes are not announced | 4.1.3 | [PropertyDetailPanel.tsx:167-222](app/components/PropertyDetailPanel.tsx#L167-L222) |
| `alert()` for errors | 3.3.1 | [PropertyDetailPanel.tsx:99,107](app/components/PropertyDetailPanel.tsx#L99) |

Positives worth keeping: `aria-label` is used consistently on icon buttons, the `/about` page includes a visually-hidden `<h1>`, `lang="en"` is set, and the viewport config allows zoom to 5× ([layout.tsx:9](app/layout.tsx#L9)) rather than locking it.

### 6.3 Mobile and responsive

Responsive work is real and reasonably thorough: 15 stylesheets carry media queries, with a consistent 768px/1024px system plus small-screen refinements at 480/400/360/320px, and four stylesheets handle `(hover: none)`. `HomePage` implements a genuine mobile list/map toggle with a FAB ([HomePage.tsx:40,409-428](app/components/HomePage.tsx#L409-L428)).

The gaps:
- **H-13** — the filters, the single most important mobile interaction, are hover-only, and `MapFilters.module.css` is the one interactive stylesheet with no `(hover: none)` block.
- Mobile detection uses a JS resize listener rather than CSS ([HomePage.tsx:49-54](app/components/HomePage.tsx#L49-L54)), so `isMobile` is `false` during SSR and flips after hydration — a layout shift on every mobile page load.
- Unoptimised hero imagery (M-28) hits mobile data budgets hardest.

### 6.4 Performance

- Every page in the app is `"use client"` except the four metadata-only layouts. There is effectively no React Server Component usage, so the full component tree ships to the browser.
- The homepage is a single `main` that mounts MapLibre GL (a large WebGL library), `react-day-picker`, `date-fns`, `framer-motion`, and `lucide-react` — with no route-level code splitting. `PreviewMap` is the only dynamically imported component in the codebase ([guests/page.tsx:24-26](app/about/guests/page.tsx#L24-L26)).
- Nothing is cached anywhere: no `revalidate`, no `unstable_cache`, no CDN strategy for Firestore reads. Every visitor performs a fresh client-side Firestore round trip.
- Property filtering runs on every render without memoisation ([HomePage.tsx:235-269](app/components/HomePage.tsx#L235-L269)) — fine at 40 listings, a problem at 4,000. Note the admin page *does* use `useMemo` for the same work ([admin/page.tsx:43-77](app/admin/page.tsx#L43-L77)).
- The map clustering is `O(n²)` ([MapView.tsx:99-117](app/components/MapView.tsx#L99-L117)) — same trade-off.

### 6.5 What a rental marketplace needs that has no code at all

Ordered by how directly each blocks revenue:

1. **Booking / reservation.** No `Booking` entity, no reservation write path, no confirmation. The funnel ends at "Check Availability."
2. **Payments and payouts.** No processor, no deposits, no refunds, no host payouts, no tax or fee handling.
3. **Any way for a guest to transact at all.** `airbnbUrl` is stored on every property and rendered nowhere — even the outbound-referral fallback is unimplemented.
4. **Guest accounts.** No auth, no saved searches, no favourites, no trip history.
5. **Host accounts and onboarding.** `/about/partners` sells full-service management; there is no portal, no listing submission, no document upload, no payout view. Every partner lead lands in the same generic inbox.
6. **Guest↔host messaging.** None.
7. **First-party reviews.** Reviews are *scraped from Airbnb* ([scrape-airbnb/route.ts](app/api/scrape-airbnb/route.ts)) and stored on the property. No guest can write one; there is no moderation and no verification.
8. **Calendar write-back.** iCal integration is read-only ([ical-parser.ts](app/lib/api/ical-parser.ts)) — a booking made on nubnb.ca could never block the dates on Airbnb.
9. **Pricing engine.** `priceInfo` is six static numbers ([property.ts:51-58](app/types/property.ts#L51-L58)) — no seasonality, no length-of-stay discounts, no dynamic pricing, despite `/about/partners` advertising "dynamic pricing."
10. **Availability as first-class data.** Availability exists only as a live proxy fetch to third-party iCal feeds — no stored calendar, no holds, no minimum-stay enforcement (`minNights` is stored and never checked).
11. **Trust and safety.** No ID verification, no damage deposit, no insurance, no cancellation policy engine (`cancellationPolicy` is a free-text string).
12. **Lead management.** `contact_submissions` is written and never read — no admin inbox, no status workflow beyond a hardcoded `status: 'new'`, no CRM, no source attribution. Fund, partner, and guest leads are indistinguishable.
13. **Operational visibility.** No analytics, no error reporting, no uptime monitoring, no occupancy or revenue reporting.
14. **Internationalisation.** `currency` is an unconstrained string field; there is no locale handling and no multi-currency display.
15. **Legal pages.** No terms of service, no privacy policy, no cookie notice — despite collecting personal data via the contact form and operating under PIPEDA.

---

## 7. Anything Else Material

**7.1 · The Fund is the largest non-technical risk in the repository.** See C-6. Independent of securities questions, note the marketing-truth problem: the page claims "70+ Properties in Portfolio" and "100% Payment Track Record" while the site's own listing page renders zero properties, and the disclaimer's "not guaranteed" language directly contradicts the card's "Guaranteed." Get counsel on the page before doing anything else on this list.

**7.2 · The site republishes scraped Airbnb content, including third-party personal data.** [scrape-airbnb/route.ts](app/api/scrape-airbnb/route.ts) extracts listing copy, images, amenities, house rules, ratings, and up to 10 guest reviews with reviewer **first names** and **avatar URLs** (`reviews.push({ reviewer, date, rating, text, avatar })`). These are persisted to Firestore and rendered publicly ([PropertyDetailPanel.tsx:409-448](app/components/PropertyDetailPanel.tsx#L409-L448)), with avatars hot-linked from Airbnb's CDN — `a0/a1/a2.muscache.com` are explicitly allowlisted in [next.config.mjs:19-30](next.config.mjs#L19-L30). Three distinct exposures: Airbnb's terms of service; republishing named individuals' reviews as first-party social proof; and operational fragility, since muscache URLs rotate and expire, so property imagery and avatars will silently break over time.

**7.3 · The last three commits are a validation rollback, and the pattern is worth naming.** `4beff76 → 4116789 → e73532e`, all on 2026-05-06 within 17 minutes: an admin edit was failing, and the response was to delete the Zod validation (C-5) and expose raw error text to the client (H-14) rather than diagnose the schema mismatch. The actual root cause is visible in the final commit — Firestore's Admin SDK rejects `undefined`, which `stripUndefined` now handles ([properties/[id]/route.ts:25-38](app/api/properties/[id]/route.ts#L25-L38)). With that fix in place, `UpdatePropertySchema` can very likely be re-enabled as-is; it already carries `.passthrough()`. M-18 explains why the failure was so hard to diagnose: the UI reported success either way.

**7.4 · Security engineering quality is strikingly bimodal.** The same codebase contains a genuinely well-built SSRF guard, correct DOMPurify usage on every HTML sink, HTTP-only `sameSite: strict` cookies, HMAC-signed sessions with constant-time comparison, correct Firestore rules, a distributed rate limiter, a guaranteed-cleanup headless browser, and a documented safe-response layer — alongside a 4-digit unthrottled password that is also the signing key, unversioned Storage rules, and a write endpoint with no validation. The author clearly knows how to do this; the gaps look like expedience under deadline, not ignorance. Most of the Critical list is a few hours of work, not a rewrite.

**7.5 · Single-author, no tests, no CI, no review.** 23 commits, one author, zero tests, zero CI, no PR history, no branch protection (`main` is the only branch). Everything in §5 shipped straight to production. Before fixing anything, a minimal CI running `tsc --noEmit` and `eslint` would cost under an hour and would have caught nothing here — which is itself the point: the defects are behavioural, so the first tests worth writing are integration tests for the auth boundary and the property CRUD path.

**7.6 · The built `.next/` directory is committed to disk but gitignored.** It is one commit behind HEAD (build 17:21 vs HEAD 17:35). I used it as build evidence in §3 after confirming the homepage render path is untouched by the intervening commit. It is not deployed from, and it is stale — but note that anyone reading `index.html` locally is looking at a snapshot, not the live site. `UNKNOWN:` whether the current production deployment matches HEAD.

**7.7 · The empty state's copy is wrong for the situation it actually appears in.** "Try adjusting your search or filters to explore more locations" ([PropertyList.tsx:38](app/components/PropertyList.tsx#L38)) is correct advice when filters exclude everything — and actively misleading as the permanent server-rendered state of a homepage with no filters applied. Whatever happens to the rendering architecture, this string needs to distinguish "your filters matched nothing" from "we have no inventory" from "we could not reach the database" (M-19).

---

## Executive Summary

**The five worst problems**

1. A 4-digit PIN with **no rate limiting** — and which doubles as the session signing key — is the only barrier to creating, editing, and deleting every listing on the site. ([verify-admin.ts](app/lib/api/verify-admin.ts), [admin-auth/route.ts](app/api/admin-auth/route.ts))
2. The homepage is **statically prerendered with an empty listing array** and fetches data only in the browser, so the entire indexable content of nubnb.ca is the words "No properties found" — with no `<h1>` and no structured data. ([HomePage.tsx:137-167](app/components/HomePage.tsx#L137-L167), `.next/server/app/index.html`)
3. `/fund` publicly advertises a **"Guaranteed 12% annual return"** with a $50k minimum, no investor gating, and a disclaimer that contradicts the page — likely securities exposure that needs counsel before anything else on this list. ([fund/page.tsx:307-320,420-431](app/fund/page.tsx#L307-L320))
4. **Firebase Storage rules exist nowhere in the repo** while the browser uploads directly with no authentication at all, which means the bucket is almost certainly open to public writes. ([PropertyForm.tsx:362](app/admin/components/PropertyForm.tsx#L362), [firebase.json](firebase.json))
5. **There is no booking flow, no payments, and no accounts** — the product's furthest CTA is "Check Availability", and the stored `airbnbUrl` that could at least hand the guest off is rendered on no page. ([PropertyDetailPanel.tsx:576-594](app/components/PropertyDetailPanel.tsx#L576-L594))

**The five biggest opportunities**

1. **Move the listing read to the server** — one server component plus `generateMetadata` and `Accommodation` JSON-LD on `/property/[slug]` converts the site from zero indexable inventory to one ranking page per listing, and fixes the empty state, the soft-404s, and the duplicate canonicals at the same time.
2. **Close the admin hole in an afternoon** — rate-limit `/api/admin-auth`, split the session secret from the PIN, re-enable `UpdatePropertySchema` (already `.passthrough()`, so it should now pass with `stripUndefined` in place), and confirm the Upstash env vars are actually set in Vercel.
3. **Ship a real conversion step.** Even before payments, an inquiry-to-book form wired to the existing, working `/api/contact` pipeline (plus an `airbnbUrl` outbound link that is already in the data) turns a catalogue into a lead engine this week.
4. **Instrument the product.** There is no analytics and no error reporting anywhere, so today none of these fixes can be measured. Analytics plus Sentry is a half-day and makes every subsequent decision evidence-based.
5. **Harvest the strong foundations already here.** The SSRF guard, iCal parser, Airbnb importer, map clustering, and admin CRUD are genuinely good work — with server rendering, an auth upgrade, and a booking record on top, this is much closer to a real marketplace than the current homepage suggests.
