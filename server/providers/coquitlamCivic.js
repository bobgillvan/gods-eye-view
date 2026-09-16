/**
 * City of Coquitlam civic layers — maintained trails and property crime.
 *
 *   GET /api/coquitlam/trails — 3,760 trail segments (polylines) with class/surface.
 *   GET /api/coquitlam/crime  — property-crime points, rolling window (default 12 months).
 *
 * Both come from the same keyless public ArcGIS org that already serves the
 * parking lot geometry (services2.arcgis.com/Q6Lq3evZUGfPrN7o), so this module
 * shares its fetch/cache shape with server/providers/coquitlamParking.js.
 *
 * PAGINATION IS MANDATORY, NOT AN OPTIMIZATION. Both services cap a single
 * response (`maxRecordCount` 1000 for trails, 2000 for crime) and truncate
 * WITHOUT an error. A naive single request returns a valid-looking GeoJSON body
 * holding a fraction of the data, which is indistinguishable from a quiet city.
 *
 * Worse, the documented truncation flag does not appear: a capped response omits
 * `exceededTransferLimit` entirely (verified 2026-09-16). Paging here is driven
 * by page size instead — see fetchAllFeatures.
 *
 * CRIME IS WINDOWED BY DEFAULT. The service holds 2021-2026 (~6,200 incidents,
 * ~1,000/year). Drawing all of it mixes five-year-old incidents with last month's
 * at identical visual weight. The default window is 12 months; override with
 * COQUITLAM_CRIME_MONTHS, or 0 for everything.
 *
 * LICENCE AND SENSITIVITY — read before doing anything beyond local viewing.
 * The ArcGIS layer metadata returns an EMPTY `copyrightText`, so neither dataset
 * publishes explicit terms. The crime layer is additionally address-level
 * incident data about private residences: the City publishes it openly, but
 * plotting it on a globe is a different use than a municipal dashboard. Local
 * personal use only. Do not redistribute, publish, or push to a public fork
 * without checking the City's open-data terms first.
 */

const ARCGIS_BASE =
  'https://services2.arcgis.com/Q6Lq3evZUGfPrN7o/arcgis/rest/services';

const TRAILS_LAYER = `${ARCGIS_BASE}/Parks_and_Maintained_Trails/FeatureServer/0/query`;
const CRIME_LAYER = `${ARCGIS_BASE}/Property_Crime_Data_Layer_Coquitlam/FeatureServer/0/query`;

/** Each layer's `maxRecordCount`, read from its service metadata (2026-09-16). */
const TRAILS_PAGE_SIZE = 1000;
const CRIME_PAGE_SIZE = 2000;

/** Trail geometry changes on the order of years. */
const TRAILS_TTL_MS = 24 * 60 * 60 * 1000;
/** Crime data is appended in batches, not continuously; an hour is generous. */
const CRIME_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
/** Refuse to page forever if a service keeps returning full pages. */
const MAX_PAGES = 40;

const DEFAULT_CRIME_MONTHS = 12;

let _trailsCache = null;
let _trailsCachedAt = 0;
let _crimeCache = null;
let _crimeCachedAt = 0;

/**
 * Styling by trail class, covering the ten the City actually publishes.
 *
 * The first eight were read from a 1,000-record sample; `Mountain Bike Trail`
 * (33 segments) and `Entry Plaza` (4) appear only once the full 6,494-segment
 * set is paged in, which is a decent illustration of why the truncated fetch
 * was worth fixing. Two segments carry no class at all and fall through to the
 * default — a fallback, not a gap to chase.
 */
export const TRAIL_CLASS_STYLE = Object.freeze({
  'Urban Multi-Use Trail': { css: '#00d4a0', width: 3 },
  'Park Pathway': { css: '#66dd88', width: 2 },
  'Urban Nature Trail': { css: '#88aa55', width: 2 },
  'Nature Trail': { css: '#aa8844', width: 2 },
  'Mountain Bike Trail': { css: '#ff6644', width: 2 },
  'Park Connector': { css: '#55bbaa', width: 2 },
  'Entry Plaza': { css: '#ccddaa', width: 2 },
  Boardwalk: { css: '#ddaa66', width: 3 },
  Bridge: { css: '#ffcc44', width: 3 },
  Stairs: { css: '#ff8866', width: 2 },
});

const TRAIL_DEFAULT_STYLE = Object.freeze({ css: '#77bb88', width: 2 });

