import * as Cesium from 'cesium';

/**
 * City of Coquitlam property crime — rolling-window incident points.
 *
 * Points from `/api/coquitlam/crime`, coloured by offence type. The server
 * applies the time window (12 months by default); this layer draws what it is
 * given and reports the window in its stats so the number on screen is never
 * mistaken for an all-time total.
 *
 * Older incidents fade. Everything in the window is real, but a break-in from
 * eleven months ago should not read as loudly as one from last week, and a flat
 * palette over a year of data invites exactly that misreading.
 *
 * SENSITIVITY: these are block-level addresses of property crimes, published
 * openly by the City but not accompanied by licence terms. Local viewing only —
 * see server/providers/coquitlamCivic.js for the full note.
 */

const API_URL = '/api/coquitlam/crime';
/** The City appends in batches; the server caches for an hour. */
const REFRESH_MS = 60 * 60 * 1000;

/** Individual incidents stop being meaningful when the whole city is in frame. */
const VISIBLE_M = 20000;

/** Opacity floor, so the oldest incident in the window is still visible. */
const MIN_ALPHA = 0.35;

/**
 * Fade factor for an incident by age, from 1 (today) to MIN_ALPHA (window edge).
 *
 * @param {number|null} reportedAt Epoch ms, as ArcGIS returns dates.
 * @param {number|null} windowMonths Null means no window — everything full strength.
 * @param {number} [now] Injectable for tests.
 * @returns {number}
 */
export function ageAlpha(reportedAt, windowMonths, now = Date.now()) {
  if (!windowMonths || !Number.isFinite(reportedAt)) return 1;
  const spanMs = windowMonths * 30.44 * 24 * 60 * 60 * 1000;
  const age = now - reportedAt;
  if (!(age > 0)) return 1;
  const fresh = 1 - Math.min(1, age / spanMs);
  return MIN_ALPHA + (1 - MIN_ALPHA) * fresh;
}

/**
 * Human label for one incident.
 *
 * @param {object} incident
 * @returns {string}
 */
export function incidentLabel(incident) {
  const when = Number.isFinite(incident?.reportedAt)
    ? new Date(incident.reportedAt).toISOString().slice(0, 10)
    : 'date unknown';
  const where = incident?.address ? ` · ${incident.address}` : '';
  return `${incident?.typeLabel || incident?.type || 'Incident'} · ${when}${where}`;
}

/**
 * Create the Coquitlam property-crime layer.
 *
 * @returns {object} Layer conforming to the host's data-layer contract.
 */
export function createCoquitlamCrimeLayer() {
  let _dataSource = null;
  let _count = 0;
  let _byType = null;
  let _windowMonths = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _loadedAt = 0;

  return {
    id: 'coquitlam-crime',
    name: 'Coquitlam Property Crime',
    icon: '🚓',
    source: 'City of Coquitlam',
    updateInterval: REFRESH_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('coquitlam-crime');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _byType = null;
      _windowMonths = null;
      _lastUpdate = null;
      _lastError = null;
      _loadedAt = 0;
      console.log('[Data:CoquitlamCrime] Initialized');
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      if (_loadedAt && Date.now() - _loadedAt < REFRESH_MS) return true;
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) {
          _lastError = `Crime HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const incidents = Array.isArray(payload?.incidents) ? payload.incidents : [];
        const windowMonths = Number.isFinite(payload?.windowMonths) ? payload.windowMonths : null;

        _dataSource.entities.removeAll();
        const now = Date.now();
        let count = 0;
        for (const incident of incidents) {
          if (!Number.isFinite(incident.lat) || !Number.isFinite(incident.lon)) continue;
          const alpha = ageAlpha(incident.reportedAt, windowMonths, now);
          const color = Cesium.Color.fromCssColorString(incident.color || '#8899aa');
          _dataSource.entities.add({
            id: incident.id,
            name: incident.typeLabel || incident.type,
            description: incidentLabel(incident),
            position: Cesium.Cartesian3.fromDegrees(incident.lon, incident.lat),
            point: {
              pixelSize: 7,
              color: color.withAlpha(alpha),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, VISIBLE_M),
              scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 18000, 0.5),
            },
            properties: {
              layerId: 'coquitlam-crime',
              incidentType: incident.type,
              reportedAt: incident.reportedAt,
              address: incident.address,
            },
          });
          count++;
        }

        _count = count;
        _byType = payload?.byType || null;
        _windowMonths = windowMonths;
        _loadedAt = Date.now();
        _lastUpdate = Date.now();
        // Zero incidents in a window is a legitimate answer, not a failure.
        _lastError = null;
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        console.warn('[Data:CoquitlamCrime] update failed:', _lastError);
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
    },

    getStats() {
      return {
        count: _count,
        windowMonths: _windowMonths,
        byType: _byType,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
}

export default createCoquitlamCrimeLayer();
