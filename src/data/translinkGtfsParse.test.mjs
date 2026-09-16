import assert from 'node:assert/strict';
import test from 'node:test';

import {
  splitCsvLine,
  parseCsv,
  inBbox,
  simplifyLine,
  routeTypeStyle,
  buildLocalNetwork,
} from './translinkGtfsParse.js';

const BBOX = { minLat: 49.2, maxLat: 49.4, minLon: -122.95, maxLon: -122.65 };

test('a quoted comma stays inside its field instead of shifting every later column', () => {
  // TransLink's own route_long_name and route_url values contain commas, so a
  // plain split(',') yields a row of plausible length with the wrong values in
  // it — the failure is silent, which is why this is pinned.
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('1,"Station, Bay 13",3'), ['1', 'Station, Bay 13', '3']);
  assert.deepEqual(splitCsvLine('x,"say ""hi""",z'), ['x', 'say "hi"', 'z']);
  assert.deepEqual(splitCsvLine('trailing,'), ['trailing', '']);
});

test('parseCsv strips a BOM so the first column keeps its documented name', () => {
  const rows = parseCsv('﻿route_id,route_type\r\n123,3\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route_id, '123', 'a BOM must not become part of the header name');
  assert.equal(rows[0].route_type, '3');
});

test('parseCsv skips blank lines and tolerates short rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n\n4,5\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].c, '', 'a missing trailing cell reads as empty, not undefined');
});

test('inBbox is inclusive at the edges and rejects non-finite input', () => {
  assert.equal(inBbox(49.2, -122.95, BBOX), true);
  assert.equal(inBbox(49.4, -122.65, BBOX), true);
  assert.equal(inBbox(49.5, -122.8, BBOX), false);
  assert.equal(inBbox(NaN, -122.8, BBOX), false);
});

test('simplifyLine keeps both endpoints and drops only near-collinear points', () => {
  const straight = [
    [0, 0],
    [1, 0.00001],
    [2, 0],
  ];
  assert.deepEqual(simplifyLine(straight, 0.001), [
    [0, 0],
    [2, 0],
  ]);

  const corner = [
    [0, 0],
    [1, 1],
    [2, 0],
  ];
  assert.equal(simplifyLine(corner, 0.001).length, 3, 'a real corner survives');

  // Degenerate input must not throw or lose the line.
  assert.deepEqual(simplifyLine([[0, 0]], 0.1), [[0, 0]]);
  assert.deepEqual(simplifyLine([], 0.1), []);
});

test('routeTypeStyle gives rail its own weight and never returns undefined', () => {
  assert.equal(routeTypeStyle(1).kind, 'subway');
  assert.equal(routeTypeStyle('2').kind, 'rail', 'string route_type values come straight from CSV');
  assert.equal(routeTypeStyle(3).kind, 'bus');
  assert.equal(routeTypeStyle(715).kind, 'demand');
  // An unlisted type must still draw rather than vanish.
  assert.equal(routeTypeStyle(99).kind, 'other');
  assert.ok(routeTypeStyle(1).priority < routeTypeStyle(3).priority, 'rail paints over bus');
});

test('buildLocalNetwork keeps a whole shape that merely touches the bbox', () => {
  // The shape runs from far outside the box, through it, and out again. Clipping
  // it would make the route look like it terminates at the boundary.
  const tables = {
    routes: [{ route_id: 'R1', route_type: '3', route_short_name: '99', route_long_name: 'B-Line' }],
    trips: [{ route_id: 'R1', shape_id: 'S1' }],
    shapes: [
      { shape_id: 'S1', shape_pt_lat: '48.0', shape_pt_lon: '-122.8', shape_pt_sequence: '1' },
      { shape_id: 'S1', shape_pt_lat: '49.3', shape_pt_lon: '-122.8', shape_pt_sequence: '2' },
      { shape_id: 'S1', shape_pt_lat: '50.0', shape_pt_lon: '-122.8', shape_pt_sequence: '3' },
    ],
    stops: [],
  };
  const { routes } = buildLocalNetwork(tables, { bbox: BBOX });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].coordinates.length, 3, 'the shape is kept whole, not clipped');
  assert.equal(routes[0].shortName, '99');
});

test('buildLocalNetwork drops a shape that never enters the bbox', () => {
  const tables = {
    routes: [{ route_id: 'R1', route_type: '3' }],
    trips: [{ route_id: 'R1', shape_id: 'S1' }],
    shapes: [
      { shape_id: 'S1', shape_pt_lat: '48.0', shape_pt_lon: '-122.8', shape_pt_sequence: '1' },
      { shape_id: 'S1', shape_pt_lat: '48.1', shape_pt_lon: '-122.8', shape_pt_sequence: '2' },
    ],
    stops: [],
  };
  assert.equal(buildLocalNetwork(tables, { bbox: BBOX }).routes.length, 0);
});