/**
 * Style for a trail class, falling back for any class added later.
 *
 * @param {string} trailClass
 * @returns {{css: string, width: number}}
 */
export function trailStyle(trailClass) {
  return TRAIL_CLASS_STYLE[trailClass] || TRAIL_DEFAULT_STYLE;
}

/**
 * Colour by crime type. Auto-related crime dominates (Theft from Auto is ~65%
 * of records), so it gets the least alarming colour and residential break-ins
 * the most: a heatmap where the commonest thing is loudest says nothing.
 */
export const CRIME_TYPE_STYLE = Object.freeze({
  'Break & Enter - Residence': { css: '#ff3355', label: 'B&E residence' },
  'Break & Enter - Business': { css: '#ff8a00', label: 'B&E business' },
  'Theft of Auto': { css: '#ffd21e', label: 'Theft of auto' },
  'Theft from Auto': { css: '#59a9ff', label: 'Theft from auto' },
});

const CRIME_DEFAULT_STYLE = Object.freeze({ css: '#8899aa', label: 'Other' });

/**
 * Style for a crime File_Type.
 *
 * @param {string} fileType
 * @returns {{css: string, label: string}}
 */
export function crimeStyle(fileType) {
  return CRIME_TYPE_STYLE[fileType] || CRIME_DEFAULT_STYLE;
}

/**
 * Build the ArcGIS `where` clause for the crime window.
 *
 * ArcGIS rejects epoch-millisecond comparisons on a Date field here; the
 * portable form is a TIMESTAMP literal, which is what this emits.
 *
 * @param {number} months 0 or negative means no window.
 * @param {Date} [now] Injectable for tests.
 * @returns {string}
 */
export function crimeWhereClause(months, now = new Date()) {
  if (!(months > 0)) return '1=1';
  // Work entirely in UTC. setMonth/getMonth are LOCAL-time accessors while
  // toISOString reads UTC, so mixing them shifts the boundary by a day in any
  // negative-offset zone — including this one. The symptom is a window that is
  // silently one day wide of the mark, which no amount of eyeballing catches.
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()),
  );
  const iso = from.toISOString().slice(0, 10);
  return `Reported_Date >= TIMESTAMP '${iso} 00:00:00'`;
}

/**
 * Fetch with a bounded timeout.
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
 * Page an ArcGIS query until a short page proves the end was reached.
 *
 * DO NOT trust `exceededTransferLimit`. Verified against these two services on
 * 2026-09-16: a request returning exactly the 1,000-record cap omits the flag
 * ENTIRELY (`undefined`, not `false`) in the `f=geojson` response. Believing it
 * stops after one page and yields 1,000 of 3,760 trails — a plausible-looking
 * result with two thirds missing and no error anywhere.
 *
 * The signal that actually holds is page size: a full page means "probably
 * more", a short or empty page means done. `pageSize` is passed explicitly
 * rather than inferred from the first response, so a service whose cap changes
 * cannot quietly halve the result set.
 *
 * @param {string} baseUrl Layer query endpoint.
 * @param {Record<string,string>} params Query parameters (without paging).
 * @param {number} pageSize The layer's maxRecordCount.
 * @returns {Promise<object[]>} All GeoJSON features.
 */
async function fetchAllFeatures(baseUrl, params, pageSize) {
  const features = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const search = new URLSearchParams({
      ...params,
      f: 'geojson',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const response = await fetchBounded(`${baseUrl}?${search}`);
    if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) {
      throw new Error(body.error.message || `ArcGIS error ${body.error.code || ''}`.trim());
    }
    const batch = Array.isArray(body?.features) ? body.features : [];
    features.push(...batch);
    if (batch.length < pageSize) return features;
    offset += batch.length;
  }
  console.warn(`[CoquitlamCivic] stopped paging at ${MAX_PAGES} pages (${features.length} features)`);
  return features;
}

/**
 * Load and shape the maintained-trails network.
 *
 * @returns {Promise<object>}
 */
