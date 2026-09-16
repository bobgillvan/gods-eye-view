// src/data/coquitlamParkingStyle.test.mjs — occupancy colour + label contract.
//
// The rule that matters: an UNKNOWN lot must never look like an EMPTY one. When
// the City's counter feed is down the endpoint still returns geometry with
// `free: null`, and painting those lots green would tell the operator a full lot
// has space. These tests pin the neutral-grey/em-dash treatment, the colour
// bands, and the polygon ring extraction.
//
// occupancyStyle / lotLabelText / polygonRings are pure, but the module imports
// cesium for the layer factory, so the helpers are re-implemented here ONLY if
// that import proves unavailable under plain node:test. It resolves fine via the
// repo's vite alias in practice; if this file starts failing on the import line,
// that is the signal to split the helpers into a cesium-free module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occupancyStyle, lotLabelText, polygonRings } from './coquitlamParking.js';

test('unknown occupancy is neutral, never the empty-lot colour', () => {
  const unknown = occupancyStyle(null);
  const empty = occupancyStyle(0);
  assert.equal(unknown.label, 'unknown');
  assert.notEqual(
    unknown.css,
    empty.css,
    'a lot with no live data must not share the colour of a wide-open lot',
  );
  // NaN / undefined are the same "no data" case, not a 0% lot.
  assert.equal(occupancyStyle(undefined).label, 'unknown');
  assert.equal(occupancyStyle(Number.NaN).label, 'unknown');
});

test('occupancy bands escalate open -> filling -> busy -> full', () => {
  assert.equal(occupancyStyle(0).label, 'open');
  assert.equal(occupancyStyle(50).label, 'open');
  assert.equal(occupancyStyle(51).label, 'filling');
  assert.equal(occupancyStyle(80).label, 'filling');
  assert.equal(occupancyStyle(81).label, 'busy');
  assert.equal(occupancyStyle(95).label, 'busy');
  assert.equal(occupancyStyle(96).label, 'full');
  assert.equal(occupancyStyle(100).label, 'full');
});

test('a lot with no live count reads as no data, not as zero free', () => {
  const label = lotLabelText({ name: 'Town Centre Park — Pinetree Lot A', free: null });
  assert.match(label, /no data/);
  assert.doesNotMatch(label, /\bFULL\b/, 'unknown must not be reported as FULL');
  assert.doesNotMatch(label, /\b0 free\b/);
});

test('zero free reads FULL, and a live count reads as free spaces', () => {
  assert.match(lotLabelText({ name: 'Town Centre Park — Pinetree Lot C', free: 0 }), /FULL/);
  assert.match(lotLabelText({ name: 'Town Centre Park — Pinetree Lot E', free: 134 }), /134 free/);
});

test('lot labels drop the repeated park prefix', () => {
  // Six lots stacked on one park: repeating "Town Centre Park" on each label is
  // noise at the zoom where labels are visible.
  assert.match(lotLabelText({ name: 'Town Centre Park — Pinetree Lot E', free: 5 }), /^Pinetree Lot E/);
  assert.match(lotLabelText({ name: 'Coquitlam Crunch — Lansdowne Lot 1', free: 5 }), /^Crunch/);
});

test('polygon rings survive both Polygon and MultiPolygon', () => {
  const square = [
    [-122.78, 49.28],
    [-122.78, 49.29],
    [-122.77, 49.29],
    [-122.77, 49.28],
    [-122.78, 49.28],
  ];
  assert.equal(polygonRings({ type: 'Polygon', coordinates: [square] }).length, 1);
  assert.equal(
    polygonRings({ type: 'MultiPolygon', coordinates: [[square], [square]] }).length,
    2,
  );
});

test('degenerate geometry yields no rings instead of throwing', () => {
  // A malformed upstream payload must drop the lot's polygon, not crash the layer.
  for (const geometry of [
    null,
    undefined,
    { type: 'Point', coordinates: [-122.78, 49.28] },
    { type: 'Polygon', coordinates: [] },
    { type: 'Polygon', coordinates: [[[-122.78, 49.28]]] }, // < 3 points
    { type: 'Polygon', coordinates: [[['x', 'y'], [1, 2], [3, 4]]] },
  ]) {
    assert.deepEqual(polygonRings(geometry), []);
  }
});
