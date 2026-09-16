/**
 * TransLink static GTFS parsing — pure functions, no I/O.
 *
 * Lives under src/ (not beside the provider) because the repo's unit-test runner
 * only discovers tests under src/, and this is the part worth testing: the CSV
 * quoting rules, the shape-to-route join, and the simplification that keeps a
 * 226k-point shapes.txt from reaching the browser whole.
 *
 * GTFS reference: https://gtfs.org/schedule/reference/
 */

/**
 * GTFS `route_type` values TransLink actually publishes, mapped to how the layer
 * should draw them. Bus is by far the bulk (233 of 239 routes), so rail is styled
 * to stand out rather than the other way round.
 *
 * 715 is a GTFS "extended" route type (demand-and-response), used for HandyDART.
 */
export const ROUTE_TYPE_STYLE = Object.freeze({
  0: { kind: 'tram', css: '#ff8a00', width: 3, priority: 2 },
  1: { kind: 'subway', css: '#00e0ff', width: 5, priority: 0 },
  2: { kind: 'rail', css: '#c58cff', width: 5, priority: 1 },
  3: { kind: 'bus', css: '#33cc77', width: 2, priority: 3 },
  4: { kind: 'ferry', css: '#ffd21e', width: 4, priority: 2 },
  715: { kind: 'demand', css: '#8899aa', width: 2, priority: 4 },
});

/** Anything TransLink adds later still draws, rather than vanishing. */
const UNKNOWN_ROUTE_STYLE = Object.freeze({
  kind: 'other',
  css: '#8899aa',
  width: 2,
  priority: 5,
});

/**
 * Style for a GTFS route_type.
 *
 * @param {string|number} routeType
 * @returns {{kind: string, css: string, width: number, priority: number}}
 */
export function routeTypeStyle(routeType) {
  return ROUTE_TYPE_STYLE[Number(routeType)] || UNKNOWN_ROUTE_STYLE;
}

/**
 * Split one CSV line, honouring RFC4180 double quotes.
 *
 * GTFS fields legitimately contain commas — route_long_name values like
 * "Coquitlam Central Station, Bay 13" and URLs carrying `utm_` query strings
 * both appear in TransLink's feed — so a plain `split(',')` silently shifts every
 * later column. That misalignment is invisible: it yields a parsed row of the
 * right length with the wrong values in it.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Parse a GTFS CSV table into row objects keyed by header name.
 *
 * @param {string} text Raw file contents.
 * @returns {Array<Record<string,string>>}
 */
export function parseCsv(text) {
  if (!text) return [];
  // A UTF-8 BOM would otherwise become part of the first header name, so the
  // first column silently fails every lookup by its documented name.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = splitCsvLine(line);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? '';
    rows.push(row);
  }
  return rows;
}

/**
 * True when a point falls inside a bounding box.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} bbox
 * @returns {boolean}
 */
export function inBbox(lat, lon, bbox) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lon >= bbox.minLon &&
    lon <= bbox.maxLon
  );
}

/**
 * Drop points that barely deviate from the line between their neighbours.
 *
 * Perpendicular distance in degrees, not metres: exact distance is pointless
 * here because the output is drawn clamped to terrain at city scale, and a
 * degree-space threshold avoids a projection dependency for a cosmetic trim.
 *
 * Endpoints are always kept, so a simplified shape still starts and ends where
 * the real one does.
 *
 * @param {Array<[number, number]>} points [lon, lat] pairs.
 * @param {number} toleranceDeg
 * @returns {Array<[number, number]>}
 */