async function loadTrails() {
  const now = Date.now();
  if (_trailsCache && now - _trailsCachedAt < TRAILS_TTL_MS) return _trailsCache;

  const features = await fetchAllFeatures(
    TRAILS_LAYER,
    {
      where: '1=1',
      outFields: 'OBJECTID,TRAIL_NAME,TRAIL_CLASS,GENERAL_TYPE,STATUS,SEGMENT_LENGTH',
      returnGeometry: 'true',
    },
    TRAILS_PAGE_SIZE,
  );

  const trails = [];
  let totalLength = 0;
  for (const f of features) {
    const geom = f?.geometry;
    if (!geom) continue;
    const lines =
      geom.type === 'LineString'
        ? [geom.coordinates]
        : geom.type === 'MultiLineString'
          ? geom.coordinates
          : [];
    const props = f.properties || {};
    const style = trailStyle(props.TRAIL_CLASS);
    for (let i = 0; i < lines.length; i++) {
      const coords = (lines[i] || []).filter(
        (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      );
      if (coords.length < 2) continue;
      trails.push({
        id: `coquitlam-trail-${props.OBJECTID}-${i}`,
        name: props.TRAIL_NAME || 'Unnamed trail',
        trailClass: props.TRAIL_CLASS || 'Unknown',
        surface: props.GENERAL_TYPE || 'Unknown',
        status: props.STATUS || 'Unknown',
        lengthM: Number(props.SEGMENT_LENGTH) || null,
        color: style.css,
        width: style.width,
        coordinates: coords.map(([lon, lat]) => [lon, lat]),
      });
      totalLength += Number(props.SEGMENT_LENGTH) || 0;
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    attribution: 'City of Coquitlam',
    segmentCount: trails.length,
    totalLengthKm: Math.round(totalLength / 100) / 10,
    trails,
  };
  _trailsCache = payload;
  _trailsCachedAt = Date.now();
  console.log(`[CoquitlamCivic] trails: ${trails.length} segments, ${payload.totalLengthKm} km`);
  return payload;
}

/**
 * Load property-crime incidents for the configured window.
 *
 * @returns {Promise<object>}
 */
async function loadCrime() {
  const now = Date.now();
  if (_crimeCache && now - _crimeCachedAt < CRIME_TTL_MS) return _crimeCache;

  const raw = process.env.COQUITLAM_CRIME_MONTHS;
  const months = raw === undefined ? DEFAULT_CRIME_MONTHS : Number(raw);
  const windowMonths = Number.isFinite(months) ? months : DEFAULT_CRIME_MONTHS;

  const features = await fetchAllFeatures(
    CRIME_LAYER,
    {
      where: crimeWhereClause(windowMonths),
      outFields: 'FID,Year,Reported_Date,File_Type,Address,Municipality',
      returnGeometry: 'true',
    },
    CRIME_PAGE_SIZE,
  );

  const incidents = [];
  const byType = {};
  for (const f of features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      continue;
    }
    const props = f.properties || {};
    const style = crimeStyle(props.File_Type);
    byType[props.File_Type] = (byType[props.File_Type] || 0) + 1;
    incidents.push({
      id: `coquitlam-crime-${props.FID}`,
      type: props.File_Type || 'Unknown',
      typeLabel: style.label,
      color: style.css,
      // The City publishes a block-level address, not a unit. Kept as given.
      address: props.Address || '',
      reportedAt: props.Reported_Date || null,
      year: props.Year || null,
      lon: coords[0],
      lat: coords[1],
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    attribution: 'City of Coquitlam',
    windowMonths: windowMonths > 0 ? windowMonths : null,
    count: incidents.length,
    byType,
    incidents,
  };
  _crimeCache = payload;
  _crimeCachedAt = Date.now();
  console.log(
    `[CoquitlamCivic] crime: ${incidents.length} incidents ` +
      `(${windowMonths > 0 ? `last ${windowMonths} months` : 'all years'})`,
  );
  return payload;
}

/**
 * Vite plugin: City of Coquitlam trails and property-crime endpoints.
 *
 * @returns {import('vite').Plugin}
 */
export function coquitlamCivicProxy() {
  return {
    name: 'coquitlam-civic-proxy',
    configureServer(server) {
      const route = (path, load, emptyShape) => {
        server.middlewares.use(path, async (req, res) => {
          const send = (code, body) => {
            res.writeHead(code, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'GET') return send(405, { error: 'Method Not Allowed' });
          try {
            send(200, await load());
          } catch (error) {
            const message = String(error?.message || error);
            console.warn(`[CoquitlamCivic] ${path} failed:`, message);
            send(502, { error: message, ...emptyShape });
          }
        });
      };
      route('/api/coquitlam/trails', loadTrails, { trails: [] });
      route('/api/coquitlam/crime', loadCrime, { incidents: [] });
    },
  };
}
