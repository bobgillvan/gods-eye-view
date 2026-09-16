/**
 * Pure parsing helpers for the Coquitlam parking occupancy feed.
 *
 * The City serves live lot counts as a server-rendered jQuery snippet rather than
 * JSON (see server/providers/coquitlamParking.js). These helpers are split out
 * here, free of any I/O, so the regex contract against that undocumented endpoint
 * is unit-testable — if the City changes the feed's shape, a test fails instead of
 * the layer silently reporting empty lots.
 */

/**
 * Parse the occupancy snippet into per-widget records.
 *
 * Returns `{}` for an unrecognized payload — the caller treats that as "occupancy
 * unknown" and still renders lot geometry.
 *
 * @param {string} js Raw response body from the occupancy endpoint.
 * @returns {Record<string, {free: number, status: string|null, capacity: number|null, occupied: number|null, occupancyPct: number|null, rawOccupancyPct: number|null}>}
 */
export function parseOccupancyFeed(js) {
  const text = typeof js === 'string' ? js : '';
  if (!text) return {};

  const free = {};
  for (const m of text.matchAll(/#(parkinglot-[\d-]+) \.pagestats-number"\)\.text\("(\d+)"\)/g)) {
    free[m[1]] = Number(m[2]);
  }
  const labels = {};
  for (const m of text.matchAll(/#(parkinglot-[\d-]+) \.pagestats-body"\)\.text\("([^"]*)"\)/g)) {
    labels[m[1]] = m[2];
  }
  const caps = {};
  for (const m of text.matchAll(
    /#(parkinglot-[\d-]+) \.pagestats-progress progress"\)\.attr\("max", "(\d+)"\)/g,
  )) {
    caps[m[1]] = Number(m[2]);
  }
  const used = {};
  for (const m of text.matchAll(
    /#(parkinglot-[\d-]+) \.pagestats-progress progress"\)\.attr\("value", "(\d+)"\)/g,
  )) {
    used[m[1]] = Number(m[2]);
  }

  const out = {};
  for (const id of Object.keys(free)) {
    const capacity = caps[id] ?? null;
    const occupied = used[id] ?? null;
    const raw =
      capacity && capacity > 0 && occupied != null
        ? Math.round((occupied / capacity) * 100)
        : null;
    out[id] = {
      free: free[id],
      status: labels[id] ?? null,
      capacity,
      occupied,
      // The City's own widget reports >100% when counters drift or cars park in
      // aisles; clamp for display but keep the raw figure for diagnosis.
      occupancyPct: raw == null ? null : Math.min(100, raw),
      rawOccupancyPct: raw,
    };
  }
  return out;
}

/**
 * Widget id -> ArcGIS `Lot_Name`, read from the City's rendered DOM.
 *
 * NOT inferred from capacity similarity: the published `Stalls` inventory and the
 * live `max` disagree by design (e.g. Lot E 240 vs 236, Lot B 130 vs 148).
 */
export const WIDGET_TO_LOT = Object.freeze({
  'parkinglot-117-0': 'Coquitlam Crunch',
  'parkinglot-114-0': 'Town Centre Park - Parking Lot A',
  'parkinglot-114-1': 'Town Centre Park - Parking Lot C',
  'parkinglot-114-2': 'Town Centre Park - Parking Lot D',
  'parkinglot-113-0': 'Town Centre Park - Parking Lot E',
  'parkinglot-104-0': 'Town Centre Park - Parking Lot B',
});

/**
 * Widget ids present in a parsed feed that no lot mapping covers.
 *
 * A non-empty result means WIDGET_TO_LOT has gone stale — typically the City
 * instrumented a new lot — and that lot will be missing live data.
 *
 * @param {Record<string, unknown>} parsed Output of parseOccupancyFeed.
 * @param {Record<string, string>} [mapping]
 * @returns {string[]}
 */
export function findUnmappedWidgets(parsed, mapping = WIDGET_TO_LOT) {
  const known = new Set(Object.keys(mapping));
  return Object.keys(parsed || {}).filter((id) => !known.has(id));
}
