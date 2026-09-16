# Local layers — TransLink transit, Coquitlam trails and property crime

Three keyless layers covering the Tri-Cities, plus one optional API key that adds
live transit vehicles.

| Layer | Id | Source | Key needed |
|---|---|---|---|
| TransLink Transit | `translink-transit` | TransLink static GTFS | no (vehicles: yes) |
| Coquitlam Trails | `coquitlam-trails` | City of Coquitlam ArcGIS | no |
| Coquitlam Property Crime | `coquitlam-crime` | City of Coquitlam ArcGIS | no |

They register like every other layer, so `npm run dev` (or `npm run dev:pnw`) is
enough — there is no extra flag. Toggle them in the DATA LAYERS panel.

## What each one actually shows

**TransLink Transit** — 74 routes and 1,710 stops inside the Tri-Cities bounding
box, drawn in TransLink's own route colours from `route_color` (Expo Line
`#0033a0`, Millennium `#ffcd00`). Includes the Millennium Line, Expo Line and the
**West Coast Express**, plus 18 stations. Bus stops only draw within 4 km and
stations within 25 km — 1,710 points at city zoom is a solid band that hides the
routes underneath.

**Coquitlam Trails** — 6,494 segments, **778 km**, coloured by trail class across
all ten the City publishes (paved multi-use, nature trail, boardwalk, stairs,
mountain bike, …). Clamped to the ground, because the City publishes 2D
centrelines with no elevation.

**Coquitlam Property Crime** — property-crime incidents on a **rolling 12-month
window** (800 in the last year), coloured by offence and faded by age. Read the
licence note below before doing anything with this one.

## Getting live transit vehicles

The static network needs no key. Live vehicle positions do:

1. Register at <https://developer.translink.ca/> (free).
2. Put the key in `.env` as `TRANSLINK_API_KEY=...`.
3. Restart the dev server.

`/api/translink/vehicles` reports `configured: false` with that instruction until
the key exists, and the layer keeps working without it — the routes, stations and
stops are all static-feed data.

**A keyless realtime call fails silently.** `gtfsapi.translink.ca` answers an
unauthenticated request with **HTTP 403 and an empty body** — no message, no JSON
error. That is why this endpoint returns an explicit `configured: false` rather
than an empty vehicle list: an empty list is indistinguishable from "no buses are
running right now", which would read as a working layer with nothing on it.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `TRANSLINK_API_KEY` | unset | Enables live vehicle positions. |
| `TRANSLINK_BBOX` | `49.2,-122.95,49.4,-122.65` | `minLat,minLon,maxLat,maxLon`. Widen for more of Metro Vancouver. |
| `COQUITLAM_CRIME_MONTHS` | `12` | Rolling window. `0` loads all years (2021–2026, ~6,200 points). |
| `VITE_STARTUP_LOCATION` | `-122.7932,49.2838` | Where the globe opens, as `lon,lat`. Defaults to Coquitlam; upstream opens on Austin. |

## Two upstream behaviours worth knowing

**ArcGIS truncates without saying so.** Both City services cap a response
(`maxRecordCount` 1000 for trails, 2000 for crime) and **omit
`exceededTransferLimit` entirely** — it comes back `undefined`, not `true`, on a
response that was definitely cut. Trusting that flag yields 1,000 of 3,760 trail
features: a plausible-looking result missing two thirds of the data, with no
error anywhere. Paging here is driven by page size instead — a short page means
the end. This is not theoretical: the first working version of this layer had
eight trail classes because `Mountain Bike Trail` and `Entry Plaza` only appear
after the first 1,000 records.

**Dates need a TIMESTAMP literal.** The crime window uses
`Reported_Date >= TIMESTAMP 'YYYY-MM-DD 00:00:00'`. An epoch-millisecond
comparison is rejected with `Unable to perform query` — a 400, so getting it
wrong empties the layer rather than degrading it.

## Sources and licences — read before redistributing

**TransLink** — static GTFS at `https://gtfs-static.translink.ca/gtfs/google_transit.zip`
(~16 MB, republished per signup period; the current feed is valid to 2027-01-03).
Realtime at `gtfsapi.translink.ca/v3/gtfsposition`, GTFS-realtime protobuf.
`agency.txt` carries **no licence field**, and the feed is published for developer
use via developer.translink.ca. Fine for local personal use; check TransLink's API
terms before redistributing.

**City of Coquitlam** — public ArcGIS Feature Services on
`services2.arcgis.com/Q6Lq3evZUGfPrN7o`, the same org that serves the parking-lot
geometry. Keyless, `Query` capability only.

**Neither City layer publishes explicit terms** — the service metadata returns an
**empty `copyrightText`**, exactly as with the parking layer.

**The crime layer additionally deserves care.** It is address-level incident data
about private residences. The City publishes it openly, but plotting it on a
photorealistic globe is a different use than a municipal dashboard. It is
windowed to 12 months by default rather than showing six years at equal weight.
**Local personal use only — do not publish, redistribute, or push to a public
fork without checking the City's open-data terms first.**
