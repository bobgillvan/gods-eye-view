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
