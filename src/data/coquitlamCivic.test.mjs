import assert from 'node:assert/strict';
import test from 'node:test';

import {
  crimeWhereClause,
  trailStyle,
  crimeStyle,
  TRAIL_CLASS_STYLE,
  CRIME_TYPE_STYLE,
} from '../../server/providers/coquitlamCivic.js';
import { ageAlpha, incidentLabel } from './coquitlamCrime.js';
import { flattenTrail, trailDescription } from './coquitlamTrails.js';
import { flattenCoordinates, routeLabel } from './translinkTransit.js';

test('the crime window emits a TIMESTAMP literal, not epoch milliseconds', () => {
  // Verified against the live service 2026-09-16: an epoch-ms comparison is
  // rejected with "Unable to perform query", while this form works. The failure
  // is a 400, so getting it wrong empties the layer rather than degrading it.
  const clause = crimeWhereClause(12, new Date('2026-09-16T00:00:00Z'));
  assert.equal(clause, "Reported_Date >= TIMESTAMP '2025-09-16 00:00:00'");
  assert.match(clause, /TIMESTAMP '\d{4}-\d{2}-\d{2} 00:00:00'/);
});

test('a zero or negative window means everything, not an empty result', () => {
  assert.equal(crimeWhereClause(0), '1=1');
  assert.equal(crimeWhereClause(-3), '1=1');
  assert.equal(crimeWhereClause(NaN), '1=1');
});

test('the window crosses a year boundary correctly', () => {
  assert.equal(
    crimeWhereClause(3, new Date('2026-01-15T00:00:00Z')),
    "Reported_Date >= TIMESTAMP '2025-10-15 00:00:00'",
  );
});

