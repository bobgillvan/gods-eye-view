import * as Cesium from 'cesium';

/**
 * TransLink transit — route lines, stations, and live vehicles.
 *
 * Draws the Coquitlam slice of the regional network from `/api/translink/network`
 * (static GTFS, keyless) and overlays live vehicle positions from
 * `/api/translink/vehicles` when a TRANSLINK_API_KEY is configured.
 *
 * The static network is the layer. Vehicles are an ENHANCEMENT: without a key
 * the routes, stations and stops all still draw, and the layer reports itself as
 * working rather than broken — see the `keyed` flag in getStats().
 *
 * Bus stops are drawn only when zoomed in. There are 1,710 of them in the
 * bounding box, and at city zoom they merge into a solid band that hides the
 * routes underneath.
 */

const NETWORK_URL = '/api/translink/network';
const VEHICLES_URL = '/api/translink/vehicles';

/** Vehicles move; the server caches at 20 s, so poll a little slower than that. */
const REFRESH_MS = 30 * 1000;
/** The static network is refetched rarely — the server caches it for a day. */
const NETWORK_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Beyond this many metres, individual bus stops stop being useful. */
const STOP_VISIBLE_M = 4000;
/** Stations stay legible further out than poles do. */
const STATION_VISIBLE_M = 25000;

/**
 * Convert [lon, lat] pairs into a flat degrees array for Cesium.
 *
 * @param {Array<[number, number]>} coordinates
 * @returns {number[]}
 */
