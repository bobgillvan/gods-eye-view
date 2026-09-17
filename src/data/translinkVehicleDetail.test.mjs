import assert from 'node:assert/strict';
import test from 'node:test';

import { vehicleDetailRows, vehicleShareText } from './translinkTransit.js';
import { escapeHtml } from './translinkVehicleCard.js';

/** A vehicle shaped like the live feed, with every field TransLink publishes. */
const FULL = Object.freeze({
  id: '15466031',
  routeId: '6649',
  tripId: '15466031',
  startDate: '20260916',
  lat: 49.21754837036133,
  lon: -122.92586517333984,
  bearing: null,
  stopSequence: 28,
  timestamp: Date.now() - 20000,
  stopId: '1428',
  vehicleLabel: '25153',
  routeLabel: '123 Canada Way',
  kind: 'bus',
  color: '#33cc77',
  stopName: 'Southbound 8th St @ 10 Ave',
});

test('a full vehicle renders the detail a rider would actually want', () => {
  const rows = vehicleDetailRows(FULL);
  const map = new Map(rows);
  assert.equal(map.get('Route'), '123 Canada Way');
  assert.equal(map.get('Vehicle'), '#25153');
  assert.equal(map.get('Next stop'), 'Southbound 8th St @ 10 Ave');
  assert.equal(map.get('Stop #'), '28');
  assert.match(map.get('Position'), /^49\.21755, -122\.92587$/);
  assert.match(map.get('Reported'), /^\d+s ago$/);
  assert.equal(map.get('Trip'), '15466031');
  // Route is the card title, so it must come first.
  assert.equal(rows[0][0], 'Route');
});

test('an unenriched vehicle falls back to ids rather than dropping the row', () => {
  // Enrichment needs the static network cache. A vehicle on a route outside
  // the bbox resolves to no name, and "Route 6649" still beats showing nothing.
  const rows = new Map(vehicleDetailRows({ routeId: '6649', stopId: '1428', lat: 49.2, lon: -122.9 }));
  assert.equal(rows.get('Route id'), '6649');
  assert.equal(rows.get('Next stop id'), '1428');
  assert.equal(rows.has('Route'), false);
  assert.equal(rows.has('Next stop'), false);
});

test('absent fields are omitted, not rendered as undefined', () => {
  const rows = vehicleDetailRows({ routeLabel: 'R' });
  const labels = rows.map(([l]) => l);
  assert.deepEqual(labels, ['Route']);
  for (const [, value] of rows) {
    assert.doesNotMatch(String(value), /undefined|null|NaN/);
  }
  // A vehicle with nothing at all must not throw.
  assert.deepEqual(vehicleDetailRows({}), []);
  assert.deepEqual(vehicleDetailRows(null), []);
});

test('an old timestamp shows a clock time rather than a growing seconds count', () => {
  const rows = new Map(vehicleDetailRows({ ...FULL, timestamp: Date.now() - 600000 }));
  assert.doesNotMatch(rows.get('Reported'), /s ago/);
});

test('share text is one line and names the route and vehicle', () => {
  const text = vehicleShareText(FULL);
  assert.doesNotMatch(text, /\n/, 'a shared line must survive being pasted anywhere');
  assert.match(text, /TransLink 123 Canada Way/);
  assert.match(text, /Vehicle: #25153/);
  assert.match(text, /Next stop: Southbound 8th St @ 10 Ave/);
  // The route is the heading, so it must not also appear as a field.
  assert.doesNotMatch(text, /Route: /);
});

test('share text degrades to the route id when there is no name', () => {
  assert.match(vehicleShareText({ routeId: '6649' }), /^TransLink Route 6649/);
  assert.match(vehicleShareText({}), /^TransLink Route \?/);
});

test('feed text is escaped before it reaches innerHTML', () => {
  // Stop and route names come from an upstream feed, so they are untrusted
  // even though they look like plain labels.
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`Bay "3" & 4's`), 'Bay &quot;3&quot; &amp; 4&#39;s');
  assert.equal(escapeHtml(null), '');
});

test('dense points are GPU primitives, not per-frame entities', async () => {
  // 1,710 stop Entities were ~96% of this layer's scene objects and visibly
  // cost frame rate when the layer was on. Every other dense layer here
  // (flights at 5,000+, bikeshare, CCTV) batches into a primitive collection;
  // this pins that this one does too. Routes stay entities — there are 74, and
  // polylines want the entity layer's clampToGround.
  const Cesium = await import('cesium');
  const { createTranslinkTransitLayer } = await import('./translinkTransit.js');

  const network = {
    routes: Array.from({ length: 3 }, (_, i) => ({
      id: `r${i}`,
      routeId: `R${i}`,
      color: '#33cc77',
      width: 2,
      routeType: 3,
      coordinates: [
        [-122.8, 49.28],
        [-122.81, 49.29],
      ],
    })),
    stops: Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      stopId: String(i),
      name: `Stop ${i}`,
      lat: 49.28 + i * 0.0001,
      lon: -122.8,
      isStation: i === 0,
    })),
  };
  const vehicles = {
    configured: true,
    vehicles: Array.from({ length: 7 }, (_, i) => ({
      id: `v${i}`,
      routeId: 'R0',
      lat: 49.281,
      lon: -122.801,
    })),
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('vehicles') ? vehicles : network),
  });
  try {
    const primitives = [];
    const dataSources = [];
    const layer = createTranslinkTransitLayer();
    layer.init({
      dataSources: { add: (d) => dataSources.push(d), remove() {} },
      scene: { primitives: { add: (p) => primitives.push(p), remove() {} }, canvas: null },
    });
    await layer.update();

    assert.equal(primitives.length, 2, 'one collection for stops, one for vehicles');
    for (const collection of primitives) {
      assert.ok(
        collection instanceof Cesium.PointPrimitiveCollection,
        'dense points must batch into a PointPrimitiveCollection',
      );
    }
    const [stopPoints, vehiclePoints] = primitives;
    assert.equal(stopPoints.length, 50);
    assert.equal(vehiclePoints.length, 7);

    // The entity layer carries ONLY the route polylines.
    const entities = dataSources[0].entities.values;
    assert.equal(entities.length, 3, 'stops and vehicles must not be entities');
    for (const entity of entities) {
      assert.ok(entity.polyline, 'the only entities left are route polylines');
      assert.equal(entity.point, undefined);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