test('one route yields one line — the longest of its shape variants', () => {
  // TransLink publishes 1,068 shapes for 239 routes; drawing every pattern
  // variant stacks near-identical lines for no visual gain.
  const tables = {
    routes: [{ route_id: 'R1', route_type: '3' }],
    trips: [
      { route_id: 'R1', shape_id: 'SHORT' },
      { route_id: 'R1', shape_id: 'LONG' },
    ],
    shapes: [
      { shape_id: 'SHORT', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'SHORT', shape_pt_lat: '49.31', shape_pt_lon: '-122.80', shape_pt_sequence: '2' },
      { shape_id: 'LONG', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'LONG', shape_pt_lat: '49.32', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
      { shape_id: 'LONG', shape_pt_lat: '49.34', shape_pt_lon: '-122.82', shape_pt_sequence: '3' },
    ],
    stops: [],
  };
  const { routes } = buildLocalNetwork(tables, { bbox: BBOX });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].shapeId, 'LONG');
});

test('shape points are ordered by sequence, not file order', () => {
  const tables = {
    routes: [{ route_id: 'R1', route_type: '3' }],
    trips: [{ route_id: 'R1', shape_id: 'S1' }],
    shapes: [
      { shape_id: 'S1', shape_pt_lat: '49.34', shape_pt_lon: '-122.82', shape_pt_sequence: '3' },
      { shape_id: 'S1', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'S1', shape_pt_lat: '49.32', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
    ],
    stops: [],
  };
  const [route] = buildLocalNetwork(tables, { bbox: BBOX }).routes;
  assert.deepEqual(route.coordinates[0], [-122.8, 49.3]);
  assert.deepEqual(route.coordinates[2], [-122.82, 49.34]);
});

test('route_color becomes a hex string, and an empty one falls back to the type style', () => {
  const tables = {
    routes: [
      { route_id: 'R1', route_type: '1', route_color: '0033a0', route_long_name: 'Expo Line' },
      { route_id: 'R2', route_type: '3', route_color: '', route_long_name: 'Some Bus' },
    ],
    trips: [
      { route_id: 'R1', shape_id: 'S1' },
      { route_id: 'R2', shape_id: 'S2' },
    ],
    shapes: [
      { shape_id: 'S1', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'S1', shape_pt_lat: '49.31', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
      { shape_id: 'S2', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'S2', shape_pt_lat: '49.31', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
    ],
    stops: [],
  };
  const { routes } = buildLocalNetwork(tables, { bbox: BBOX });
  const expo = routes.find((r) => r.routeId === 'R1');
  const bus = routes.find((r) => r.routeId === 'R2');
  assert.equal(expo.color, '#0033a0', 'GTFS colours have no leading #');
  assert.equal(bus.color, routeTypeStyle(3).css);
});

test('rail sorts ahead of bus so it paints on top', () => {
  const mk = (id, type) => ({ route_id: id, route_type: type });
  const shapeFor = (sid) => [
    { shape_id: sid, shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
    { shape_id: sid, shape_pt_lat: '49.31', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
  ];
  const tables = {
    routes: [mk('BUS', '3'), mk('TRAIN', '1')],
    trips: [
      { route_id: 'BUS', shape_id: 'SB' },
      { route_id: 'TRAIN', shape_id: 'ST' },
    ],
    shapes: [...shapeFor('SB'), ...shapeFor('ST')],
    stops: [],
  };
  const { routes } = buildLocalNetwork(tables, { bbox: BBOX });
  assert.equal(routes[0].routeId, 'TRAIN');
});

test('stops are filtered to the bbox and stations are flagged', () => {
  const tables = {
    routes: [],
    trips: [],
    shapes: [],
    stops: [
      { stop_id: '1', stop_name: 'Coquitlam Central', stop_lat: '49.2749', stop_lon: '-122.7993', location_type: '1' },
      { stop_id: '2', stop_name: 'Some Pole', stop_lat: '49.30', stop_lon: '-122.80', location_type: '0' },
      { stop_id: '3', stop_name: 'Far Away', stop_lat: '48.0', stop_lon: '-123.5', location_type: '0' },
    ],
  };
  const { stops } = buildLocalNetwork(tables, { bbox: BBOX });
  assert.equal(stops.length, 2, 'the out-of-box stop is dropped');
  assert.equal(stops.find((s) => s.stopId === '1').isStation, true);
  assert.equal(stops.find((s) => s.stopId === '2').isStation, false);
});

test('a trip referencing a missing route still draws, with empty names', () => {
  // routes.txt and trips.txt are separate files; a mismatch must degrade, not throw.
  const tables = {
    routes: [],
    trips: [{ route_id: 'GHOST', shape_id: 'S1' }],
    shapes: [
      { shape_id: 'S1', shape_pt_lat: '49.30', shape_pt_lon: '-122.80', shape_pt_sequence: '1' },
      { shape_id: 'S1', shape_pt_lat: '49.31', shape_pt_lon: '-122.81', shape_pt_sequence: '2' },
    ],
    stops: [],
  };
  const { routes } = buildLocalNetwork(tables, { bbox: BBOX });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].shortName, '');
  assert.equal(routes[0].kind, 'other');
});
