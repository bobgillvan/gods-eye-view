/**
 * Coquitlam Town Centre Park parking — live occupancy layer.
 *
 * Joins two City of Coquitlam sources:
 *
 *   1. GEOMETRY (static): a public, keyless ArcGIS Feature Service carrying one
 *      polygon per lot plus its stall count.
 *   2. OCCUPANCY (live): the counter feed behind coquitlam.ca/FindParking, driven
 *      by the City's fibre-connected lot counters.
 *
 * The occupancy feed is **not** a JSON API. It is a server-rendered jQuery snippet
 * that assigns numbers into DOM ids, e.g.
 *
 *     jQuery("#parkinglot-114-1 .pagestats-number").text("0");
 *     jQuery("#parkinglot-114-1 ... progress").attr("max", "118");
 *
 * so this module parses it with regexes. That makes it an UNDOCUMENTED INTERNAL
 * ENDPOINT: it can change shape without notice. Every parse failure degrades to
 * "geometry only, occupancy unknown" rather than throwing — a missing number must
 * never blank the layer.
 *
 * It also serves no `Access-Control-Allow-Origin` header, so the browser cannot
 * fetch it directly; this proxy exists partly for that reason.
 *
 * LICENCE: unlike the DriveBC (OGL-BC) and Seattle (city open data) CCTV packs,
 * neither endpoint publishes explicit terms — the Feature Service metadata carries
 * no `copyrightText` or `licenseInfo`, and the occupancy feed is an internal page
 * dependency. Treat this as fine for local personal use and DO NOT redistribute
 * without checking the City's open-data terms first.
 */

import {
  parseOccupancyFeed,
  findUnmappedWidgets,
  WIDGET_TO_LOT,
} from '../../src/data/coquitlamParkingParse.js';

const ARCGIS_LOTS_URL =
  'https://services2.arcgis.com/Q6Lq3evZUGfPrN7o/arcgis/rest/services/' +
  'Coquitlam_Parking/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&returnGeometry=true';

const OCCUPANCY_URL = 'https://cqapi.coquitlam.ca/parking/parkinglot.js';

/** Lot geometry changes on the order of years. */
const GEOMETRY_TTL_MS = 24 * 60 * 60 * 1000;
/** The counters update continuously; 60s is well inside their resolution. */
const OCCUPANCY_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

// WIDGET_TO_LOT lives in src/data/coquitlamParkingParse.js alongside the regexes it
// pairs with, so both are covered by that module's unit tests.

/** Human labels as the City presents them (the ArcGIS names are terser). */
const LOT_DISPLAY_NAMES = {
  'Coquitlam Crunch': 'Coquitlam Crunch — Lansdowne Lot 1',
  'Town Centre Park - Parking Lot A': 'Town Centre Park — Pinetree Lot A',
  'Town Centre Park - Parking Lot C': 'Town Centre Park — Pinetree Lot C',
  'Town Centre Park - Parking Lot D': 'Town Centre Park — Pinetree Lot D',
  'Town Centre Park - Parking Lot E': 'Town Centre Park — Pinetree Lot E',
  'Town Centre Park - Parking Lot B': 'Town Centre Park — Pipeline Lot B',
};

let _geometryCache = null;
let _geometryCachedAt = 0;
let _occupancyCache = null;
let _occupancyCachedAt = 0;

/**
 * Fetch with a bounded timeout so one stalled upstream cannot hang the route.
 *
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchBounded(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-local/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reduce a GeoJSON polygon/multipolygon to a representative interior point.
 *
 * Uses the centroid of the outer ring's vertices. Lot footprints here are convex
 * enough that this lands inside the lot; a true pole-of-inaccessibility would be
 * overkill for six rectangles.
 *
 * @param {object} geometry
 * @returns {{lat: number, lon: number} | null}
 */
function centroidOf(geometry) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === 'Polygon') ring = geometry.coordinates?.[0];
  else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [lon, lat] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    sx += lon;
    sy += lat;
    n += 1;
  }
  if (!n) return null;
  return { lat: sy / n, lon: sx / n };
}

/**
 * Load lot polygons and stall counts from the ArcGIS Feature Service.
 *
 * @returns {Promise<Array<object>>} One record per lot; [] on failure.
 */
