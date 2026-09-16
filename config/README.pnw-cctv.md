# Pacific Northwest CCTV packs

Hand-built source packs, all keyless public feeds.

| File | Cameras | Source | Coverage |
|---|---|---|---|
| **`cctv_sources.pnw.json`** | **1180** | all Vancouver + downtown Seattle | **the default — loads whole** |
| `cctv_sources.vancouver.json` | 234 | DriveBC | BC highways/bridges + full Tri-Cities/Maple Ridge corridor |
| `cctv_sources.vancouver-city.json` | 660 | City of Vancouver | 167 city intersections, 4 directional views each |
| `cctv_sources.seattle-downtown.json` | 286 | Seattle SDOT + WSDOT | within ~4.7 km of the downtown core |
| `cctv_sources.seattle.json` | 629 | Seattle SDOT + WSDOT | greater Seattle out to ~36 km |

**Vancouver-side coverage is never sacrificed to the cap.** `pnw.json` keeps *all* 894
Vancouver cameras and fills the remainder with the nearest Seattle downtown cameras
(286, ~4.7 km), landing at 1180 with 20 spare under the 1200 ceiling. To widen or narrow
Seattle, change only the Seattle slice — the Vancouver packs stay whole.

Swapping in the full 629-camera Seattle pack would total 1,523 and **would** truncate.

### Tri-Cities coverage (verified 2026-09-12)

Every live DriveBC camera in **Coquitlam, Port Coquitlam, Port Moody and Pitt Meadows** is in
the pack. Checked three ways against the served catalog, not just the file: point-in-polygon
against OSM municipal boundaries (21/21), within 6 km of any of the four centres (35/35), and a
name/caption search. **Zero missing.**

Two caveats worth recording:
- **Port Moody genuinely has no DriveBC camera.** It is not a gap in the pack — the province
  operates none inside that boundary (no Hwy 1 frontage; Barnet/IOCO are municipal roads).
- Some cameras *named* for a municipality sit **outside** its boundary (e.g. "Coquitlam" id 684
  and "Brunette" id 683), so a boundary-only test under-reports. Conversely a name-only test
  over-reports: "Hwy 11 at Harris Road" is a **different Harris Road in Abbotsford, 32 km away**.
  Use boundary OR proximity-to-centre, then eyeball the names.

## Run it

```bash
CCTV_SOURCES_FILE=config/cctv_sources.pnw.json CCTV_MAX_SOURCES=1200 npm run dev
```

Or a single city:

```bash
CCTV_SOURCES_FILE=config/cctv_sources.seattle.json npm run dev
```

Add the built-in live packs (Austin / Caltrans / TfL) back alongside it:

```bash
CCTV_SOURCES_FILE=config/cctv_sources.vancouver.json \
CCTV_FORCE_AUSTIN=1 CCTV_MAX_SOURCES=1100 npm run dev
```

Two non-obvious behaviours in `server/providers/local.js`:

- Setting `CCTV_SOURCES_FILE` **suppresses** the built-in live packs. `CCTV_FORCE_AUSTIN=1`
  brings all three back.
- `CCTV_MAX_SOURCES` defaults to 900 and truncates the *merged* list in order, so a later
  pack silently loses cameras. **1200 is a hard ceiling compiled into the code**
  (`Math.min(1200, ...)`), so the full 1,509 PNW cameras cannot all load at once. That is
  why `cctv_sources.pnw.json` is trimmed to 1190 (all of Vancouver, 310 nearest Seattle).
  **Prefer loading one city pack at a time** — a single-city pack loads complete.

Verify: `curl -s localhost:4173/api/cctv/sources | python -c "import json,sys;print(len(json.load(sys.stdin)))"`.
A single frame: `/api/cctv/frame/<id>` — the id is a **path segment**, not `?id=`.

## Sources and licences

**DriveBC** — `https://www.drivebc.ca/api/webcams/?format=json`, keyless, 1,062 cameras
province-wide. Frames at `https://www.drivebc.ca/images/<id>.jpg`.
**Not** `images.drivebc.ca/bchighwaycam/...` — that legacy host is retired and serves an
"Images from this service are no longer available" placeholder with **HTTP 200**.
Licence: Open Government Licence – British Columbia (commercial use permitted, attribution
required — carried in each entry's `license` field).

**City of Vancouver** — `https://trafficcams.vancouver.ca/` is 203 static HTML pages, one per
intersection, each with up to 4 directional JPEGs under `cameraimages/`. There is **no API and
no coordinates on the pages**; positions come from joining the intersection name against the
City's `street-intersections` open dataset (6,125 records). 31 of 202 pages do not match —
those intersections are genuinely absent from the open dataset, not a normalization bug.
Images refresh every ~5 minutes. Licence: Open Government Licence – Vancouver.

**Seattle** — ArcGIS Feature Service `Traffic_Cameras_CDL` owned by
`Transportation_SeattleCityGIS` (find it via the ArcGIS search API; the older
`gisdata.seattle.gov/.../SDOT_Assets/MapServer/9` endpoint returns
`"Service ... not started"`). 660 records, 650 active. Note the layer mixes **SDOT city
cameras** (`www.seattle.gov`, 388) with **WSDOT freeway cameras** (`images.wsdot.wa.gov`,
241). `URL` is stored as `http://` and is rewritten to `https://` here to avoid mixed-content
blocking. Two caveats found while building: `UNITID` is **not unique**, and a few WSDOT frames
are registered at two nearby points — both are deduped on the image filename/URL.

## Pose fields

- **DriveBC** publishes a real compass `orientation`, so all 220 are `poseSource: curated`.
- **City of Vancouver** names each view North/East/South/West, so all 660 are `curated`.
- **Seattle** mostly cannot supply a bearing: SDOT's stream names end in `NS`/`EW`, which is
  the road axis, not a look direction. Only the 40 corner-coded cameras (`NWC`/`NEC`/`SEC`/`SWC`)
  get a heading, marked `derived` rather than `curated` because it is inferred from the mount
  corner. The remaining 589 fall back to the app's own prior.

FOV / pitch / range / mount-height are per-pack defaults (highway mast vs urban intersection),
**not** per-camera measurements. Tune any individual camera with the panel's ADJUST + SAVE CAL.

## Coquitlam / Port Coquitlam / Port Moody / Pitt Meadows / Burnaby

Already covered by `cctv_sources.vancouver.json` — 105 of the 109 DriveBC cameras within 8 km
of those five city centres are in the pack (Pitt Meadows 44/48, Port Coquitlam 22/22,
Burnaby 19/19, Coquitlam 15/15, Port Moody 5/5). None of those municipalities publishes its own
public camera feed, so DriveBC's highway coverage (Hwy 1, 7, 7B Mary Hill Bypass, 17) is the
available source.

## Regenerating

The generator scripts live in the session scratchpad, not in this repo. Cameras are added and
retired upstream, so each pack is a snapshot; re-fetch the source and re-run to refresh.
