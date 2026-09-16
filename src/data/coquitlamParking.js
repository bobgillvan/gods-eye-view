import * as Cesium from 'cesium';

/**
 * Coquitlam Town Centre Park parking — live occupancy polygons.
 *
 * Draws each lot as its real footprint (the City publishes polygons, not points),
 * filled by how full it is right now, with a label carrying the free-space count.
 *
 * Data comes from `/api/coquitlam-parking`, which joins the City's static lot
 * geometry to its live counter feed server-side — see
 * server/providers/coquitlamParking.js for why that join cannot happen in the
 * browser (the occupancy feed sends no CORS header).
 *
 * Occupancy is allowed to be UNKNOWN. When the live feed is unreachable the
 * endpoint still returns geometry with `free: null`, and this layer paints those
 * lots neutral grey labelled "—" rather than green: an unknown lot must never
 * look like an empty one.
 */

const API_URL = '/api/coquitlam-parking';
/** The City's counters update continuously; the server caches at 60 s anyway. */
const REFRESH_MS = 60 * 1000;

/** Fill/outline colour by how full the lot is. */
const OCCUPANCY_COLORS = Object.freeze([
  { maxPct: 50, css: '#22dd66', label: 'open' },       // green  — plenty
  { maxPct: 80, css: '#ffd21e', label: 'filling' },    // amber  — filling
  { maxPct: 95, css: '#ff8a00', label: 'busy' },       // orange — nearly full
  { maxPct: Infinity, css: '#ff2d2d', label: 'full' }, // red    — full
]);
/** Occupancy unknown (live feed down). Deliberately not green. */
const UNKNOWN_COLOR = '#8899aa';

/**
 * Pick the band colour for an occupancy percentage.
 *
 * @param {number|null} pct 0-100, or null when unknown.
 * @returns {{css: string, label: string}}
 */
export function occupancyStyle(pct) {
  if (pct == null || !Number.isFinite(pct)) {
    return { css: UNKNOWN_COLOR, label: 'unknown' };
  }
  for (const band of OCCUPANCY_COLORS) {
    if (pct <= band.maxPct) return { css: band.css, label: band.label };
  }
  return { css: UNKNOWN_COLOR, label: 'unknown' };
}

/**
 * Short label drawn over a lot: free spaces, or an em dash when unknown.
 *
 * @param {object} lot Lot record from the API.
 * @returns {string}
 */
export function lotLabelText(lot) {
  const name = String(lot?.name || 'Parking')
    .replace(/^Town Centre Park\s*[—-]\s*/, '')
    .replace(/^Coquitlam Crunch\s*[—-]\s*/, 'Crunch ');
  if (lot?.free == null) return `${name}\n— · no data`;
  const free = Number(lot.free);
  if (free === 0) return `${name}\nFULL`;
  return `${name}\n${free} free`;
}

/**
 * Convert a GeoJSON Polygon/MultiPolygon into Cesium positions per ring.
 *
 * Returns the outer ring of each polygon; holes are ignored (none of the six
 * lots has one, and a parking island is better drawn than punched out).
 *
 * @param {object} geometry GeoJSON geometry.
 * @returns {Array<Array<Cesium.Cartesian3>>}
 */
export function polygonRings(geometry) {
  if (!geometry) return [];
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const rings = [];
  for (const polygon of polygons) {
    const outer = polygon?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const positions = [];
    for (const point of outer) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [lon, lat] = point;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      positions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
    }
    if (positions.length >= 3) rings.push(positions);
  }
  return rings;
}

/**
 * Create the Coquitlam parking layer.
 *
 * @returns {object} Layer conforming to the host's data-layer contract.
 */
export function createCoquitlamParkingLayer() {
  let _dataSource = null;
  let _count = 0;
  let _freeTotal = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  return {
    id: 'coquitlam-parking',
    name: 'Coquitlam Parking',
    icon: '🅿',
    source: 'City of Coquitlam · LIVE',
    updateInterval: REFRESH_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('coquitlam-parking');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _freeTotal = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:CoquitlamParking] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) {
          _lastError = `Parking HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const lots = Array.isArray(payload?.lots) ? payload.lots : [];
        if (!lots.length) {
          _lastError = 'No lots returned';
          return false;
        }

        _dataSource.entities.removeAll();
        let count = 0;
        let freeTotal = 0;
        let anyLive = false;

        for (const lot of lots) {
          const rings = polygonRings(lot.geometry);
          if (!rings.length) continue;
          const style = occupancyStyle(lot.occupancyPct);
          const color = Cesium.Color.fromCssColorString(style.css);
          if (lot.free != null) {
            freeTotal += Number(lot.free) || 0;
            anyLive = true;
          }

          rings.forEach((positions, ringIndex) => {
            _dataSource.entities.add({
              id: `${lot.id}-ring-${ringIndex}`,
              name: lot.name,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(positions),
                material: color.withAlpha(0.42),
                outline: true,
                outlineColor: color,
                outlineWidth: 2,
                // Drape onto the photoreal mesh rather than floating at
                // ellipsoid height, which would bury or hover the lot.
                classificationType: Cesium.ClassificationType.BOTH,
              },
              properties: {
                layerId: 'coquitlam-parking',
                lotName: lot.name,
                free: lot.free,
                capacity: lot.capacity,
                stalls: lot.stalls,
                occupancyPct: lot.occupancyPct,
                status: lot.status,
                live: lot.live,
              },
            });
          });

          // One label per lot, at the published centroid.
          if (Number.isFinite(lot.lat) && Number.isFinite(lot.lon)) {
            _dataSource.entities.add({
              id: `${lot.id}-label`,
              position: Cesium.Cartesian3.fromDegrees(lot.lon, lot.lat),
              label: {
                text: lotLabelText(lot),
                font: '600 13px monospace',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                // Lots are ~100 m across; hide the text from orbit so the
                // labels do not pile up into a smear at globe zoom.
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000),
                scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 9000, 0.55),
              },
              properties: { layerId: 'coquitlam-parking', lotName: lot.name },
            });
          }
          count++;
        }

        _count = count;
        _freeTotal = anyLive ? freeTotal : null;
        _lastUpdate = Date.now();
        // Geometry without occupancy is a degraded success, not a failure: the
        // lots still draw, so say so rather than reporting a hard error.
        _lastError = payload?.occupancyAvailable === false ? 'Live counts unavailable' : null;
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        console.warn('[Data:CoquitlamParking] update failed:', _lastError);
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        try {
          viewer?.dataSources?.remove(_dataSource, true);
        } catch {
          /* viewer already torn down */
        }
      }
      _dataSource = null;
      _enabled = false;
    },

    getStats() {
      return {
        count: _count,
        freeSpaces: _freeTotal,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
}

export default createCoquitlamParkingLayer();
