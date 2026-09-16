// src/data/coquitlamParkingParse.test.mjs — the Coquitlam occupancy feed contract.
//
// The City publishes live lot counts as a server-rendered jQuery snippet, not an
// API. That endpoint is undocumented and can change without notice, so these tests
// pin the two behaviours that matter:
//
//   1. a real payload parses to the right numbers, and
//   2. an unrecognized payload yields {} — "occupancy unknown" — rather than
//      partial or zeroed data that would render a full lot as empty.
//
// The fixture below is a verbatim excerpt captured from
// https://cqapi.coquitlam.ca/parking/parkinglot.js on 2026-09-12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOccupancyFeed,
  findUnmappedWidgets,
  WIDGET_TO_LOT,
} from './coquitlamParkingParse.js';

const LIVE_FIXTURE = [
  'jQuery("#parkinglot-104-0 .pagestats-number").text("148");',
  'jQuery("#parkinglot-104-0 .pagestats-body").text("Empty");',
  'jQuery("#parkinglot-104-0 .pagestats-progress progress").attr("max", "148");',
  'jQuery("#parkinglot-104-0 .pagestats-progress progress").attr("value", "0");',
  'jQuery("#parkinglot-114-1 .pagestats-number").text("0");',
  'jQuery("#parkinglot-114-1 .pagestats-body").text("Lot Full");',
  'jQuery("#parkinglot-114-1 .pagestats-progress progress").attr("max", "118");',
  'jQuery("#parkinglot-114-1 .pagestats-progress progress").attr("value", "127");',
].join('');

test('parses a real occupancy payload into per-lot counts', () => {
  const parsed = parseOccupancyFeed(LIVE_FIXTURE);
  assert.equal(Object.keys(parsed).length, 2);

  const empty = parsed['parkinglot-104-0'];
  assert.equal(empty.free, 148);
  assert.equal(empty.capacity, 148);
  assert.equal(empty.occupied, 0);
  assert.equal(empty.status, 'Empty');
  assert.equal(empty.occupancyPct, 0);
});

test('clamps the over-capacity reading the City actually publishes', () => {
  // Lot C reported 127 occupied against a watched capacity of 118 — counter drift
  // and aisle parking make >100% a real, recurring value, not a bad parse.
  const full = parseOccupancyFeed(LIVE_FIXTURE)['parkinglot-114-1'];
  assert.equal(full.free, 0);
  assert.equal(full.status, 'Lot Full');
  assert.equal(full.rawOccupancyPct, 108, 'raw percentage is preserved for diagnosis');
  assert.equal(full.occupancyPct, 100, 'displayed percentage is clamped to 100');
});

test('an unrecognized payload yields no lots rather than wrong ones', () => {
  // If the City migrates to JSON (or any other shape), every regex misses. The
  // required outcome is {} so the caller reports "occupancy unknown" and still
  // draws lot geometry — never zeros, which would render a full lot as empty.
  for (const payload of [
    'window.parkingData = {"114-1": {"free": 0}};',
    '<!DOCTYPE html><html><body>Not found</body></html>',
    '',
    null,
    undefined,
  ]) {
    assert.deepEqual(parseOccupancyFeed(payload), {});
  }
});

test('a partial record still reports free spaces without inventing capacity', () => {
  // Numbers present but the progress bar missing: keep what parsed, null the rest.
  const parsed = parseOccupancyFeed('jQuery("#parkinglot-113-0 .pagestats-number").text("116");');
  const lot = parsed['parkinglot-113-0'];
  assert.equal(lot.free, 116);
  assert.equal(lot.capacity, null);
  assert.equal(lot.occupancyPct, null, 'no capacity means no percentage, not 0%');
});

test('every mapped widget points at a distinct lot', () => {
  const lots = Object.values(WIDGET_TO_LOT);
  assert.equal(new Set(lots).size, lots.length, 'two widgets mapped to one lot would duplicate data');
  assert.equal(lots.length, 6);
});

test('flags a widget the mapping does not cover', () => {
  // The tell that the City instrumented a new lot: live data with nowhere to go.
  const parsed = parseOccupancyFeed(
    LIVE_FIXTURE + 'jQuery("#parkinglot-999-0 .pagestats-number").text("42");',
  );
  assert.deepEqual(findUnmappedWidgets(parsed), ['parkinglot-999-0']);
  assert.deepEqual(findUnmappedWidgets(parseOccupancyFeed(LIVE_FIXTURE)), []);
});
