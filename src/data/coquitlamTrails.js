import * as Cesium from 'cesium';

/**
 * City of Coquitlam maintained trails.
 *
 * ~3,760 polyline segments from `/api/coquitlam/trails`, coloured by trail class
 * so the paved multi-use network reads differently from a dirt nature trail.
 *
 * Segments are drawn clamped to the ground: the City publishes 2D centrelines
 * with no elevation, so an unclamped line would float or sink through the
 * photorealistic mesh wherever the terrain moves.
 */

const API_URL = '/api/coquitlam/trails';
/** Trail geometry changes on the order of years; the server caches for a day. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Trails are thin. Past this distance they alias into noise, so they are hidden
 * rather than drawn as a grey haze over the whole city.
 */
const VISIBLE_M = 30000;

/**
 * Convert [lon, lat] pairs to a flat degrees array.
 *
 * @param {Array<[number, number]>} coordinates
 * @returns {number[]}
 */
export function flattenTrail(coordinates) {
  const flat = [];
  for (const point of coordinates || []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [lon, lat] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    flat.push(lon, lat);
  }
  return flat;
}

/**
 * Tooltip-ready description of one segment.
 *
 * @param {object} trail
 * @returns {string}
 */
export function trailDescription(trail) {
  const parts = [trail?.trailClass, trail?.surface].filter(Boolean);
  const length = Number(trail?.lengthM);
  if (Number.isFinite(length) && length > 0) parts.push(`${Math.round(length)} m`);
  return parts.join(' · ');
}

/**
 * Create the Coquitlam trails layer.
 *
 * @returns {object} Layer conforming to the host's data-layer contract.
 */
export function createCoquitlamTrailsLayer() {
  let _dataSource = null;
  let _count = 0;
  let _totalKm = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _loadedAt = 0;

  return {
    id: 'coquitlam-trails',
    name: 'Coquitlam Trails',
    icon: '🥾',
    source: 'City of Coquitlam',
    updateInterval: REFRESH_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('coquitlam-trails');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _totalKm = null;
      _lastUpdate = null;
      _lastError = null;
      _loadedAt = 0;
      console.log('[Data:CoquitlamTrails] Initialized');
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      // Static geometry: re-drawing 3,760 polylines on every tick is pure cost.
      if (_loadedAt && Date.now() - _loadedAt < REFRESH_MS) return true;
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) {
          _lastError = `Trails HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const trails = Array.isArray(payload?.trails) ? payload.trails : [];
        if (!trails.length) {
          _lastError = 'No trail segments returned';
          return false;
        }

        _dataSource.entities.removeAll();
        let count = 0;
        for (const trail of trails) {
          const positions = flattenTrail(trail.coordinates);
          if (positions.length < 4) continue;
          const color = Cesium.Color.fromCssColorString(trail.color || '#77bb88');
          _dataSource.entities.add({
            id: trail.id,
            name: trail.name,
            description: trailDescription(trail),
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(positions),
              width: trail.width || 2,
              material: color.withAlpha(0.85),
              clampToGround: true,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, VISIBLE_M),
            },
            properties: {
              layerId: 'coquitlam-trails',
              trailName: trail.name,
              trailClass: trail.trailClass,
              surface: trail.surface,
              lengthM: trail.lengthM,
            },
          });
          count++;
        }

        _count = count;
        _totalKm = Number.isFinite(payload?.totalLengthKm) ? payload.totalLengthKm : null;
        _loadedAt = Date.now();
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        console.warn('[Data:CoquitlamTrails] update failed:', _lastError);
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
        totalKm: _totalKm,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
}

export default createCoquitlamTrailsLayer();