async function loadGeometry() {
  const now = Date.now();
  if (_geometryCache && now - _geometryCachedAt <= GEOMETRY_TTL_MS) return _geometryCache;

  try {
    const resp = await fetchBounded(ARCGIS_LOTS_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const lots = [];
    for (const feature of body?.features || []) {
      const props = feature?.properties || {};
      const name = String(props.Lot_Name || '').trim();
      if (!name) continue;
      const centre = centroidOf(feature.geometry);
      if (!centre) continue;
      lots.push({
        lotName: name,
        displayName: LOT_DISPLAY_NAMES[name] || name,
        stalls: Number.isFinite(props.Stalls) ? props.Stalls : null,
        accessibleStalls: Number.isFinite(props.Accessible_Stalls)
          ? props.Accessible_Stalls
          : null,
        associatedFields: props.Associated_Sports_Fields || null,
        restrictions: props.Lot_Restrictions || null,
        lat: Number(centre.lat.toFixed(6)),
        lon: Number(centre.lon.toFixed(6)),
        geometry: feature.geometry,
      });
    }
    if (lots.length) {
      _geometryCache = lots;
      _geometryCachedAt = now;
    }
    return lots.length ? lots : _geometryCache || [];
  } catch (error) {
    console.warn('[coquitlam-parking] geometry fetch failed:', error?.message || error);
    // Serve stale geometry rather than an empty layer — lot shapes do not move.
    return _geometryCache || [];
  }
}

/**
 * Parse the live counter feed.
 *
 * Extracts, per widget id: the free-space count, the City's status label, and the
 * progress bar's `max` (watched capacity) and `value` (occupied).
 *
 * @returns {Promise<Record<string, object>>} Keyed by widget id; {} on failure.
 */
async function loadOccupancy() {
  const now = Date.now();
  if (_occupancyCache && now - _occupancyCachedAt <= OCCUPANCY_TTL_MS) return _occupancyCache;

  try {
    const resp = await fetchBounded(OCCUPANCY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const js = await resp.text();
    const out = parseOccupancyFeed(js);

    if (Object.keys(out).length) {
      _occupancyCache = out;
      _occupancyCachedAt = now;
      return out;
    }
    // Parsed cleanly but matched nothing — the feed's shape probably changed.
    console.warn('[coquitlam-parking] occupancy feed matched 0 lots; shape may have changed');
    return _occupancyCache || {};
  } catch (error) {
    console.warn('[coquitlam-parking] occupancy fetch failed:', error?.message || error);
    return _occupancyCache || {};
  }
}

/**
 * Build the merged lot list: geometry joined to live occupancy.
 *
 * @returns {Promise<{generatedAt: string, lots: Array<object>, occupancyAvailable: boolean, unmappedWidgets: string[]}>}
 */
export async function getCoquitlamParking() {
  const [geometry, occupancy] = await Promise.all([loadGeometry(), loadOccupancy()]);

  const byLotName = new Map();
  for (const [widgetId, lotName] of Object.entries(WIDGET_TO_LOT)) {
    if (occupancy[widgetId]) byLotName.set(lotName, { widgetId, ...occupancy[widgetId] });
  }

  const lots = geometry.map((lot) => {
    const live = byLotName.get(lot.lotName) || null;
    return {
      id: `coquitlam-parking-${lot.lotName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
      name: lot.displayName,
      lat: lot.lat,
      lon: lot.lon,
      stalls: lot.stalls,
      accessibleStalls: lot.accessibleStalls,
      associatedFields: lot.associatedFields,
      restrictions: lot.restrictions,
      geometry: lot.geometry,
      // Null (not zero) when the live feed is unavailable, so the client can say
      // "unknown" instead of drawing a lot as empty.
      free: live ? live.free : null,
      status: live ? live.status : null,
      capacity: live ? live.capacity : null,
      occupied: live ? live.occupied : null,
      occupancyPct: live ? live.occupancyPct : null,
      live: Boolean(live),
    };
  });

  // Surface a widget the City serves that this module cannot place — the tell that
  // WIDGET_TO_LOT has gone stale, e.g. after a new lot is instrumented.
  const unmappedWidgets = findUnmappedWidgets(occupancy);
  if (unmappedWidgets.length) {
    console.warn(
      `[coquitlam-parking] ${unmappedWidgets.length} unmapped widget id(s): ${unmappedWidgets.join(', ')}`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    attribution: 'City of Coquitlam',
    lots,
    occupancyAvailable: Object.keys(occupancy).length > 0,
    unmappedWidgets,
  };
}

/**
 * Vite dev-server plugin exposing `/api/coquitlam-parking`.
 *
 * @returns {object} Vite plugin.
 */
export function coquitlamParkingProxy() {
  return {
    name: 'coquitlam-parking-proxy',
    configureServer(server) {
      server.middlewares.use('/api/coquitlam-parking', async (_req, res) => {
        try {
          const payload = await getCoquitlamParking();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(payload));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });
    },
  };
}
