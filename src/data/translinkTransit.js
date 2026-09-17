import * as Cesium from 'cesium';
import {
  resolvePickId,
  registerPickOwner,
  unregisterPickOwner,
  isOwnedByOtherLayer,
} from './pickRegistry.js';
import {
  showVehicleCard,
  hideVehicleCard,
  destroyVehicleCard,
} from './translinkVehicleCard.js';
import { registerSpriteCollection, unregisterSpriteCollection } from './spriteOrder.js';

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
 *
 * STOPS AND VEHICLES ARE PRIMITIVES, NOT ENTITIES. 1,710 stop Entities cost
 * roughly 96 % of this layer's scene objects and visibly drop the frame rate
 * when the layer is on — each Entity carries its own property bag and is
 * re-evaluated per frame. A PointPrimitiveCollection batches them into one GPU
 * draw, which is how flights (5,000+ aircraft), bikeshare and CCTV already
 * render their dense point sets. Routes stay Entities: there are only 74, and
 * polylines want the entity layer's `clampToGround` handling.
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
 * Human summary of one vehicle, as shown on the click card and copied to the
 * clipboard. Every field is optional: TransLink omits bearing entirely, and a
 * vehicle on a route outside the static slice has no resolved name.
 *
 * @param {object} vehicle Vehicle record from /api/translink/vehicles.
 * @returns {Array<[string, string]>} Label/value pairs, skipping absent data.
 */
export function vehicleDetailRows(vehicle) {
  const rows = [];
  if (vehicle?.routeLabel) rows.push(['Route', vehicle.routeLabel]);
  else if (vehicle?.routeId) rows.push(['Route id', String(vehicle.routeId)]);
  if (vehicle?.vehicleLabel) rows.push(['Vehicle', `#${vehicle.vehicleLabel}`]);
  if (vehicle?.stopName) rows.push(['Next stop', vehicle.stopName]);
  else if (vehicle?.stopId) rows.push(['Next stop id', String(vehicle.stopId)]);
  if (Number.isFinite(vehicle?.stopSequence)) rows.push(['Stop #', String(vehicle.stopSequence)]);
  if (Number.isFinite(vehicle?.lat) && Number.isFinite(vehicle?.lon)) {
    rows.push(['Position', `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`]);
  }
  if (Number.isFinite(vehicle?.timestamp)) {
    const age = Math.max(0, Math.round((Date.now() - vehicle.timestamp) / 1000));
    rows.push(['Reported', age < 90 ? `${age}s ago` : new Date(vehicle.timestamp).toLocaleTimeString()]);
  }
  if (vehicle?.tripId) rows.push(['Trip', String(vehicle.tripId)]);
  return rows;
}

/**
 * One-line plain-text form of a vehicle, for sharing.
 *
 * @param {object} vehicle
 * @returns {string}
 */
export function vehicleShareText(vehicle) {
  const rows = vehicleDetailRows(vehicle);
  const head = vehicle?.routeLabel || `Route ${vehicle?.routeId || '?'}`;
  const body = rows
    .filter(([label]) => label !== 'Route')
    .map(([label, value]) => `${label}: ${value}`)
    .join(' | ');
  return `TransLink ${head}${body ? ` — ${body}` : ''}`;
}

/**
 * Create the TransLink transit layer.
 *
 * @returns {object} Layer conforming to the host's data-layer contract.
 */
