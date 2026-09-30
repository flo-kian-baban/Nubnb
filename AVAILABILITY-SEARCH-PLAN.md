# Availability search and the attention list: findings and plan (dispatch 22, 2026-09-30)

**Status: plan only. Nothing is built.** This document reports what the data
supports and proposes the feature. Every figure in Part 1 comes from a
read-only pass on 2026-09-30: the latest Firestore export
(`backups/2026-09-30T16-14-33Z/properties.json`, 46 documents), one fetch of
each of the 46 iCal feeds, and one fetch of each Airbnb listing page. The
scripts are in `tmp-audit/availability/`, a folder git ignores locally (as it
does the audit's own tooling), so they are on disk and not in the diff; they
take a few seconds to re-run.
The raw feeds were kept out of the repository on purpose: every reservation
line carries the last four digits of a guest's phone number.

**The rulings this is built under** (from the dispatch): admin-only, its own
page inside the admin panel plus figures on the admin home, the same shape as
costs; the current design language; availability refreshed on a schedule and
searched from the stored copy, never fetched live per property; the schedule
runs on Firebase, not Vercel; mobile is a later version and is not scoped.

---

## Part 1. What the data supports

### 1.1 What the feeds actually contain

All 46 properties have an `icalUrl`, all pointing at Airbnb's hosting-calendar
export (`PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN`). All 46 answered
HTTP 200, `text/calendar`, 315 to 9,275 bytes, the whole set in 0.8 s.

Across the 46 feeds there are **220 events**, and every event has exactly the
same six properties: `DTSTAMP`, `DTSTART`, `DTEND`, `SUMMARY`, `UID`, and (on
reservations only) `DESCRIPTION`. Dates are whole days (`VALUE=DATE`), with
`DTEND` the checkout day, exclusive. `DTSTAMP` is the moment the feed was
generated, which is the moment it was fetched (`20260930T203120Z` on every
event in every feed), so **a feed carries no "last changed" signal**; the only
way to know something changed is to compare fetches.

**There are exactly two kinds of event in the whole catalogue**, told apart by
`SUMMARY`:

| `SUMMARY` | Events | Has `DESCRIPTION` | What it is |
|---|---|---|---|
| `Reserved` | 164 (158 still in the future) | always: the reservation URL and the guest's phone, last four digits | a confirmed Airbnb reservation |
| `Airbnb (Not available)` | 56 (all in the future) | never | a night Airbnb will not sell, for any reason |

A reservation, verbatim (Modern Basement Near Yonge & Finch):

```
BEGIN:VEVENT
DTSTAMP:20260930T203120Z
DTSTART;VALUE=DATE:20260923
DTEND;VALUE=DATE:20261028
SUMMARY:Reserved
UID:1418fb94e984-a197bbd6c613f331bd2319a3e7911abe@airbnb.com
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de
 tails/HMY52A3N8S\nPhone Number (Last 4 Digits): 7411
END:VEVENT
```

A block, verbatim (Corner Penthouse l Tall Ceiling, the whole feed):

```
BEGIN:VCALENDAR
PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN
CALSCALE:GREGORIAN
VERSION:2.0
BEGIN:VEVENT
DTSTAMP:20260930T203120Z
DTSTART;VALUE=DATE:20260928
DTEND;VALUE=DATE:20271001
SUMMARY:Airbnb (Not available)
UID:7f662ec65913-9c84d43649eea52e7b2f9f0b36a3a289@airbnb.com
END:VEVENT
END:VCALENDAR
```

So, to the questions asked:

- **A booking is distinguishable from a block.** Yes, always: `Reserved`
  versus `Airbnb (Not available)`, and only a reservation carries a
  reservation URL.
- **An owner block is not distinguishable from a cleaning gap or an Airbnb
  setting.** They all say `Airbnb (Not available)`. What the shape of the
  block tells, with the reading I give it marked as inference:

| Shape of the `Not available` span | Count | Reads as (inferred) |
|---|---|---|
| one span covering the whole year ahead (324 to 368 nights) | 13 | the listing is not for sale on Airbnb: snoozed, unlisted, or every date closed |
| a span ending 2027-10-01 (twelve months out) that starts exactly 180, 270 or 365 days from today (one starts at 244) | 27 | the host's booking window: Airbnb exports every night past it as not available. Not a decision about any date. |
| tonight only (2026-09-30 → 2026-10-01) | 7 | the host's advance-notice setting: no same-day check-in. Not a block on anything. |
| one night, touching a reservation on one side | 3 | Airbnb preparation time between guests (one property, New Build Cottage By River) |
| anything else | 6 | a real block: the owner, or Airbnb, closed those dates |

The last two rows, plus the tonight-only rows, in full:

| Property | Blocked | Nights | Reads as | Note |
|---|---|---|---|---|
| 3 Bedroom Home In Ideal Location Near Yonge St | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| 7000 Sqft Estate l Indoor Pool | 2026-09-30 → 2027-01-03 | 95 | block |  |
| Charming 3 Bedroom Home In Richmond Hill | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| Cottage Vibe City Convenience | 2026-09-30 → 2026-12-11 | 72 | block |  |
| Cozy 1 Bedroom Basement Suite in Prime Location | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| Cozy 3 Bedroom House Near Yonge and Finch | 2026-09-30 → 2026-10-12 | 12 | block |  |
| Family Home in the Heart of Thornhill | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| New Build Cottage By River l Hot Tub | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| New Build Cottage By River l Hot Tub | 2026-10-04 → 2026-10-05 | 1 | 1-night gap | touches a reservation |
| New Build Cottage By River l Hot Tub | 2026-10-09 → 2026-10-10 | 1 | 1-night gap | touches a reservation |
| New Build Cottage By River l Hot Tub | 2026-10-12 → 2026-10-13 | 1 | 1-night gap | touches a reservation |
| New Build Cottage By River l Hot Tub | 2026-10-16 → 2026-10-19 | 3 | block |  |
| Nice Room In Renovated Basement | 2026-09-30 → 2026-11-11 | 42 | block |  |
| Spacious New Build Basement | 2026-11-06 → 2026-11-10 | 4 | block |  |
| Unbeatable Location 2 Bedroom 2 Bath Free Parking | 2026-09-30 → 2026-10-01 | 1 | tonight only |  |
| Unobstructed Lake View Condo | 2026-09-30 → 2026-10-01 | 1 | tonight only | touches a reservation |

The 27 booking-window tails matter for the design: **nothing past a
property's booking window can be searched**, because Airbnb reports it as not
available whether or not the owner would take the booking. Six properties
show only 180 days ahead, one 244, fourteen 270, one 360, and eleven the
full 365 (a one-night tail at 2027-09-30 is the export's own edge, not a
window). A search for next July finds nothing at twenty-one of the 33
properties that are not blocked all year, and the tool must say that is
the reason.

**Reservation lengths** (158 future reservations, clamped to today): 94 are 1
or 2 nights, 46 are 3 to 6, 5 are 7 to 13, 5 are 14 to 27, 4 are 28 to 35, 4
are longer. The short-stay condos on the waterfront turn over every day or
two; the monthly properties carry one or two long events each.

**What is not in any feed:** who booked, how many guests, what they paid,
inquiries, declined requests, views, and the reason for any block. A booking
made outside Airbnb appears only if the owner blocks the dates by hand, and
then it looks like any other block.

**One privacy point for the design:** the `DESCRIPTION` of every reservation
carries a guest's phone-number digits and the reservation code. The stored
copy must keep neither. The `UID` is an opaque Airbnb identifier and is safe
to keep; it is what lets a refresh tell a new reservation from an old one.

### 1.2 The next 90 nights, property by property

Nights from 2026-09-30 to 2026-12-28 inclusive. "Open" is a night with no
event; "Booked" is a `Reserved` night; "Blocked" is a `Not available` night.
"Longest open run" is the longest stretch of consecutive open nights in the
90. "Airbnb page" is what the listing URL on the document answered today.

| Property | City | Nightly | Min | Open | Booked | Blocked | Longest open run | Blocked all year | Airbnb page |
|---|---|---|---|---|---|---|---|---|---|
| 3 Bedroom 2 Bath Main Floor House | Toronto | $179 | 28 | 90 | 0 | 0 | 90 |  | gone (410) |
| 3 Bedroom Home In Ideal Location Near Yonge St | Markham | $200 | 1 | 89 | 0 | 1 | 89 |  | gone (410) |
| 4 Bedroom Family Home in Ajax | Ajax | $300 | 1 | 90 | 0 | 0 | 90 |  | gone (410) |
| 7000 Sqft Estate l Indoor Pool | Toronto | $419 | 28 | 0 | 0 | 90 | 0 |  | live (200) |
| Bright Guest Suite Near Yonge St | Toronto | $89 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Bright Walkout Basement l Private Patio | Vaughan | $119 | 28 | 85 | 5 | 0 | 68 |  | live (200) |
| Charming 3 Bedroom Home In Richmond Hill | Richmond Hill | $219 | 2 | 89 | 0 | 1 | 89 |  | gone (410) |
| City Skyline Panoramic Views | Toronto | $279 | 1 | 50 | 40 | 0 | 25 |  | live (200) |
| CN Tower Boutique Suite | Toronto | $239 | 1 | 85 | 5 | 0 | 68 |  | live (200) |
| Corner Penthouse l Tall Ceiling | Toronto | $139 | 28 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Cottage Vibe City Convenience | Richmond Hill | $359 | 1 | 16 | 2 | 72 | 16 |  | live (200) |
| Cozy 1 Bedroom Basement Suite in Prime Location | Toronto | $99 | 28 | 89 | 0 | 1 | 89 |  | gone (410) |
| Cozy 3 Bedroom Basement Suite Steps from Yonge St. | Toronto | $109 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Cozy 3 Bedroom House Near Yonge and Finch | Toronto | $500 | 1 | 78 | 0 | 12 | 78 |  | live (200) |
| Cozy Basement In Family Home | Toronto | $89 | 28 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Cozy Basement Near Yorkdale Mall | Toronto | $99 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Cozy Family Basement Suite | Aurora | $260 | 1 | 90 | 0 | 0 | 90 |  | gone (410) |
| Cozy Home Near Yonge & Steeles | Markham | $149 | 28 | 29 | 61 | 0 | 25 |  | live (200) |
| Cozy Home Near Yorkdale Mall | Toronto | $159 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Custom & Exclusive Celebrity Home Near Post Road | Toronto | $369 | 31 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Executive Townhome In Vaughan | Vaughan | $209 | 1 | 80 | 10 | 0 | 77 |  | live (200) |
| Family Friendly Lakeview Cottage | Georgina | $299 | 31 | 58 | 32 | 0 | 58 |  | live (200) |
| Family Home in the Heart of Thornhill | Markham | $399 | 1 | 89 | 0 | 1 | 89 |  | gone (410) |
| High-End & Brand New Condo At Perfect Location | Toronto | $119 | 1 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Lake View By Day, City Lights By Night | Toronto | $399 | 1 | 57 | 33 | 0 | 32 |  | live (200) |
| Modern 4 Bedroom 3 Bathroom In Quiet Neighbourhood | Toronto | $239 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Modern Basement Near Yonge & Finch | Toronto | $99 | 28 | 4 | 86 | 0 | 4 |  | live (200) |
| New Build Cottage By River l Hot Tub | Kawartha Lakes | $439 | 1 | 76 | 7 | 7 | 36 |  | live (200) |
| New Build Suite Near Yonge St | Toronto | $119 | 1 | 45 | 45 | 0 | 45 |  | live (200) |
| Newly Furnished Entire House | Toronto | $196 | 28 | 73 | 17 | 0 | 73 |  | live (200) |
| Nice Room In Renovated Basement | Ajax | $100 | 1 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Panoramic Bright Lakeview Condo | Toronto | $599 | 1 | 61 | 29 | 0 | 35 |  | live (200) |
| Penthouse At Yonge & Sheppard | Toronto | $149 | 28 | 44 | 46 | 0 | 35 |  | live (200) |
| Private Basement Near Yonge St | Toronto | $89 | 1 | 70 | 20 | 0 | 70 |  | live (200) |
| Private Lakeside Cottage \| Swim Right Into Lake! | Innisfil | $699 | 2 | 90 | 0 | 0 | 90 |  | gone (410) |
| Renovated House On Bayview | Toronto | $199 | 28 | 65 | 25 | 0 | 65 |  | live (200) |
| Skyline View - Free Parking | Toronto | $299 | 1 | 0 | 0 | 90 | 0 | yes | gone (410) |
| Spacious Basement Near Yonge St | Toronto | $99 | 1 | 71 | 19 | 0 | 71 |  | live (200) |
| Spacious New Build Basement | Richmond Hill | $109 | 28 | 74 | 12 | 4 | 49 |  | live (200) |
| Spacious North York Retreat | Toronto | $199 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Spacious Studio In Family Home | Toronto | $89 | 28 | 65 | 25 | 0 | 65 |  | live (200) |
| Sunlit Boho Skyline Stay | Toronto | $119 | 28 | 0 | 0 | 90 | 0 | yes | live (200) |
| Sunlit House With Southern Charm | Markham | $299 | 1 | 77 | 13 | 0 | 64 |  | live (200) |
| Unbeatable Location 2 Bedroom 2 Bath Free Parking | Toronto | $499 | 28 | 56 | 33 | 1 | 52 |  | live (200) |
| Unbeatable Views from 63rd-Floor Skyscraper | Toronto | $299 | 28 | 58 | 32 | 0 | 58 |  | live (200) |
| Unobstructed Lake View Condo | Toronto | $399 | 1 | 64 | 25 | 1 | 46 |  | live (200) |

Over the 46 properties and 90 nights (4,140 property-nights): **2,157 open, 622 booked, 1,361 blocked**. Over the 33 not blocked all year (2,970 property-nights): 2,157 open, 622 booked, 191 blocked; one of the 33, 7000 Sqft Estate l Indoor Pool, has no open night in the 90 (blocked, not booked).

**The 13 blocked for a year still hold.** The same 13 the audit found on
2026-09-20 are blocked from today to 2027-10-01 by one `Not available` event
(one of them, Nice Room In Renovated Basement, by two adjacent events): Corner
Penthouse l Tall Ceiling, Nice Room In Renovated Basement, Cozy Basement In
Family Home, Sunlit Boho Skyline Stay, Cozy Home Near Yorkdale Mall, Bright
Guest Suite Near Yonge St, Skyline View - Free Parking, Cozy Basement Near
Yorkdale Mall, High-End & Brand New Condo At Perfect Location, Spacious North
York Retreat, Cozy 3 Bedroom Basement Suite Steps from Yonge St., Modern 4
Bedroom 3 Bathroom In Quiet Neighbourhood, Custom & Exclusive Celebrity Home.
Six of the 13 have an Airbnb page that is gone; seven have a live page with a
closed calendar.

**Does the feed say why?** No. See 1.1: the year-long block is the same
`Airbnb (Not available)` as a one-night owner block.

**The 14 delisted listings are the audit's 14**, and Airbnb now answers them
with a real `410` and the title "404 Page Not Found - Airbnb" (the audit saw
a soft 200). The three properties added since the audit (Bright Walkout
Basement, CN Tower Boutique Suite, Cozy Home Near Yonge & Steeles) are live.
Their iCal feeds all still work.

**The finding that shapes the attention list:** eight properties have an
Airbnb page that is gone and a calendar that is wide open: Family Home in the
Heart of Thornhill, 3 Bedroom 2 Bath Main Floor House, Cozy Family Basement
Suite, Private Lakeside Cottage, Charming 3 Bedroom Home In Richmond Hill, 4
Bedroom Family Home in Ajax, 3 Bedroom Home In Ideal Location, Cozy 1 Bedroom
Basement Suite. Nothing in the feed says whether these are empty because
nobody can find them on Airbnb, or rented long-term with a calendar nobody
maintains, or no longer managed. Ranked by empty nights they dominate any
list: they hold $69,733 of the $128,291 of empty-night value in the next 30
days.

### 1.3 Fields a search could filter on

| Field | Populated | Values in the 46 | Reliable for a filter? |
|---|---|---|---|
| `guests` | 46/46 | 1 to 12; 6 is the mode (15) | **Yes.** Sanity-checked against beds: no outliers. |
| `bedrooms` | 46/46 | 0 to 6; 0 twice (a studio and a guest suite) | **Yes.** |
| `beds`, `bathrooms` | 46/46 | 1 to 6; 1 to 4.5 | Yes, but a caller asks for bedrooms, not beds. |
| `addressDetails.city` | 46/46 | 9 values: Toronto 31, Markham 4, Richmond Hill 3, Ajax 2, Vaughan 2, Aurora, Georgina, Innisfil, Kawartha Lakes | **Yes.** `location` is always "City, ON" and adds nothing. |
| `addressDetails.area` | 46/46 | 24 values | **No, as a filter.** Mixed grain: "York Region" (3) and "Simcoe County" are regions, "Downtown" and "North York" are districts, the rest are neighbourhoods. Fine for text search ("Yonge", "Harbourfront"). |
| `type` | 46/46 | House 20, Basement 11, Apartment 9, Condo 3, Villa 3 | **Mostly.** Four names say basement, suite or studio but the type says House or Condo; the type is what the admin set, so the search should match the name too. |
| `propertyTypeTag` | 46/46 | "Entire home" 43, plus one each of Private room, Entire guest suite, Entire condo | **No.** 10 of the 11 basements are tagged "Entire home". |
| `priceInfo.nightly` | 46/46 | $89 to $699 | **Yes, by ruling.** `price` diverges on 3 (accepted state); the search reads `nightly` only. |
| `priceInfo.minNights` | 46/46 | 1 ×20, 2 ×2, 28 ×22, 31 ×2 | **Yes, and it is the second most important field after dates.** Half the catalogue is monthly. It is admin-set, so it is a policy the admin on the phone may bend; the search treats it as a note, never a wall. |
| `priceInfo.cleaningFee` | 44/46 non-zero | $80 to $300 | Usable to show; not a filter. |
| `priceInfo.weekend` | 19/46 non-zero | $149 to $1,499 | Not used anywhere on the site; not used here. |
| `coordinates` | 46/46 | all valid, `[longitude, latitude]` | Yes; a map is not proposed for v1. |
| `terms.petsAllowed`, `smokingAllowed` | 46/46 | `false` on all 46 | **Not trustworthy.** `false` everywhere reads as a form default, not 46 decisions; one property's offers say pets are allowed. Not offered as a filter. |
| `amenities` | 46/46 | always 6 items, mostly toiletries | Useless. |
| `offers` | 46/46 | 20 to 60 items | Usable for text search only: parking on 42, pool 5, hot tub 2, EV charger 2, washer 43, air conditioning 46. |
| delisted | **no such field** | | Only derivable by fetching the Airbnb page (1.2). |
| any date, any booking history | **none** | | The feeds are the only availability data that exists. |

Missing or inconsistent, in one line: nothing is missing on any document;
`area`, `propertyTypeTag` and the `terms` booleans are the inconsistent
ones, and none of the three is needed for the search.

### 1.4 Whether anything indicates demand

Nothing does, and this should be said plainly:

- `contact_submissions` holds **3 documents** since 2026-06-20. All three have
  the subject "I'm looking to book" and none carries the structured stay
  fields (`propertyId`, `checkIn`, `checkOut`, `guests`) the contact form can
  record, so there is not one dated request for one property in the data.
- No search, date-filter use or availability check is logged anywhere: the
  booked-dates route is cached at the edge, and analytics are ruled out.
- Airbnb's export carries no views, inquiries or declined requests.
- The one demand-shaped signal that can exist is the **pace at which
  reservations appear**: a reservation present in today's fetch and absent
  from yesterday's is a booking made in the last day. That can only be known
  from the day the refresh starts keeping snapshots, and never for the past.
  It measures what Airbnb sold, not what anyone asked for.

What cannot be known, at all, from this data: why a property is empty;
whether anyone wanted an empty night; what price would have sold it; what
the listing's traffic is on Airbnb; whether the owner wants it sold.

---

## Part 2. The proposal

### 2.1 Shape

- **One page, `/admin/availability`**, a fifth section in the admin header
  ("Availability", after Costs; the header already wraps its sections under
  860 px). Two views on the one page, mirrored into the URL as Costs does
  (`?view=search` and `?view=attention`); the search opens by default because
  a call is the urgent case, and the attention list is one click.
- **Two figures on the admin home**, beside the four that are there.
- **One stored document** holds every property's calendar, written by a
  **scheduled Cloud Function on Firebase every hour** and by a **Refresh now**
  button. The page never fetches a feed.
- Everything on the page is the existing kit: `AdminHeader`, `AdminSelect`,
  `DateRangeField`, the `.toolbar`, `.table` and `.statCard` styles from
  `page.module.css`, the reason chips in the Properties toolbar's chip style.

### 2.2 The stored copy

Two server-only collections, denied to browsers in `firestore.rules` like
every collection since dispatch 17. Read and written through the Admin SDK
only.

**`availability_snapshots/current`**, one document, replaced on every refresh:

```
refreshedAt      ISO time of the last run that wrote this document
run              { startedAt, finishedAt, durationMs, source: "schedule" | "manual",
                   fetched: 46, failed: [{ propertyId, name, error }] }
horizonEnd       the last day any feed can speak for (today + 365)
properties       {
  <propertyId>: {
    name, icalUrl                          (as read at refresh time)
    fetchedAt                              ISO time of the last successful fetch
    status                                 "ok" | "failed" | "no-feed"
    failedSince, error                     present while status is "failed"
    bytes, eventCount
    events: [ { uid, kind: "reserved" | "blocked", start, end } ]
    airbnbPage: { checkedAt, status, verdict: "live" | "gone" | "unknown" }   (see 2.3, optional)
  }
}
```

`events` keeps four things per event and nothing else: no `DESCRIPTION`, so
no reservation URL and no phone digits ever land in Firestore or in a
`./backups/` export. Today's catalogue is 220 events, about 25 KB; the
document limit is 1 MiB, so this shape has room for forty times the events.
One document means the page costs **one read** for all 46 calendars.

**`availability_days/{YYYY-MM-DD}`**, the first snapshot of each Toronto day,
same shape, written by the refresh when the day's document does not exist
yet. About 25 KB a day, under 10 MB a year, against 1 GiB free. **This is the
one decision that is expensive to change later**: history cannot be
backfilled, and it is the only way the "reservations added since" figure in
1.4 can ever exist. Version 1 uses it for one thing, "booked in the last 7
days" on the attention list, and shows nothing until seven days have been
kept. It is my decision to keep it from day one; it is cheap to remove and
impossible to recover.

### 2.3 The refresh

**Where it runs.** A scheduled Cloud Function (2nd generation) in a new
`functions/` directory: `firebase-functions` v6 `onSchedule("every 60
minutes")`, time zone `America/Toronto`, region `us-central1` (the Firestore
database is in `nam5`, the US multi-region), 256 MiB, 120 s timeout, minimum
instances 0. Deploying it creates its Cloud Scheduler job and Pub/Sub topic;
nothing is set up by hand.

**What one run does.**

1. Reads `properties` with a projection of `name` and `icalUrl` only (46
   reads; nothing else on the document is needed).
2. Fetches every feed, eight at a time, 10 s timeout, one retry after 2 s.
   The parser is today's `parseIcalEvents` extended to keep `SUMMARY` and
   `UID` and to map `Reserved` to `reserved` and everything else to
   `blocked`; recurrence expansion stays as it is (Airbnb has never sent an
   `RRULE`, but the parser handles one).
3. Builds the new document from the old one: a property whose fetch
   succeeded gets its new events and `fetchedAt`; a property whose fetch
   failed **keeps its previous events**, gets `status: "failed"`,
   `failedSince` (kept from the first failure) and the error; a property
   with no `icalUrl` gets `status: "no-feed"` and no events. The run's
   `failed` list names every failure.
4. Writes `availability_snapshots/current`, and `availability_days/<today>`
   if that does not exist.

One run is about 46 small fetches and two writes: under ten seconds.

**Shared code.** The parser, the snapshot builder, the search and the ranking
are pure functions in a new `app/lib/availability/` module, used by the
admin page, the Vercel routes and the function. The Firebase CLI packs only
the `functions/` directory, so a `predeploy` step in `firebase.json` copies
that module in before each deploy; there is one source of truth and a build
step, not two parsers.

**Manual refresh.** `POST /api/admin/availability/refresh` on Vercel, behind
the admin session, runs the same code with `source: "manual"`. It is the
button on the page, and it is the fallback if the schedule ever stops. It
costs one Vercel invocation per press, by an admin, on purpose; the schedule
itself costs Vercel nothing.

**When a feed fails.** The property keeps what was last read, and every
place that shows it says so: on its row, "calendar last read Tue 14:00, 3
reads failed since"; on the page's status line, "2 calendars could not be
read at 15:00: Cottage Vibe City Convenience, CN Tower Boutique Suite". A
failure is never shown as "available" and never as "nothing booked".

**When a run fails.** The document is not written, so `refreshedAt` ages,
and the page and the home tile turn to the alert tone once it is older than
two hours: "Last refreshed 3 h ago; the hourly refresh may have stopped.
Refresh now." That is the whole alerting: monitoring is ruled out, and
Cloud Logging keeps the function's own log for Kian to read in the console.
A run that throws before writing loses nothing.

**How an admin can tell the data is stale.** The status line under the
toolbar on both views reads "Refreshed 23 min ago · hourly · Refresh now",
turns to the alert tone past two hours or when the last run had failures,
and each row carries its own `fetchedAt` when it differs from the run's.
The home tile carries the same age.

**The Airbnb page check (optional, needs a test first).** The refresh could
also, once a day, request each listing page and record only the status
code: today Airbnb answers `410` for the 14 gone listings and `200` for the
32 live ones, from a home connection. Whether it answers the same from a
Google datacenter address is unknown until tried; the audit noted Airbnb's
bot handling is likelier from datacenter addresses. So the check records
`verdict: "unknown"` for anything but a clean 200 or 410, the page shows
"Not on Airbnb" only on a 410, and nothing filters on it by default. If the
first deployed run shows "unknown" across the board, the check is dropped
and the mark is not shown.

**Cost, verified against Google's pricing pages on 2026-09-30:**

| Service | This feature's use | Free allowance | Source |
|---|---|---|---|
| Cloud Functions (2nd gen) invocations | 720 a month, hourly | 2,000,000 a month | firebase.google.com/pricing |
| Cloud Functions compute | about 720 × 10 s × 0.25 GB ≈ 1,800 GB-seconds a month | 400,000 GB-seconds and 200,000 GHz-seconds a month | same |
| Cloud Functions outbound networking | 46 feeds × ~3 KB × 720 ≈ 100 MB a month | 5 GB a month | same |
| Cloud Scheduler | 1 job | 3 jobs a month **per billing account** | cloud.google.com/scheduler/pricing: "Each Google billing account gets 3 jobs per month free … measured at the account level" |
| Artifact Registry (the function's image) | one image, roughly 200 MB; the CLI's cleanup policy deletes old ones | 500 MB | firebase.google.com/pricing |
| Cloud Build (each deploy) | 3 to 5 minutes per deploy | 120 minutes a day; 2,500 a month per billing account | firebase.google.com/pricing; cloud.google.com/build/pricing |
| Firestore | 24 writes and about 1,200 reads a day for the refresh; 1 read per page open | 20,000 writes and 50,000 reads a day | firebase.google.com/pricing |
| Vercel | 1 invocation per manual refresh, 1 per page open; 0 on the schedule | | |

The billing account behind `nubnb-fd02a` (`01AF32-41D3CF-D67F7E`) has **one
project on it**, this one, and the Cloud Scheduler and Cloud Functions APIs
have never been enabled on it, so the three free jobs are all unused. At
this usage every line is inside the free allowance by two orders of
magnitude or more; the feature costs nothing. The one way it could cost is
`minInstances` above 0, which is never set.

**What Kian has to do, since nothing is deployed without him:** enable six
APIs on the project (Cloud Functions, Cloud Build, Artifact Registry, Cloud
Run, Cloud Scheduler, Eventarc; Pub/Sub is already on), then `firebase deploy
--only functions` from the reviewed branch, answering yes when the CLI
offers to set the Artifact Registry cleanup policy. The function writes
Firestore with the project's default service account; no key is stored
anywhere.

### 2.4 The search

**What the admin types**, in the toolbar in the Costs and Properties style,
left to right:

1. **Dates**: `DateRangeField` in a new forward-looking mode (today to today
   + 365, the horizon any feed can speak for; the field today only allows
   past days, so this is a `min`/`max` pair instead of `max` alone). Quick
   ranges down its left: Tonight, This weekend, Next weekend, Next 7 nights,
   Next 30 nights. Its foot says "Check-in to check-out; nights are Toronto
   days".
2. **Guests**: `AdminSelect`, Any or 1 to 12.
3. **City**: `AdminSelect` with counts, as on Properties.
4. **Bedrooms**: `AdminSelect`, Any / Studio / 1 / 2 / 3 / 4+, as on Properties.
5. **Type**: `AdminSelect`, as on Properties.
6. **Up to, a night**: a number field, blank for any.
7. **Search**: the Properties search box, every word against name, area,
   city, type and the offers ("hot tub", "parking", "Yonge").

Every control is mirrored into the URL (`?in=&out=&guests=&city=&beds=
&type=&max=&q=`), so a reload or a shared link keeps the call's question.
Dates are the only thing the search needs; with no dates it lists what fits
the other controls, with a per-property count of open nights in the next
30 instead of the strip.

**What comes back**: one table in the `.table` style, in two groups with a
heading each, then a collapsed third.

- **Fits** (green heading, with the count): every property whose nights are
  all open, that sleeps the party, in the city, with the bedrooms and type
  and price asked. Sorted by nightly price low to high by default; a sort
  control offers Sleeps and Name. Price first because the caller almost
  always has a number in mind.
- **Near misses** (the count, and what "near" means): properties that fail
  at most two of the conditions, and only within a tolerance: dates, free
  if the stay moves by up to three days either way, or at least half the
  nights open; guests, short by at most two; price, at most 25 % over; city,
  any other city; minimum stay, always shown, since it is the admin's own
  number to bend. Sorted by how many conditions missed, then by price. A
  property outside every tolerance is not listed.
- **Blocked for the whole year (13)**, collapsed, so the count is visible and
  nothing is hidden, but the list on the call is not padded with them.

**Why each result fits**: every row carries a chip line. On a fit it reads
"Fits" plus anything worth saying: "minimum 28 nights", "1 night more than
the minimum". On a near miss it names the miss in the caller's terms:
"Vaughan" (not Markham), "sleeps 8" (for a party of 10), "$89 over",
"minimum 31 nights", "free if moved 1 day earlier", "3 of 4 nights open
(booked Nov 4)". The row also shows a **night strip**: one small cell per
requested night, open, booked or blocked, with the date on hover, so the
admin sees at a glance where a stay breaks.

**What a row shows**: the property as on the Properties table (thumb, name,
area and city), Sleeps, Bedrooms, Nightly, Minimum nights, the night strip,
the reason chips, and actions: open on the site, open on Airbnb, edit. The
row shows "4 nights at $200" and not a total; my decision, since the
multiplication is the admin's and the rulings are strict about code and
prices. It is a one-line change if Kian wants the total.

**When nothing matches exactly**, the near-miss group is the answer, and it
is usually not empty. When it is, the empty state says what was asked and
what came closest: "Nothing sleeps 10 on Dec 24 to 28. Closest: Cottage Vibe
City Convenience is free from Dec 23; Panoramic Bright Lakeview Condo from
Dec 23; the largest free on those dates sleeps 8." The status line always
adds the horizon caveat when the dates run past any property's booking
window: "21 properties do not open their calendar that far ahead and are
not listed".

**Worked examples, from the 2026-09-30 snapshot**, with the near-miss rules
above applied:

**6 guests, Markham, Nov 1 – Nov 5 (4 nights)** — fits: 3, near misses shown: 6

| Property | City | Sleeps | Nightly | Min | Why it is here |
|---|---|---|---|---|---|
| 3 Bedroom Home In Ideal Location Near Yonge St | Markham | 6 | $200 | 1 | fits |
| Sunlit House With Southern Charm | Markham | 8 | $299 | 1 | fits |
| Family Home in the Heart of Thornhill | Markham | 6 | $399 | 1 | fits |
| Executive Townhome In Vaughan | Vaughan | 8 | $209 | 1 | Vaughan |
| 4 Bedroom Family Home in Ajax | Ajax | 8 | $300 | 1 | Ajax |
| Unobstructed Lake View Condo | Toronto | 6 | $399 | 1 | Toronto |
| Lake View By Day, City Lights By Night | Toronto | 6 | $399 | 1 | Toronto |
| New Build Cottage By River l Hot Tub | Kawartha Lakes | 6 | $439 | 1 | Kawartha Lakes |
| Cozy 3 Bedroom House Near Yonge and Finch | Toronto | 6 | $500 | 1 | Toronto |

**2 guests, Toronto, Oct 3 – Oct 5 (2 nights), at most $150 a night** — fits: 0, near misses shown: 6

| Property | City | Sleeps | Nightly | Min | Why it is here |
|---|---|---|---|---|---|
| Private Basement Near Yonge St | Toronto | 2 | $89 | 1 | 0 of 2 nights open |
| Spacious Basement Near Yonge St | Toronto | 3 | $99 | 1 | 0 of 2 nights open |
| Cozy 1 Bedroom Basement Suite in Prime Location | Toronto | 3 | $99 | 28 | minimum 28 nights |
| New Build Suite Near Yonge St | Toronto | 3 | $119 | 1 | 0 of 2 nights open |
| CN Tower Boutique Suite | Toronto | 4 | $239 | 1 | $89 over |
| Spacious Studio In Family Home | Toronto | 2 | $89 | 28 | minimum 28 nights, 0 of 2 nights open |

**10 guests, anywhere, Dec 24 – Dec 28 (4 nights)** — fits: 0, near misses shown: 6

| Property | City | Sleeps | Nightly | Min | Why it is here |
|---|---|---|---|---|---|
| Executive Townhome In Vaughan | Vaughan | 8 | $209 | 1 | sleeps 8 |
| Family Friendly Lakeview Cottage | Georgina | 10 | $299 | 31 | minimum 31 nights |
| 4 Bedroom Family Home in Ajax | Ajax | 8 | $300 | 1 | sleeps 8 |
| Cottage Vibe City Convenience | Richmond Hill | 10 | $359 | 1 | free if moved 1 day earlier |
| Panoramic Bright Lakeview Condo | Toronto | 10 | $599 | 1 | free if moved 1 day earlier |
| Private Lakeside Cottage \| Swim Right Into Lake! | Innisfil | 8 | $699 | 2 | sleeps 8 |

The second example is the real finding: for a two-night stay in Toronto
under $150 in early October, the catalogue has nothing; the cheap basements
are booked or monthly-only, and the near misses say exactly that.

### 2.5 The attention list

**The signal** is empty and available: a night in the horizon with no
reservation and no block. A blocked night is the owner's or Airbnb's
decision and is not counted as lost.

**Ranking**: by **empty nights × nightly price** over the horizon, highest
first, as ruled: Private Lakeside Cottage, empty for 30 nights at $699,
outranks Cozy 1 Bedroom Basement Suite, empty for 29 at $99. The horizon is
an `AdminSelect`: next 14, 30, 60 or 90 nights; 30 by default.

**Excluded, and shown as excluded**: a property blocked for the whole
horizon sits in a collapsed "Blocked for the whole period (13)" group at the
bottom with its count visible; a property fully booked for the horizon sits in a collapsed "Fully booked (3)" group. Nothing disappears.

**What a row shows**: rank, the property, Nightly, **Empty nights**, Longest
empty run, Booked, Blocked, **Empty × nightly**, notes, and the same actions
as the search. The notes are where the ranking's blind spots are made
visible on the row itself: "minimum 28 nights" (so 25 empty nights in runs
of 9 are not sellable at the listed minimum; the longest-run column beside
it shows exactly that), "Not on Airbnb" (once the page check exists),
"calendar last read Tue 14:00" when its feed has failed, and, once a week of
daily snapshots exists, "2 bookings added in the last 7 days" or "nothing
booked in 7 days".

**Filters**: City and Type as everywhere, and a toggle "Hide properties whose
Airbnb page is gone", off by default. My decision to show them ranked with
the rest: the feed says their nights are open, Nubnb does not depend on
Airbnb to sell a night, and hiding them would hide the eight properties
that hold more than half of the empty-night value. The mark makes them
recognisable; the toggle makes them removable.

**Worked example, next 30 nights, from the 2026-09-30 snapshot** (the 13
year-blocked left out):

| # | Property | Nightly | Empty nights | Longest run | Booked | Blocked | Empty × nightly | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Private Lakeside Cottage \| Swim Right Into Lake! | $699 | 30 | 30 | 0 | 0 | $20,970 | Airbnb page gone |
| 2 | Family Home in the Heart of Thornhill | $399 | 29 | 29 | 0 | 1 | $11,571 | Airbnb page gone |
| 3 | Cozy 3 Bedroom House Near Yonge and Finch | $500 | 18 | 18 | 0 | 12 | $9,000 |  |
| 4 | 4 Bedroom Family Home in Ajax | $300 | 30 | 30 | 0 | 0 | $9,000 | Airbnb page gone |
| 5 | New Build Cottage By River l Hot Tub | $439 | 19 | 11 | 4 | 7 | $8,341 |  |
| 6 | Cozy Family Basement Suite | $260 | 30 | 30 | 0 | 0 | $7,800 | Airbnb page gone |
| 7 | Sunlit House With Southern Charm | $299 | 23 | 10 | 7 | 0 | $6,877 |  |
| 8 | Charming 3 Bedroom Home In Richmond Hill | $219 | 29 | 29 | 0 | 1 | $6,351 | Airbnb page gone |
| 9 | CN Tower Boutique Suite | $239 | 25 | 9 | 5 | 0 | $5,975 |  |
| 10 | 3 Bedroom Home In Ideal Location Near Yonge St | $200 | 29 | 29 | 0 | 1 | $5,800 | Airbnb page gone |
| 11 | 3 Bedroom 2 Bath Main Floor House | $179 | 30 | 30 | 0 | 0 | $5,370 | minimum 28 nights; Airbnb page gone |
| 12 | Panoramic Bright Lakeview Condo | $599 | 8 | 6 | 22 | 0 | $4,792 |  |

Across the 33 not blocked all year: **$128,291** of empty-night value in the next 30 nights, of which $58,558 is on properties whose Airbnb page is live; 28 have at least one empty night; 3 are fully booked for the 30 (New Build Suite Near Yonge St, Family Friendly Lakeview Cottage, Unbeatable Views from 63rd-Floor Skyscraper); 2 more are blocked for the whole 30 (7000 Sqft Estate l Indoor Pool, Cottage Vibe City Convenience) and sit with the 13 in the collapsed group.

**What the ranking cannot account for**, stated so nobody reads the list as
a verdict:

- Whether the owner wants the nights sold at all. An open calendar on a
  listing that is gone from Airbnb may be a long-term tenancy, a property
  no longer managed, or a property that only Nubnb can now sell; the data
  cannot tell these apart.
- Minimum stays. Half the catalogue is monthly; empty nights in runs shorter
  than the minimum are not sellable as listed, though the admin may bend the
  minimum. The ranking counts every empty night, as ruled; the longest-run
  column and the note show the gap. Ranking on "nights in runs of at least
  the minimum" instead is a one-line change if Kian prefers it.
- Season and day of week. A Kawartha cottage empty in November is not the
  same loss as one empty in July; `priceInfo.weekend` exists on 19 documents
  but is unused on the site and unused here.
- Bookings from other channels that the owner has not blocked on Airbnb.
- Cleaning gaps and advance-notice nights, which count as blocked.
- Whether an empty night was ever asked for, and at what price it would
  sell. Nothing in the data speaks to demand (1.4).
- Nights past a property's booking window, which read as blocked.

### 2.6 The home-page figures

Two tiles added to the four on `DashboardStats`, from one new read
(`GET /api/admin/availability`, the snapshot; the page already holds every
property's name and price). The grid goes from four columns to three, two
rows of three, so the six sit evenly; the four existing tiles do not change.

| Tile | Value | Detail | Tone | Leads to |
|---|---|---|---|---|
| **Empty nights, next 30 days** | the empty × nightly total over properties not blocked for the whole 30 (today: $128,291) | "28 properties with an empty night · 3 fully booked · 15 blocked for the whole month" | none | `/admin/availability?view=attention` |
| **Free this weekend** | how many properties have the coming Friday and Saturday nights open (today: for Oct 2 to 4) | "Refreshed 23 min ago" | alert when the snapshot is older than two hours or the last run had failures, with the reason in the detail | `/admin/availability?view=search&in=<fri>&out=<sun>` |

A failed read shows "Unavailable" with the reason, in the alert tone, never
0, as the four existing tiles do. The dollar figure is a sum over admin-set
nightly prices, of the same kind as the costs totals; it is never a price,
and no renter sees it.

### 2.7 What this tool cannot do

Stated once, so nobody mistakes it for knowing why a property is not
selling:

- It does not know **why** any night is empty. Not the price, not the
  photos, not the reviews, not the season, not the competition.
- It does not know **demand**. Nobody's search is recorded, no inquiry
  carries dates, and Airbnb exports none of its traffic.
- It does not know whether the **owner wants** a night sold, or whether a
  block is the owner, a cleaner, or a setting.
- It does not see **bookings made outside Airbnb** unless the owner blocked
  the dates by hand, and then it sees a block.
- It does not see past a property's **booking window**: 180 days for six
  properties, 244 to 270 for fifteen, 360 to 365 for the rest; and nothing
  at all for the 13 whose calendar is closed for the year.
- It does not know that a listing is **gone from Airbnb** unless the page
  check is built and Airbnb answers it honestly from a Google address.
- It is **up to an hour behind Airbnb**, more if the schedule stops, and it
  says how far behind on every screen.
- It **books nothing, holds nothing, prices nothing**. Nubnb is not a
  booking platform; the answer on the call is still the admin's.

### 2.8 Decisions

**Kian's to make before the build:**

1. Hourly, or every 30 minutes? Both are free; hourly is proposed.
2. Keep a daily snapshot from day one (2.2)? Proposed yes; the only cost is
   under 10 MB a year, and it cannot be recovered later.
3. Show Airbnb-gone properties ranked with the rest, marked (proposed), or
   hidden by default?
4. Build the Airbnb page check (2.3), subject to the datacenter test?
5. A stay total on a search row, or "4 nights at $200" (proposed)?
6. The section's name in the header: "Availability" is proposed.

**Mine, not rulings** (each can be reversed at review): one document rather
than one per property; the `functions/` module with a predeploy copy rather
than a second parser; a manual refresh on Vercel rather than an HTTPS
function; search opens by default; fits sort by price; the near-miss
tolerances in 2.4 (three days, two guests, 25 %); minimum stay as a note,
never a filter; the three-column tile grid; "Not on Airbnb" only on a clean
410.

### 2.9 Build order and what would prove it

Not started. The order, when it is:

1. `app/lib/availability/`: types, the extended parser, the snapshot
   builder, the search, the ranking. Pure, unit-checked against the 46 feeds
   fetched today.
2. `functions/`: the scheduled function and the predeploy copy;
   `firebase.json` gains its `functions` block; `firestore.rules` gains the
   two denied collections; `scripts/export-firestore.mjs` learns the two
   collection names.
3. `GET /api/admin/availability` and `POST /api/admin/availability/refresh`.
4. `/admin/availability` with its two views; `DateRangeField` forward mode;
   the header's fifth section.
5. The two tiles and the three-column grid.

Verification, in raw output, as the rulings require: two consecutive
scheduled runs an hour apart with `refreshedAt` advancing in the document
and the function's log; a forced feed failure on a `__TEST__` property with
a bad URL, showing the old events kept and the row and status line saying
so; the search's answer for three properties compared against a direct
fetch of their feeds on the same minute; the tiles' figures against a hand
count from the export; the `__TEST__` property deleted by ID through the
admin API afterwards.

---

## Appendix. What was run

Read-only, 2026-09-30, from `tmp-audit/availability/` (on disk, git-ignored):

- `fetch-ical.mjs`: fetched the 46 feeds named in the export into a session
  directory; all 46 answered 200 in 767 ms.
- `analyse-ical.mjs`: parsed every event keeping `SUMMARY`, `UID` and
  `DESCRIPTION`; counted the two kinds; computed open, booked and blocked
  nights over 90 and 365 days per property; classified every `Not
  available` span.
- `liveness.mjs`: fetched each `airbnbUrl` and read the title; 14 answered
  410 "404 Page Not Found - Airbnb", 32 answered 200 with the listing's
  title.
- `gen-tables.mjs`: produced the tables in this document from those results.
- The field table in 1.3 came from a one-off read of the export in the
  session; the demand section from `contact_submissions.json` in the same
  export, with names, emails and messages never printed.
- Pricing: firebase.google.com/pricing, cloud.google.com/scheduler/pricing,
  cloud.google.com/build/pricing, read through the browser on 2026-09-30.
  Billing and enabled services: `gcloud billing projects describe
  nubnb-fd02a`, `gcloud services list --enabled --project nubnb-fd02a`.

No document was written, no feed URL was changed, nothing was deployed.

---

## Part 3. What was built (2026-09-30, the same day)

### 3.1 Kian's decisions, on reading Part 2

Hourly. Keep daily snapshots from day one. Show Airbnb-gone properties
ranked and marked. Build the listing-page check, subject to the datacenter
test. Show the stay total on a search row. The section is called
Availability. Two changes to the proposal: rank the attention list by empty
nights in runs of at least the property's minimum stay, the nights it could
actually sell, with the raw empty-night count as a column beside it; and
one plain line at the top of the attention view saying the list shows where
nights are open, not why, and not whether anyone wanted them, with the same
caveat, shorter, under the home-page tile. The decisions of mine in 2.8
stand as proposed. (Recorded in CLAUDE.md.)

### 3.2 The stored document, as built

Reported before the function was written, and unchanged since. One
document, `availability_snapshots/current`, and one per Toronto day,
`availability_days/{yyyy-mm-dd}`, both server-only. From the real feeds on
2026-09-30, one healthy property and one after a failed read:

```
{
  "version": 1,
  "refreshedAt": "2026-09-30T21:00:07.000Z",
  "today": "2026-09-30",
  "horizonEnd": "2027-09-30",
  "run": {
    "source": "schedule", "startedAt": "…", "finishedAt": "…", "durationMs": 7000,
    "fetched": 45,
    "failed": [{ "propertyId": "1VpX0wMpaUkbFwkULD8P", "name": "Corner Penthouse l Tall Ceiling", "error": "HTTP 502" }],
    "pagesChecked": 0
  },
  "properties": {
    "8hmbCMjub5WnpHGCCENC": {
      "name": "Modern Basement Near Yonge & Finch",
      "icalUrl": "https://www.airbnb.ca/calendar/ical/….ics?t=…",
      "status": "ok", "fetchedAt": "2026-09-30T21:00:07.000Z", "bytes": 955, "eventCount": 3,
      "events": [
        { "uid": "1418fb94e984-a197…@airbnb.com", "kind": "reserved", "start": "2026-09-23", "end": "2026-10-28" },
        { "uid": "1418fb94e984-6bde…@airbnb.com", "kind": "reserved", "start": "2026-11-01", "end": "2026-12-31" },
        { "uid": "7f662ec65913-f92c…@airbnb.com", "kind": "blocked",  "start": "2027-06-27", "end": "2027-10-01" }
      ],
      "airbnbPage": { "checkedAt": "…", "status": 200, "verdict": "live" }
    },
    "1VpX0wMpaUkbFwkULD8P": {
      "name": "Corner Penthouse l Tall Ceiling", "icalUrl": "…",
      "status": "failed", "fetchedAt": "2026-09-30T20:31:20.100Z", "bytes": 315, "eventCount": 1,
      "events": [{ "uid": "7f662ec65913-9c84…@airbnb.com", "kind": "blocked", "start": "2026-09-28", "end": "2027-10-01" }],
      "airbnbPage": { "checkedAt": "…", "status": 410, "verdict": "gone" },
      "failedSince": "2026-09-30T21:00:07.000Z", "failures": 1, "error": "HTTP 502"
    },
    "…": "44 more"
  }
}
```

Four things per event and nothing else; no `DESCRIPTION`, so no reservation
URL and no phone digits (checked on every write below). The whole document
is 43 KB for 214 events. Event UIDs never repeat within a property; 16
repeat across properties (co-hosted listings sharing one reservation), so
"booked since" is counted per property.

### 3.3 Files

- `app/lib/availability/`: `types.ts`, `days.ts` (day arithmetic, Toronto
  day, the weekend), `ical.ts` (the parser, moved here from
  `app/lib/api/ical-parser.ts`, which now re-exports it; it keeps `SUMMARY`
  and `UID` and discards `DESCRIPTION`), `snapshot.ts` (the builder and the
  night readers: states, runs, sellable nights, year-blocked, booking
  window), `search.ts`, `attention.ts` (the ranking, the history view, the
  home figures, freshness), `store.ts` (Firestore, given a `Firestore`),
  `refresh.ts` (one run: guarded fetches eight at a time with one retry,
  the page check, build, write), `property.ts` (the app's `Property` to the
  search shape; not copied into the function).
- `functions/`: `src/index.ts`, the scheduled function (`every 60 minutes`,
  `America/Toronto`, `us-central1`, 256 MiB, 120 s, at most one instance,
  never warm); `package.json` (Node 22, firebase-admin 13, firebase-functions
  7), `tsconfig.json`, `package-lock.json`, `.gitignore` (`node_modules`,
  `lib`, `src/lib`). `scripts/functions-sync.mjs` copies the module and
  `app/lib/api/url-guard.ts` into `functions/src/lib/` before every build
  and deploy (`firebase.json` predeploy; `npm run build` in `functions/`).
- Routes: `GET /api/admin/availability` (the current document, the week-old
  reservation view, the Toronto day, the server clock) and
  `POST /api/admin/availability/refresh` (the same run the function does,
  `source: "manual"`, no page check). `app/lib/availability-client.ts`.
- `app/admin/availability/page.tsx` and `page.module.css`: the two views.
- `app/admin/components/DashboardStats.tsx`: two more tiles, given the
  property list by `app/admin/page.tsx`; `page.module.css` grid to three
  columns. `AdminHeader.tsx`: the fifth section. `DateRangeField.tsx` and
  `AdminCalendar.tsx`: `min` (a forward-looking calendar) and `emptyText`.
- `firestore.rules`: the two collections denied. `firebase.json`: the
  functions block. `scripts/export-firestore.mjs`: the two collection
  names. `tsconfig.json` and `eslint.config.mjs`: `functions/` excluded from
  the app's checks (it has its own).

### 3.4 Decisions of mine made while building (not rulings)

- The property name on a row is the link to its public page; the row's
  actions are Airbnb and Edit (Edit opens the property list filtered to it).
  On the attention view the notes sit under the name, not in a column, so
  the twelve columns fit at 1,440 px.
- The attention tab reads "Needs pushing (n)".
- The listing-page check requests the canonical
  `https://www.airbnb.ca/rooms/<id>`, never the stored URL: two stored
  airbnb.com links with tracking parameters answer 200 for listings the
  canonical page answers 410 (3.5). A stored URL that is not an Airbnb room
  is not checked. "Not on Airbnb" shows only on a 404 or 410.
- A property whose calendar is blocked for the whole year is listed under
  its own heading with the reason "blocked for the whole year", never as a
  fit, with or without dates.
- The search row's total is nights × nightly, with the cleaning fee named
  beside it ("4 nights × $200 + $300 cleaning") rather than folded in.
- The stored document keeps the feed URL it read, so a changed URL drops
  the old calendar's events instead of carrying them.
- "Booked in the last 7 days" compares against the oldest daily snapshot of
  the last week and says nothing until one exists.
- The page's clock is the server's, moved on by the time the page has been
  open, so the copy's age never trusts the browser's clock.

### 3.5 Verification (2026-09-30, a dev server on port 4620 reading production, a throwaway admin PIN)

`scripts/export-firestore.mjs` ran first: 9 collections, 64 documents,
`backups/2026-09-30T21-31-05Z`.

Before any refresh, `GET /api/admin/availability` with a session:

```
{"success":true,"data":{"snapshot":null,"history":null,"today":"2026-09-30","now":"2026-09-30T21:32:08.005Z"}}
```

and without one: `HTTP 401`. The page read "No refresh has run yet" with
its own Refresh now.

**Refresh now, pressed on the page**, wrote the document; the API then
said:

```
"refreshedAt": "2026-09-30T21:33:15.226Z", "today": "2026-09-30", "horizonEnd": "2027-09-30",
"run": { "source": "manual", "durationMs": 1812, "fetched": 46, "failed": [], "pagesChecked": 0 },
"properties": 46, "events": 215, "statuses": { "ok": 46 }
phone digits or reservation URLs in the document: false
```

The page read "Refreshed just now · by hand · 46 of 46 calendars read"; the
search with no dates listed 33 fits with "open, next 30" counts and
"Blocked for the whole year (13)" folded; the Markham search (6 guests,
Nov 1 to 5) gave the three fits and fifteen near misses with their reasons
and totals ("$800 · 4 nights × $200 + $300 cleaning"); the attention view
read "Sellable empty nights in the next 30: $115,235 across 19 properties
· every empty night counted: $128,291", 28 ranked, "Fully booked for the
period (3)" and "Blocked for the whole period (15)" folded; the home tiles
read "$115,235 Empty nights, next 30 days · 19 properties with a sellable
stretch · 3 fully booked · 15 blocked for the whole month · Where nights
are open, not why, not whether anyone asked." and "12 Free this weekend ·
Oct 2 – Oct 4, 2026 · of 46 with a calendar · refreshed 1 min ago".

**A forced failure**, through the function's compiled `refresh.js` and
`store.js` with one feed made to fail:

```
  log: refresh done in 1772 ms: 45 feeds read, 1 failed (New Build Cottage By River l Hot Tub), 0 pages checked, day 2026-09-30 already kept
entry: {"status":"failed","fetchedAt":"2026-09-30T21:33:15.226Z","failedSince":"2026-09-30T21:36:08.665Z","failures":1,"error":"Forced failure for verification (2026-09-30)","eventCount":11,"events":11}
```

Its 11 events and its last good `fetchedAt` were kept; the page's status
line turned to the alert tone: "45 of 46 calendars read · 1 calendar could
not be read at Wed 5:36 p.m.: New Build Cottage By River l Hot Tub; showing
what was last read", and the row carried "calendar last read Wed 5:33
p.m.".

**The scheduled function's handler**, run locally with `.run()` on the
compiled `functions/lib/index.js` as deployed code would run it (the
service account as Application Default Credentials in a temp file, removed
after):

```
{"severity":"INFO","message":"refresh (schedule): 46 properties, 46 with a feed, previous 2026-09-30T21:36:08.665Z"}
{"severity":"INFO","message":"refresh done in 4968 ms: 46 feeds read, 0 failed, 46 pages checked, day 2026-09-30 already kept"}
{"refreshedAt":"2026-09-30T21:36:56.611Z","fetched":46,"failed":0,"pagesChecked":46,"dayWritten":false,"severity":"INFO","message":"refreshAvailability finished"}
```

It repaired the forced failure (`"status": "ok"`, 11 events) and ran the
page check, which was due. Its first verdicts were 12 gone and 34 live
against the 14 gone the audit and Part 1 found: the two stored airbnb.com
URLs answered 200. Confirmed by hand: `airbnb.ca/rooms/1303529233212024180`
answers 410 with or without the tracking parameters, `airbnb.com/rooms/…`
answers 200. After the canonical-URL change, the same run through the
rebuilt compiled code:

```
{"run":{"fetched":46,"failed":0,"pagesChecked":46},"verdicts":{"gone (410)":14,"live (200)":32}}
```

The attention view then showed 14 "Not on Airbnb" marks, and with the hide
toggle "22 ranked · 6 hidden".

**The day document**, read back from production: `availability_days` holds
one document, `2026-09-30`, created at 21:33:15.761Z by the first refresh
and never updated since; `current` was created at the same moment and last
updated at 21:40:20.556Z. The first snapshot of the day is the one kept.

Lint and the whole-project type check are clean.

**Not verified, and Kian's to do:** the Cloud Scheduler run itself, and the
page check from a Google address. Both need the deploy: enable Cloud
Functions, Cloud Build, Artifact Registry, Cloud Run, Cloud Scheduler and
Eventarc on `nubnb-fd02a`, then `firebase deploy --only functions` from the
reviewed branch, answering yes to the Artifact Registry cleanup policy. The
first scheduled run's log should read "refresh done … 46 feeds read"; if
its page verdicts come back "unknown" across the board, Airbnb is not
answering Google addresses honestly and the check should be dropped. The
two new collections need no rules deploy to be safe: the catch-all already
denies them; deploying the rules records the denial explicitly.

The document in production now is the one this verification wrote. It is
the feature's own document, not test data, and the next refresh replaces it.
