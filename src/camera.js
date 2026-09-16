import * as Cesium from 'cesium';

/**
 * Where the globe opens when there is no share link in the URL.
 *
 * Overridable at build time with VITE_STARTUP_LOCATION (`lon,lat`), because
 * the interesting place is wherever the operator lives — upstream opens on
 * Austin, this fork on Coquitlam, BC, where the local CCTV, parking, trails
 * and transit layers actually have data.
 *
 * A malformed value falls back rather than throwing: a typo in an env var
 * should not leave the camera at the centre of the earth.
 */
export const STARTUP_LOCATION = (() => {
  const fallback = { lon: -122.7932, lat: 49.2838, name: 'Coquitlam, BC' };
  const raw = import.meta.env?.VITE_STARTUP_LOCATION;
  if (!raw) return fallback;
  const [lon, lat] = String(raw)
    .split(',')
    .map((n) => Number(n.trim()));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    console.warn(`[Camera] VITE_STARTUP_LOCATION is not "lon,lat": ${raw}`);
    return fallback;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    console.warn(`[Camera] VITE_STARTUP_LOCATION is out of range: ${raw}`);
    return fallback;
  }
  return { lon, lat, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
})();

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Open the globe on STARTUP_LOCATION with a cinematic fly-in.
 *
 * Kept exported as `flyToAustin` as well (see the alias below) so any caller
 * or test written against the old name keeps working.
 *
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToStartupLocation(viewer) {
  const { lon, lat } = STARTUP_LOCATION;
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 600),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

/**
 * Back-compat alias. The startup location is no longer Austin, but the old
 * name is still imported by existing callers and tests.
 *
 * @deprecated Use flyToStartupLocation.
 */
export const flyToAustin = flyToStartupLocation;