export function simplifyLine(points, toleranceDeg) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  if (!(toleranceDeg > 0)) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    // Twice the triangle area over the base length = perpendicular distance.
    const area = Math.abs((nx - px) * (py - cy) - (px - cx) * (ny - py));
    const base = Math.hypot(nx - px, ny - py);
    const dist = base === 0 ? Math.hypot(cx - px, cy - py) : area / base;
    if (dist >= toleranceDeg) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Build the layer payload from the four GTFS tables it needs.
 *
 * Only shapes that ENTER the bbox are kept, and each is kept WHOLE — a route
 * clipped at the boundary would look like it terminates there, which is worse
 * than a line running a little off-screen.
 *
 * One shape per route is enough to draw the network: TransLink publishes 1,068
 * shapes for 239 routes because every pattern variant gets its own, and drawing
 * all of them stacks near-identical lines on top of each other for no gain.
 * The longest shape per route is kept as the most representative.
 *
 * @param {object} tables
 * @param {Array<Record<string,string>>} tables.routes routes.txt rows.
 * @param {Array<Record<string,string>>} tables.trips trips.txt rows.
 * @param {Array<Record<string,string>>} tables.shapes shapes.txt rows.
 * @param {Array<Record<string,string>>} tables.stops stops.txt rows.
 * @param {object} options
 * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} options.bbox
 * @param {number} [options.toleranceDeg] Simplification tolerance.
 * @returns {{routes: object[], stops: object[]}}
 */
export function buildLocalNetwork({ routes, trips, shapes, stops }, { bbox, toleranceDeg = 0 }) {
  const routeById = new Map();
  for (const r of routes || []) {
    if (r.route_id) routeById.set(r.route_id, r);
  }

  // shape_id -> route_id. First trip wins; a shape belongs to one route.
  const shapeToRoute = new Map();
  for (const t of trips || []) {
    if (t.shape_id && t.route_id && !shapeToRoute.has(t.shape_id)) {
      shapeToRoute.set(t.shape_id, t.route_id);
    }
  }

  // Group shape points, tracking which shapes touch the bbox.
  const pointsByShape = new Map();
  const touching = new Set();
  for (const s of shapes || []) {
    const id = s.shape_id;
    if (!id) continue;
    const lat = Number(s.shape_pt_lat);
    const lon = Number(s.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let list = pointsByShape.get(id);
    if (!list) {
      list = [];
      pointsByShape.set(id, list);
    }
    list.push([lon, lat, Number(s.shape_pt_sequence) || list.length]);
    if (inBbox(lat, lon, bbox)) touching.add(id);
  }

  // Best (longest) touching shape per route.
  const bestByRoute = new Map();
  for (const shapeId of touching) {
    const routeId = shapeToRoute.get(shapeId);
    if (!routeId) continue;
    const pts = pointsByShape.get(shapeId);
    if (!pts || pts.length < 2) continue;
    const prev = bestByRoute.get(routeId);
    if (!prev || pts.length > prev.points.length) {
      bestByRoute.set(routeId, { shapeId, points: pts });
    }
  }

  const outRoutes = [];
  for (const [routeId, { shapeId, points }] of bestByRoute) {
    const meta = routeById.get(routeId) || {};
    const ordered = points.slice().sort((a, b) => a[2] - b[2]);
    const coords = simplifyLine(
      ordered.map(([lon, lat]) => [lon, lat]),
      toleranceDeg,
    );
    if (coords.length < 2) continue;
    const style = routeTypeStyle(meta.route_type);
    outRoutes.push({
      id: `translink-route-${routeId}`,
      routeId,
      shapeId,
      shortName: meta.route_short_name || '',
      longName: meta.route_long_name || '',
      routeType: Number(meta.route_type),
      kind: style.kind,
      // route_color is a bare hex with no '#'; an empty value means "unstyled".
      color: meta.route_color ? `#${meta.route_color}` : style.css,
      width: style.width,
      priority: style.priority,
      coordinates: coords,
    });
  }
  // Rail first so it paints over the bus mesh rather than under it.
  outRoutes.sort((a, b) => a.priority - b.priority || a.routeId.localeCompare(b.routeId));

  const outStops = [];
  for (const s of stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!inBbox(lat, lon, bbox)) continue;
    outStops.push({
      id: `translink-stop-${s.stop_id}`,
      stopId: s.stop_id,
      name: s.stop_name || '',
      lat,
      lon,
      // A station (location_type 1) is a landmark; a bus pole is not.
      isStation: s.location_type === '1',
    });
  }

  return { routes: outRoutes, stops: outStops };
}