test('every published trail class has a style, and an unknown one still draws', () => {
  // All ten classes present in the FULL 6,494-segment set. Mountain Bike Trail
  // and Entry Plaza are absent from the first 1,000 records, so a truncated
  // fetch would have made this list look complete at eight.
  for (const cls of [
    'Urban Multi-Use Trail',
    'Park Pathway',
    'Urban Nature Trail',
    'Nature Trail',
    'Mountain Bike Trail',
    'Park Connector',
    'Entry Plaza',
    'Boardwalk',
    'Bridge',
    'Stairs',
  ]) {
    assert.ok(TRAIL_CLASS_STYLE[cls], `${cls} must have an explicit style`);
    assert.match(trailStyle(cls).css, /^#[0-9a-f]{6}$/i);
  }
  const unknown = trailStyle('Something The City Added Later');
  assert.match(unknown.css, /^#[0-9a-f]{6}$/i, 'an unlisted class falls back rather than vanishing');
  assert.ok(unknown.width >= 1);
});

test('crime colours distinguish residential break-ins from the commonest offence', () => {
  // Theft from Auto is ~65% of records. If the commonest thing is also the
  // loudest, the map says nothing.
  for (const type of Object.keys(CRIME_TYPE_STYLE)) {
    assert.match(crimeStyle(type).css, /^#[0-9a-f]{6}$/i);
  }
  assert.notEqual(
    crimeStyle('Break & Enter - Residence').css,
    crimeStyle('Theft from Auto').css,
  );
  assert.equal(crimeStyle('Mischief').label, 'Other', 'an unlisted offence is labelled, not blank');
});

test('older incidents fade but never become invisible', () => {
  const now = Date.UTC(2026, 8, 16);
  const fresh = ageAlpha(now, 12, now);
  const old = ageAlpha(now - 330 * 24 * 60 * 60 * 1000, 12, now);
  assert.equal(fresh, 1);
  assert.ok(old < fresh, 'an old incident is dimmer');
  assert.ok(old >= 0.35, 'but still visible — the window only holds real incidents');
});

test('ageAlpha is full strength when there is no window or no date', () => {
  assert.equal(ageAlpha(Date.now(), null), 1);
  assert.equal(ageAlpha(null, 12), 1);
  assert.equal(ageAlpha(undefined, 12), 1);
  // A future-dated record must not produce an alpha above 1.
  assert.equal(ageAlpha(Date.now() + 86400000, 12), 1);
});

test('an incident label carries type, date, and address', () => {
  const label = incidentLabel({
    typeLabel: 'B&E residence',
    reportedAt: Date.UTC(2026, 7, 31),
    address: '1234 SOME ST',
  });
  assert.match(label, /B&E residence/);
  assert.match(label, /2026-08-31/);
  assert.match(label, /1234 SOME ST/);
  // A record missing its date must still label rather than print "Invalid Date".
  assert.match(incidentLabel({ type: 'Theft of Auto' }), /date unknown/);
});

test('coordinate flattening drops malformed points instead of poisoning the line', () => {
  const input = [
    [-122.8, 49.3],
    [NaN, 49.3],
    [-122.8],
    'not a point',
    [-122.81, 49.31],
  ];
  assert.deepEqual(flattenTrail(input), [-122.8, 49.3, -122.81, 49.31]);
  assert.deepEqual(flattenCoordinates(input), [-122.8, 49.3, -122.81, 49.31]);
  assert.deepEqual(flattenTrail(null), []);
});

test('a trail description omits parts it does not have', () => {
  assert.equal(
    trailDescription({ trailClass: 'Boardwalk', surface: 'Boardwalk', lengthM: 42.4 }),
    'Boardwalk · Boardwalk · 42 m',
  );
  assert.equal(trailDescription({ trailClass: 'Stairs' }), 'Stairs');
  assert.equal(trailDescription({}), '');
});

test('a SkyTrain route labels by its long name, not an empty short name', () => {
  // TransLink leaves route_short_name empty for rail; preferring it alone would
  // label every train with a blank string.
  assert.equal(routeLabel({ shortName: '', longName: 'Expo Line' }), 'Expo Line');
  assert.equal(routeLabel({ shortName: '99', longName: 'B-Line' }), '99 B-Line');
  assert.equal(routeLabel({ shortName: '143', longName: '' }), '143');
  assert.equal(routeLabel({}), 'Route');
});

test('the transit panel count reports live vehicles, not the static route count', async () => {
  // The toggle panel renders stats.count. Reporting 74 routes on a layer whose
  // whole point is moving vehicles made a working live feed look frozen — the
  // number never changed between refreshes.
  const { createTranslinkTransitLayer } = await import('./translinkTransit.js');

  const network = {
    feedVersion: 'TEST',
    routes: [
      {
        id: 'r1',
        routeId: 'R1',
        color: '#0033a0',
        width: 3,
        routeType: 1,
        coordinates: [
          [-122.8, 49.28],
          [-122.81, 49.29],
        ],
      },
    ],
    stops: [{ id: 's1', stopId: '1', name: 'Stop', lat: 49.28, lon: -122.8, isStation: false }],
  };
  const vehicles = {
    configured: true,
    vehicles: [
      { id: 'v1', routeId: 'R1', lat: 49.281, lon: -122.801, bearing: null },
      { id: 'v2', routeId: 'R1', lat: 49.282, lon: -122.802, bearing: null },
      { id: 'v3', routeId: 'R1', lat: 49.283, lon: -122.803, bearing: null },
    ],
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('vehicles') ? vehicles : network),
  });
  try {
    const layer = createTranslinkTransitLayer();
    const sources = [];
    layer.init({ dataSources: { add: (ds) => sources.push(ds), remove() {} } });
    await layer.update();

    const stats = layer.getStats();
    assert.equal(stats.vehicles, 3);
    assert.equal(stats.routes, 1);
    assert.equal(stats.count, 3, 'the panel count must be the VEHICLE count when keyed');
    assert.notEqual(stats.count, stats.routes, 'reporting routes would make a live feed look static');

    const vehicleSource = sources.find((d) => d.name === 'translink-vehicles');
    assert.equal(vehicleSource.entities.values.length, 3);
    const point = vehicleSource.entities.values[0].point;
    const size = point.pixelSize?.getValue?.() ?? point.pixelSize;
    assert.ok(size >= 14, `a vehicle must be clearly larger than a 4-8 px stop, got ${size}`);
    assert.ok(
      !point.distanceDisplayCondition,
      'a vehicle stays visible when zoomed out past where stops are hidden',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unkeyed transit layer falls back to the route count rather than showing nothing', async () => {
  const { createTranslinkTransitLayer } = await import('./translinkTransit.js');
  const layer = createTranslinkTransitLayer();
  layer.init({ dataSources: { add() {}, remove() {} } });
  const stats = layer.getStats();
  assert.equal(stats.vehicles, null, 'no key means no vehicle data, not zero vehicles');
  assert.equal(stats.count, stats.routes);
});
