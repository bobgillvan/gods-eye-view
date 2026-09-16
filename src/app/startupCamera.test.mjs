import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin } from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('the globe opens on Coquitlam, not Austin', async () => {
  // This fork's local layers — CCTV, parking, trails, transit — all have data
  // in the Tri-Cities and none in Texas, so opening on Austin showed an empty
  // map every time. Pinned because the coordinates are easy to revert by
  // accident when merging upstream.
  const { STARTUP_LOCATION } = await import('../camera.js');
  assert.ok(
    Math.abs(STARTUP_LOCATION.lat - 49.2838) < 0.01,
    'latitude is Coquitlam',
  );
  assert.ok(
    Math.abs(STARTUP_LOCATION.lon - -122.7932) < 0.01,
    'longitude is Coquitlam',
  );
  assert.match(STARTUP_LOCATION.name, /Coquitlam/);
  // Austin must not be the default any more.
  assert.ok(Math.abs(STARTUP_LOCATION.lat - 30.2672) > 1);
});

test('the startup flight uses the configured location at both altitudes', async () => {
  // setView puts the camera high, then flyTo descends. Both must target the
  // same place — an early version changed only one and the camera flew from
  // Coquitlam to Texas on load.
  const { flyToStartupLocation, STARTUP_LOCATION } =
    await import('../camera.js');
  const Cesium = await import('cesium');
  const seen = [];
  const capture = ({ destination }) => {
    const c = Cesium.Cartographic.fromCartesian(destination);
    seen.push({
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    });
  };
  const stop = flyToStartupLocation({
    isDestroyed: () => false,
    camera: { setView: capture, flyTo: capture, cancelFlight() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  stop();
  assert.equal(seen.length, 2, 'a high setView then a descending flyTo');
  for (const point of seen) {
    assert.ok(Math.abs(point.lat - STARTUP_LOCATION.lat) < 0.01);
    assert.ok(Math.abs(point.lon - STARTUP_LOCATION.lon) < 0.01);
  }
});

test('flyToAustin stays exported so existing callers keep working', async () => {
  const { flyToAustin, flyToStartupLocation } = await import('../camera.js');
  assert.equal(
    flyToAustin,
    flyToStartupLocation,
    'the old name is an alias, not a copy',
  );
});
