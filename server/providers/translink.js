/**
 * TransLink transit — static GTFS network, and live vehicles when a key exists.
 *
 * Two endpoints, deliberately split because they have different access rules:
 *
 *   GET /api/translink/network  — routes + stops from the static GTFS zip.
 *                                 KEYLESS. Always available.
 *   GET /api/translink/vehicles — live vehicle positions from GTFS-realtime.
 *                                 Requires TRANSLINK_API_KEY.
 *
 * The static feed is a ~16 MB zip republished every signup period (the current
 * one is valid to 2027-01-03). It is fetched once, sliced to the configured
 * bounding box, and cached for a day: 226k shape points must never reach the
 * browser whole.
 *
 * THE KEYLESS REALTIME FAILURE IS SILENT. gtfsapi.translink.ca answers an
 * unauthenticated request with HTTP 403 and an EMPTY BODY — no message, no JSON
 * error. So /api/translink/vehicles reports `configured: false` explicitly
 * rather than returning an empty vehicle list, because an empty list is
 * indistinguishable from "no buses running" and would read as a working layer
 * with nothing on it. Get a free key at https://developer.translink.ca/.
 *
 * LICENCE: TransLink's GTFS carries no licence field in agency.txt, and the
 * feed is published for developer use via developer.translink.ca. Treat it as
 * fine for local personal use; check TransLink's API terms before redistributing.
 */

import { parseCsv, buildLocalNetwork } from '../../src/data/translinkGtfsParse.js';

const GTFS_STATIC_URL = 'https://gtfs-static.translink.ca/gtfs/google_transit.zip';
const GTFS_REALTIME_POSITIONS = 'https://gtfsapi.translink.ca/v3/gtfsposition';

/**
 * Coquitlam and the Tri-Cities. Deliberately wider than the city boundary so a
 * route does not appear to stop at an invisible line — shapes that enter this
 * box are kept whole.
 */
const DEFAULT_BBOX = Object.freeze({
  minLat: 49.2,
  maxLat: 49.4,
  minLon: -122.95,
  maxLon: -122.65,
});

/** ~11 m at this latitude: invisible at city zoom, and halves the point count. */
const SIMPLIFY_TOLERANCE_DEG = 0.0001;

/** The static feed changes per signup period, not per day. */
const NETWORK_TTL_MS = 24 * 60 * 60 * 1000;
/** Vehicle positions update every ~30 s upstream. */
const VEHICLES_TTL_MS = 20 * 1000;
/** The zip is ~16 MB; allow for growth but refuse anything absurd. */
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const STATIC_FETCH_TIMEOUT_MS = 90 * 1000;
const REALTIME_FETCH_TIMEOUT_MS = 12 * 1000;

let _networkCache = null;
let _networkCachedAt = 0;
let _networkInFlight = null;
let _vehiclesCache = null;
let _vehiclesCachedAt = 0;

/**
 * Read the bbox from the environment, falling back to the Tri-Cities default.
 *
 * @returns {{minLat:number,maxLat:number,minLon:number,maxLon:number}}
 */
function resolveBbox() {
  const raw = process.env.TRANSLINK_BBOX;
  if (!raw) return DEFAULT_BBOX;
  const parts = String(raw)
    .split(',')
    .map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    console.warn('[TransLink] TRANSLINK_BBOX is not "minLat,minLon,maxLat,maxLon"; using default');
    return DEFAULT_BBOX;
  }
  const [minLat, minLon, maxLat, maxLon] = parts;
  return {
    minLat: Math.min(minLat, maxLat),
    maxLat: Math.max(minLat, maxLat),
    minLon: Math.min(minLon, maxLon),
    maxLon: Math.max(minLon, maxLon),
  };
}

/**
 * Fetch with a bounded timeout so a stalled upstream cannot hang the route.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @param {object} [init]
 * @returns {Promise<Response>}
 */
