# Coquitlam Town Centre Park — live parking occupancy

A server-side layer joining lot geometry to the City of Coquitlam's live counters.

**Endpoint:** `GET /api/coquitlam-parking` (no key, no config — always on)

```json
{
  "generatedAt": "2026-09-12T20:40:08.296Z",
  "attribution": "City of Coquitlam",
  "occupancyAvailable": true,
  "unmappedWidgets": [],
  "lots": [
    {
      "id": "coquitlam-parking-town-centre-park-parking-lot-c",
      "name": "Town Centre Park — Pinetree Lot C",
      "lat": 49.28967, "lon": -122.78645,
      "stalls": 125, "accessibleStalls": 1,
      "associatedFields": "Percy Perry Stadium",
      "free": 0, "capacity": 118, "occupied": 127,
      "occupancyPct": 100, "status": "Lot Full", "live": true,
      "geometry": { "type": "Polygon", "coordinates": [ ... ] }
    }
  ]
}
```

Six lots, **851 stalls**: Town Centre Park A (186), B (130), C (125), D (115), E (240),
plus Coquitlam Crunch — Lansdowne (55). Each carries a full **polygon footprint**, so lots
can be drawn as real shapes rather than pins.

## Sources

| | |
|---|---|
| **Geometry** | Public ArcGIS Feature Service `Coquitlam_Parking/FeatureServer/0` — keyless, `Query` capability only. Cached 24 h. |
| **Occupancy** | `https://cqapi.coquitlam.ca/parking/parkinglot.js` — the feed behind coquitlam.ca/FindParking, driven by the City's fibre-connected counters. Cached 60 s. |

### The occupancy feed is not an API

It is a **server-rendered jQuery snippet** that assigns numbers into DOM ids:

```js
jQuery("#parkinglot-114-1 .pagestats-number").text("0");
jQuery("#parkinglot-114-1 ... progress").attr("max", "118");
```

so it is parsed with regexes in [`src/data/coquitlamParkingParse.js`](../src/data/coquitlamParkingParse.js).
This is an **undocumented internal endpoint** and can change shape without notice. There is
no JSON variant (`parkinglot.json` returns HTML). It also sends **no `Access-Control-Allow-Origin`**
header, so the browser cannot fetch it directly — hence the server-side proxy.

Parsing is guarded by [`coquitlamParkingParse.test.mjs`](../src/data/coquitlamParkingParse.test.mjs)
(6 tests, in the repo's normal `npm test` run — the runner only discovers tests under `src/`,
which is why the pure logic lives there rather than beside the provider).

## Failure behaviour — verified, not assumed

- **Occupancy feed unreachable or reshaped** → all six lots still return, with geometry and
  stall counts, `free: null`, `live: false`, `occupancyAvailable: false`. Never `0`, which
  would render a full lot as empty. Tested by pointing the module at a dead URL.
- **Over-capacity readings are real.** Lot C regularly reports more occupied than watched
  capacity (127 of 118 = 108%) because counters drift and cars park in aisles. `occupancyPct`
  is clamped to 100 for display; `rawOccupancyPct` keeps the true figure.
- **ArcGIS unreachable** → stale geometry is served (lot shapes do not move).
- **New lot instrumented** → its widget id appears in `unmappedWidgets` and is logged, rather
  than being silently dropped.

## The widget mapping is the fragile part

`WIDGET_TO_LOT` pairs opaque ids (`parkinglot-114-1`) with ArcGIS lot names. It was read from
the City's **rendered DOM**, pairing each `#parkinglot-*` element with its sibling link text —
**not** inferred from capacity similarity, because the two sources disagree by design:

| Lot | ArcGIS `Stalls` | Live `max` |
|---|---|---|
| E | 240 | 236 |
| A | 186 | 184 |
| B | 130 | 148 |
| C | 125 | 118 |
| D | 115 | 108 |

`Stalls` is the striped inventory; `max` is what the counters actually watch. If the City
renumbers its widgets, the symptom is **one lot showing another lot's occupancy** — check
`unmappedWidgets` first, then re-read the pairing from the live page.

## Licence — unresolved, do not redistribute

Unlike the DriveBC (OGL-BC) and Seattle CCTV packs, **neither endpoint publishes explicit
terms**: the Feature Service metadata carries no `copyrightText` or `licenseInfo`, and the
occupancy feed is an internal page dependency. Fine for local personal use; check the City's
open-data terms before redistributing or publishing anything built on it.