export function createTranslinkTransitLayer() {
  let _dataSource = null;
  let _stopPoints = null;
  let _vehiclePoints = null;
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
  /** entity id -> the vehicle record behind it, for click inspection. */
  const _vehicleRecords = new Map();
  let _clickHandler = null;
  let _selectedId = null;

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

    _stopPoints.removeAll();
    const stationColor = Cesium.Color.fromCssColorString('#00e0ff');
    const stopColor = Cesium.Color.fromCssColorString('#33cc77').withAlpha(0.7);
    const outline = Cesium.Color.BLACK.withAlpha(0.6);
    for (const stop of stops) {
      const isStation = Boolean(stop.isStation);
      _stopPoints.add({
        id: stop.id,
        position: Cesium.Cartesian3.fromDegrees(stop.lon, stop.lat),
        pixelSize: isStation ? 8 : 4,
        color: isStation ? stationColor : stopColor,
        outlineColor: outline,
        outlineWidth: 1,
        // A primitive has no heightReference; clamping 1,710 points to terrain
        // is exactly the per-frame work this change exists to avoid. They sit
        // at ellipsoid height, which at stop scale is imperceptible.
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          isStation ? STATION_VISIBLE_M : STOP_VISIBLE_M,
        ),
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
      _vehiclePoints.removeAll();
      return;
    }
    _keyed = true;
    const vehicles = Array.isArray(payload?.vehicles) ? payload.vehicles : [];
    _vehiclePoints.removeAll();
    _vehicleRecords.clear();
    for (const vehicle of vehicles) {
      if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)) continue;
      const color = _routeColors.get(vehicle.routeId) || Cesium.Color.WHITE;
      const entityId = `translink-vehicle-${vehicle.id || `${vehicle.lat},${vehicle.lon}`}`;
      _vehicleRecords.set(entityId, vehicle);
      // A vehicle must not look like a stop. Stops are 4-8 px and dim; a
      // vehicle is larger, ringed in white and drawn at full brightness, so
      // the moving things read as moving things at a glance. It also has no
      // distanceDisplayCondition, unlike stops — a bus should still be visible
      // when zoomed out past where its stop has been hidden.
      _vehiclePoints.add({
        id: entityId,
        position: Cesium.Cartesian3.fromDegrees(vehicle.lon, vehicle.lat),
        pixelSize: 16,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    _vehicleCount = vehicles.length;

    // The open card must follow its bus. Re-render it from the new record, or
    // close it when that vehicle has left the feed — a card frozen on a stale
    // position is worse than no card.
    if (_selectedId) {
      const fresh = _vehicleRecords.get(_selectedId);
      if (!fresh) {
        _selectedId = null;
        hideVehicleCard();
      }
    }
  }

  return {
    id: 'translink-transit',
    name: 'TransLink Transit',
    icon: '🚈',
    source: 'TransLink GTFS',
    updateInterval: REFRESH_MS,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('translink-transit');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);

      // Dense point sets go through primitive collections — see the header.
      _stopPoints = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      _vehiclePoints = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      _stopPoints.show = false;
      _vehiclePoints.show = false;
      viewer.scene.primitives.add(_stopPoints);
      viewer.scene.primitives.add(_vehiclePoints);
      registerSpriteCollection('translink-stops', _stopPoints);
      registerSpriteCollection('translink-transit', _vehiclePoints);

      // Claim our own entity ids so a sibling layer's click handler leaves
      // them alone, and vice versa — every layer here picks from one scene.
      registerPickOwner('translink-transit', (id) => String(id).startsWith('translink-vehicle-'));

      if (typeof Cesium.ScreenSpaceEventHandler === 'function' && viewer.scene?.canvas) {
        _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        _clickHandler.setInputAction((click) => {
          const picked = viewer.scene.pick(click.position);
          const pickedId = resolvePickId(picked);
          // Another layer owns this pick; do not compete for it.
          if (pickedId && isOwnedByOtherLayer('translink-transit', pickedId)) return;
          const record = pickedId ? _vehicleRecords.get(pickedId) : null;
          if (record) {
            _selectedId = pickedId;
            showVehicleCard({
              rows: vehicleDetailRows(record),
              shareText: vehicleShareText(record),
              accent: record.color || '#00e0ff',
              at: { x: click.position?.x ?? 0, y: click.position?.y ?? 0 },
              onClose: () => {
                _selectedId = null;
              },
            });
          } else if (_selectedId) {
            // A click on empty space dismisses, matching every sibling layer.
            _selectedId = null;
            hideVehicleCard();
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
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
      if (_stopPoints) _stopPoints.show = true;
      if (_vehiclePoints) _vehiclePoints.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
      if (_stopPoints) _stopPoints.show = false;
      if (_vehiclePoints) _vehiclePoints.show = false;
      // A card left open over a hidden layer points at nothing.
      _selectedId = null;
      hideVehicleCard();
    },

    async update() {
      if (!_dataSource || !_stopPoints || !_vehiclePoints) return false;
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
      _clickHandler?.destroy?.();
      _clickHandler = null;
      unregisterPickOwner('translink-transit');
      destroyVehicleCard();
      _vehicleRecords.clear();
      _selectedId = null;
      unregisterSpriteCollection('translink-stops', _stopPoints);
      unregisterSpriteCollection('translink-transit', _vehiclePoints);
      for (const collection of [_stopPoints, _vehiclePoints]) {
        if (!collection) continue;
        try {
          viewer?.scene?.primitives?.remove(collection);
        } catch {
          /* viewer already torn down */
        }
      }
      try {
        if (_dataSource) viewer?.dataSources?.remove(_dataSource, true);
      } catch {
        /* viewer already torn down */
      }
      _dataSource = null;
      _stopPoints = null;
      _vehiclePoints = null;
    },

    getStats() {
      return {
        // The toggle panel renders `count`. Reporting the ROUTE count on a
        // layer whose point is live vehicles made a working feed look frozen:
        // the number never moved. Prefer the vehicle count whenever the feed
        // is keyed, and fall back to routes only when it is not.
        count: _vehicleCount == null ? _routeCount : _vehicleCount,
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