async function fetchBounded(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-local/1.0', ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract named files from a ZIP buffer.
 *
 * Reads the central directory rather than scanning local headers, because a
 * local header may carry sizes of 0 with the real values in a trailing data
 * descriptor — the central directory always has them. Only DEFLATE (method 8)
 * and STORE (method 0) appear in GTFS zips.
 *
 * @param {Buffer} buf
 * @param {string[]} wanted File names to extract.
 * @returns {Promise<Map<string,string>>} name -> UTF-8 contents.
 */
async function extractFromZip(buf, wanted) {
  const zlib = await import('node:zlib');
  const { promisify } = await import('node:util');
  const inflateRaw = promisify(zlib.inflateRaw);

  // End of central directory: signature 0x06054b50, scanned from the tail
  // because it is followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const want = new Set(wanted);
  const out = new Map();

  for (let n = 0; n < entryCount && want.size > 0; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (!want.has(name)) continue;

    // Local header: skip its own variable-length name and extra fields, whose
    // lengths can differ from the central directory's.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const text =
      method === 0 ? raw.toString('utf8') : (await inflateRaw(raw)).toString('utf8');
    out.set(name, text);
    want.delete(name);
  }
  return out;
}

/**
 * Download and slice the static GTFS network. Cached; concurrent callers share
 * one download rather than each pulling 16 MB.
 *
 * @returns {Promise<object>} Network payload.
 */
async function loadNetwork() {
  const now = Date.now();
  if (_networkCache && now - _networkCachedAt < NETWORK_TTL_MS) return _networkCache;
  if (_networkInFlight) return _networkInFlight;

  _networkInFlight = (async () => {
    const response = await fetchBounded(GTFS_STATIC_URL, STATIC_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`GTFS static HTTP ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) throw new Error(`GTFS zip too large: ${buf.length} bytes`);

    const files = await extractFromZip(buf, [
      'routes.txt',
      'trips.txt',
      'shapes.txt',
      'stops.txt',
      'feed_info.txt',
    ]);
    for (const needed of ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt']) {
      if (!files.has(needed)) throw new Error(`GTFS zip missing ${needed}`);
    }

    const bbox = resolveBbox();
    const network = buildLocalNetwork(
      {
        routes: parseCsv(files.get('routes.txt')),
        trips: parseCsv(files.get('trips.txt')),
        shapes: parseCsv(files.get('shapes.txt')),
        stops: parseCsv(files.get('stops.txt')),
      },
      { bbox, toleranceDeg: SIMPLIFY_TOLERANCE_DEG },
    );

    const feedInfo = parseCsv(files.get('feed_info.txt') || '')[0] || {};
    const payload = {
      generatedAt: new Date().toISOString(),
      attribution: 'TransLink',
      feedVersion: feedInfo.feed_version || null,
      feedStartDate: feedInfo.feed_start_date || null,
      feedEndDate: feedInfo.feed_end_date || null,
      bbox,
      routes: network.routes,
      stops: network.stops,
    };
    _networkCache = payload;
    _networkCachedAt = Date.now();
    console.log(
      `[TransLink] network: ${payload.routes.length} routes, ${payload.stops.length} stops ` +
        `(feed ${payload.feedVersion || 'unknown'})`,
    );
    return payload;
  })();

  try {
    return await _networkInFlight;
  } finally {
    _networkInFlight = null;
  }
}

/**
 * Minimal protobuf scan for GTFS-realtime vehicle positions.
 *
 * A full protobuf runtime is not worth a dependency for four fields. This walks
 * the wire format and pulls FeedEntity.vehicle.position lat/lon plus the trip's
 * route_id, which is everything the layer draws.
 *
 * Unknown fields are skipped by wire type, so a schema addition upstream is
 * ignored rather than throwing.
 *
 * @param {Buffer} buf
 * @returns {Array<{routeId: string|null, lat: number, lon: number, bearing: number|null, id: string|null}>}
 */
export function parseVehiclePositions(buf) {
  const vehicles = [];

  /** Read a varint, returning [value, nextOffset]. */
  const varint = (b, i) => {
    let result = 0;
    let shift = 0;
    while (i < b.length) {
      const byte = b[i++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, i];
  };

  /** Walk one length-delimited message, invoking onField(fieldNo, wire, buf, start, end). */
  const walk = (b, start, end, onField) => {
    let i = start;
    while (i < end) {
      let key;
      [key, i] = varint(b, i);
      const field = key >>> 3;
      const wire = key & 7;
      if (wire === 0) {
        const next = varint(b, i);
        onField(field, wire, b, i, next[1], next[0]);
        i = next[1];
      } else if (wire === 5) {
        onField(field, wire, b, i, i + 4);
        i += 4;
      } else if (wire === 1) {
        onField(field, wire, b, i, i + 8);
        i += 8;
      } else if (wire === 2) {
        let len;
        [len, i] = varint(b, i);
        onField(field, wire, b, i, i + len);
        i += len;
      } else {
        // Groups (3/4) are not used by GTFS-realtime; stop rather than guess.
        break;
      }
    }
  };

  // FeedMessage.entity = field 2
  walk(buf, 0, buf.length, (field, wire, b, s, e) => {
    if (field !== 2 || wire !== 2) return;
    let id = null;
    let vehicleStart = -1;
    let vehicleEnd = -1;
    // FeedEntity: id = 1, vehicle = 4
    walk(b, s, e, (f2, w2, b2, s2, e2) => {
      if (f2 === 1 && w2 === 2) id = b2.toString('utf8', s2, e2);
      if (f2 === 4 && w2 === 2) {
        vehicleStart = s2;
        vehicleEnd = e2;
      }
    });
    if (vehicleStart < 0) return;

    let routeId = null;
    let lat = null;
    let lon = null;
    let bearing = null;
    // VehiclePosition: trip = 1, position = 2
    walk(b, vehicleStart, vehicleEnd, (f3, w3, b3, s3, e3) => {
      if (f3 === 1 && w3 === 2) {
        // TripDescriptor: route_id = 5
        walk(b3, s3, e3, (f4, w4, b4, s4, e4) => {
          if (f4 === 5 && w4 === 2) routeId = b4.toString('utf8', s4, e4);
        });
      }
      if (f3 === 2 && w3 === 2) {
        // Position: latitude = 1 (float), longitude = 2 (float), bearing = 3 (float)
        walk(b3, s3, e3, (f4, w4, b4, s4) => {
          if (w4 !== 5) return;
          if (f4 === 1) lat = b4.readFloatLE(s4);
          if (f4 === 2) lon = b4.readFloatLE(s4);
          if (f4 === 3) bearing = b4.readFloatLE(s4);
        });
      }
    });

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      vehicles.push({ id, routeId, lat, lon, bearing: Number.isFinite(bearing) ? bearing : null });
    }
  });

  return vehicles;
}

/**
 * Vite plugin: TransLink static network and live vehicle endpoints.
 *
 * @returns {import('vite').Plugin}
 */
export function translinkProxy() {
  return {
    name: 'translink-proxy',
    configureServer(server) {
      server.middlewares.use('/api/translink/network', async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'GET') return send(405, { error: 'Method Not Allowed' });
        try {
          send(200, await loadNetwork());
        } catch (error) {
          const message = String(error?.message || error);
          console.warn('[TransLink] network failed:', message);
          // Serve stale rather than nothing: a day-old transit map is still
          // correct, and the alternative is an empty layer.
          if (_networkCache) return send(200, { ..._networkCache, stale: true, error: message });
          send(502, { error: message, routes: [], stops: [] });
        }
      });

      server.middlewares.use('/api/translink/vehicles', async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'GET') return send(405, { error: 'Method Not Allowed' });

        const apiKey = process.env.TRANSLINK_API_KEY;
        if (!apiKey) {
          // Explicitly NOT an empty 200: see the module header.
          return send(200, {
            configured: false,
            vehicles: [],
            message:
              'TRANSLINK_API_KEY is not set. Get a free key at https://developer.translink.ca/ ' +
              'and add it to .env to enable live vehicle positions.',
          });
        }

        const now = Date.now();
        if (_vehiclesCache && now - _vehiclesCachedAt < VEHICLES_TTL_MS) {
          return send(200, _vehiclesCache);
        }

        try {
          const url = `${GTFS_REALTIME_POSITIONS}?apikey=${encodeURIComponent(apiKey)}`;
          const response = await fetchBounded(url, REALTIME_FETCH_TIMEOUT_MS);
          if (response.status === 403 || response.status === 401) {
            return send(200, {
              configured: true,
              vehicles: [],
              error: `TransLink rejected the API key (HTTP ${response.status})`,
            });
          }
          if (!response.ok) throw new Error(`realtime HTTP ${response.status}`);
          const buf = Buffer.from(await response.arrayBuffer());
          const bbox = resolveBbox();
          const all = parseVehiclePositions(buf);
          const vehicles = all.filter(
            (v) =>
              v.lat >= bbox.minLat &&
              v.lat <= bbox.maxLat &&
              v.lon >= bbox.minLon &&
              v.lon <= bbox.maxLon,
          );
          const payload = {
            configured: true,
            generatedAt: new Date().toISOString(),
            attribution: 'TransLink',
            systemCount: all.length,
            vehicles,
          };
          _vehiclesCache = payload;
          _vehiclesCachedAt = Date.now();
          send(200, payload);
        } catch (error) {
          const message = String(error?.message || error);
          console.warn('[TransLink] vehicles failed:', message);
          send(200, { configured: true, vehicles: [], error: message });
        }
      });
    },
  };
}