export function flattenCoordinates(coordinates) {
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
 * Label for a route: its number when it has one, else its name.
 *
 * SkyTrain routes carry an empty `route_short_name` and a real long name, while
 * buses carry both — so preferring the short name alone would label every train
 * with an empty string.
 *
 * @param {object} route
 * @returns {string}
 */
export function routeLabel(route) {
  const short = String(route?.shortName || '').trim();
  const long = String(route?.longName || '').trim();
  if (short && long) return `${short} ${long}`;
  return long || short || 'Route';
}

/**
 * Create the TransLink transit layer.
 *
 * @returns {object} Layer conforming to the host's data-layer contract.
 */
export function createTranslinkTransitLayer() {
  let _dataSource = null;
  let _vehicleSource = null;
  let _networkLoadedAt = 0;
  let _routeCount = 0;
  let _stopCount = 0;
  let _vehicleCount = null;
  let _keyed = false;
  let _feedVersion = null;
  let _lastUpdate = null;
  let _lastError = null;
  /** routeId -> colour, so a vehicle can be painted like the line it runs on. */
  const _routeColors = new Map();

  /**
   * Draw the static network once per network refresh.
   *
   * @returns {Promise<boolean>} True when the network is present.
   */
  async function loadNetwork() {
    const response = await fetch(NETWORK_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Network HTTP ${response.status}`);
    const payload = await response.json();
    const routes = Array.isArray(payload?.routes) ? payload.routes : [];
    const stops = Array.isArray(payload?.stops) ? payload.stops : [];
    if (!routes.length && !stops.length) throw new Error('Empty transit network');

    _dataSource.entities.removeAll();
    _routeColors.clear();

    for (const route of routes) {
      const positions = flattenCoordinates(route.coordinates);
      if (positions.length < 4) continue;
      const color = Cesium.Color.fromCssColorString(route.color || '#33cc77');
      _routeColors.set(route.routeId, color);
      _dataSource.entities.add({
        id: route.id,
        name: routeLabel(route),
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(positions),
          width: route.width || 2,
          material: color.withAlpha(route.routeType === 3 ? 0.55 : 0.9),
          // Drape onto terrain so a line does not tunnel through a hillside.
          clampToGround: true,
        },
        properties: {
          layerId: 'translink-transit',
          routeId: route.routeId,
          kind: route.kind,
          routeName: routeLabel(route),
        },
      });
    }

    for (const stop of stops) {
      const isStation = Boolean(stop.isStation);
      _dataSource.entities.add({
        id: stop.id,
        position: Cesium.Cartesian3.fromDegrees(stop.lon, stop.lat),
        point: {
          pixelSize: isStation ? 8 : 4,
          color: isStation
            ? Cesium.Color.fromCssColorString('#00e0ff')
            : Cesium.Color.fromCssColorString('#33cc77').withAlpha(0.7),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            isStation ? STATION_VISIBLE_M : STOP_VISIBLE_M,
          ),
        },
        properties: {
          layerId: 'translink-transit',
          stopName: stop.name,
          isStation,
        },
      });
    }

    _routeCount = routes.length;
    _stopCount = stops.length;
    _feedVersion = payload?.feedVersion || null;
    _networkLoadedAt = Date.now();
    return true;
  }

  /**
   * Refresh live vehicle positions, if the server has a key.
   *
   * @returns {Promise<void>}
   */
  async function loadVehicles() {
    const response = await fetch(VEHICLES_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Vehicles HTTP ${response.status}`);
    const payload = await response.json();

    if (payload?.configured === false) {
      // Not an error: the layer works without a key, it just has no vehicles.
      _keyed = false;
      _vehicleCount = null;
      _vehicleSource.entities.removeAll();
      return;
    }
    _keyed = true;
    const vehicles = Array.isArray(payload?.vehicles) ? payload.vehicles : [];
    _vehicleSource.entities.removeAll();
    for (const vehicle of vehicles) {
      if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) continue;
      const color = _routeColors.get(vehicle.routeId) || Cesium.Color.WHITE;
      _vehicleSource.entities.add({
        id: `translink-vehicle-${vehicle.id || `${vehicle.lat},${vehicle.lon}`}`,
        position: Cesium.Cartesian3.fromDegrees(vehicle.lon, vehicle.lat),
        point: {
          pixelSize: 10,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          layerId: 'translink-transit',
          routeId: vehicle.routeId,
          bearing: vehicle.bearing,
        },
      });
    }
    _vehicleCount = vehicles.length;
  }

  return {
    id: 'translink-transit',
    name: 'TransLink Transit',
    icon: '🚈',
    source: 'TransLink GTFS',
    updateInterval: REFRESH_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('translink-transit');
      _vehicleSource = new Cesium.CustomDataSource('translink-vehicles');
      _dataSource.show = false;
      _vehicleSource.show = false;
      viewer.dataSources.add(_dataSource);
      viewer.dataSources.add(_vehicleSource);
      _networkLoadedAt = 0;
      _routeCount = 0;
      _stopCount = 0;
      _vehicleCount = null;
      _keyed = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:TransLink] Initialized');
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
      if (_vehicleSource) _vehicleSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
      if (_vehicleSource) _vehicleSource.show = false;
    },

    async update() {
      if (!_dataSource) return false;
      try {
        const needsNetwork =
          !_networkLoadedAt || Date.now() - _networkLoadedAt > NETWORK_REFRESH_MS;
        if (needsNetwork) await loadNetwork();
        // A vehicle failure must not blank the network that already drew.
        try {
          await loadVehicles();
        } catch (vehicleError) {
          _lastError = `Vehicles: ${String(vehicleError?.message || vehicleError)}`;
          _lastUpdate = Date.now();
          return true;
        }
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        _lastError = String(error?.message || error);
        console.warn('[Data:TransLink] update failed:', _lastError);
        return false;
      }
    },

    destroy(viewer) {
      for (const source of [_dataSource, _vehicleSource]) {
        if (!source) continue;
        try {
          viewer?.dataSources?.remove(source, true);
        } catch {
          /* viewer already torn down */
        }
      }
      _dataSource = null;
      _vehicleSource = null;
    },

    getStats() {
      return {
        count: _routeCount,
        routes: _routeCount,
        stops: _stopCount,
        vehicles: _vehicleCount,
        keyed: _keyed,
        feedVersion: _feedVersion,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
}

export default createTranslinkTransitLayer();
