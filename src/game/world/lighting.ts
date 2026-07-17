// Blue-hour shadow-follow math (Phase 5, TDD §8.2). Deliberately framework-free — plain
// {x,y,z} numbers, zero three/react imports — so it unit-tests cleanly (lighting.test.ts),
// exactly like fx/cameraRig.ts. The R3F rig that consumes it lives in world/BlueHourRig.tsx.
//
// The one job here: keep the player-following directional shadow frustum from SHIMMERING.
// A tight 60 m ortho shadow box that slides continuously with the car makes every shadow
// edge crawl/sparkle, because each frame the shadow map samples the world at a slightly
// different sub-texel offset. The fix (standard CSM technique) is to quantize the frustum's
// position to whole shadow-map texels — snapToShadowTexel below — and to move the light and
// its target by the SAME delta so the light DIRECTION never changes.

import { LIGHTING } from '../config/lighting';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG2RAD = Math.PI / 180;
// A snapped coordinate `k·texel` can divide back to `k − 3e-13` in float, so a naive
// floor() drops it a whole texel and the snap isn't idempotent (an already-snapped point
// jitters by one texel). Nudge the texel INDEX up by this before flooring: dwarfs the
// representation error yet is far too small (≈3e-8 m for a 60 m / 2048 texel) to move any
// real point across a cell boundary.
const SNAP_INDEX_EPSILON = 1e-6;

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Orthonormal basis of the directional light's shadow camera.
 * `right`/`up` span the shadow-map plane (the texel grid axes we snap along); `forward` is
 * the light's view/travel direction (target − position). Built once from the fixed sun
 * azimuth/elevation, matching how three's DirectionalLightShadow.updateMatrices derives its
 * ortho camera basis (lookAt from light → target with world-up = +Y). */
export interface SunBasis {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

/** World-space unit vector pointing FROM the scene TOWARD the sun, from a compass azimuth
 * (0 = N = −Z, 90 = E = +X, 180 = S = +Z, 270 = W = −X; clockwise seen from above) and an
 * elevation above the horizon. The light shines the opposite way (forward = −toSun). */
export function sunToWorld(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = azimuthDeg * DEG2RAD;
  const el = elevationDeg * DEG2RAD;
  const cosEl = Math.cos(el);
  // az=0 → (0,·,−1)=N ✓ ; az=90 → (1,·,0)=E ✓ ; az=270 → (−1,·,0)=W ✓
  return { x: cosEl * Math.sin(az), y: Math.sin(el), z: -cosEl * Math.cos(az) };
}

/** Build the shadow camera's orthonormal basis for a sun at the given azimuth/elevation.
 * Mirrors three's shadow-camera lookAt: camZ points from target back toward the light
 * (= toSun), right = normalize(worldUp × camZ), up = camZ × right. */
export function computeSunBasis(azimuthDeg: number, elevationDeg: number): SunBasis {
  const toSun = sunToWorld(azimuthDeg, elevationDeg);
  const forward: Vec3 = { x: -toSun.x, y: -toSun.y, z: -toSun.z }; // light travel direction
  const camZ = toSun; // shadow camera looks along −camZ (i.e. along forward)
  // right = normalize(worldUp × camZ). worldUp = (0,1,0) → (camZ.z, 0, −camZ.x).
  let rx = camZ.z;
  let ry = 0;
  let rz = -camZ.x;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-6) {
    // Sun straight overhead/underfoot (never happens at our elevation): fall back to +X.
    rx = 1;
    ry = 0;
    rz = 0;
    rl = 1;
  }
  const right: Vec3 = { x: rx / rl, y: ry / rl, z: rz / rl };
  // up = camZ × right (already unit: camZ ⟂ right and both unit).
  const up: Vec3 = {
    x: camZ.y * right.z - camZ.z * right.y,
    y: camZ.z * right.x - camZ.x * right.z,
    z: camZ.x * right.y - camZ.y * right.x,
  };
  return { right, up, forward };
}

/** Metres of world space per shadow-map texel: the ortho box side / the shadow map size. */
export function worldTexelSize(frustumM: number, shadowMapSize: number): number {
  return frustumM / shadowMapSize;
}

/**
 * Snap a follow center to the shadow map's texel grid, IN THE LIGHT'S VIEW PLANE, so the
 * shadow map samples the same world texels frame-to-frame (this is THE fix for the crawling-
 * shadow shimmer you get when a tight follow frustum slides continuously). We project
 * `center` onto the shadow camera's `right`/`up` axes, floor each coordinate to a whole
 * `worldTexel` multiple, then reproject — keeping the original depth component along
 * `forward` untouched (depth doesn't move texels within the plane, so it can't shimmer).
 * Because the snap happens purely in the plane perpendicular to the light direction, the
 * light direction is never altered → shadows never swing. Writes into `out`, returns it.
 */
export function snapToShadowTexel(
  center: Readonly<Vec3>,
  basis: SunBasis,
  worldTexel: number,
  out: Vec3,
): Vec3 {
  const { right: r, up: u, forward: f } = basis;
  // Decompose center into the (right, up, forward) orthonormal frame.
  const cr = dot(center, r);
  const cu = dot(center, u);
  const cf = dot(center, f); // depth along the light direction — preserved as-is
  // Quantize the in-plane coordinates to the texel grid (idempotent — see SNAP_INDEX_EPSILON).
  const sr = Math.floor(cr / worldTexel + SNAP_INDEX_EPSILON) * worldTexel;
  const su = Math.floor(cu / worldTexel + SNAP_INDEX_EPSILON) * worldTexel;
  // Reproject back to world space with the untouched depth.
  out.x = sr * r.x + su * u.x + cf * f.x;
  out.y = sr * r.y + su * u.y + cf * f.y;
  out.z = sr * r.z + su * u.z + cf * f.z;
  return out;
}

/**
 * Full shadow-follow solve: given the player-centred `center`, produce the snapped shadow
 * TARGET and the light POSITION that trails it by the constant `sunOffset`. Because both
 * points move by the exact same snapped delta, `light − target === sunOffset` always — the
 * light DIRECTION is invariant (shadows never swing), while the frustum tracks the player in
 * whole-texel steps (shadows never shimmer). Writes both outputs, allocation-free.
 */
export function computeSunFollow(
  center: Readonly<Vec3>,
  basis: SunBasis,
  sunOffset: Readonly<Vec3>,
  worldTexel: number,
  outTarget: Vec3,
  outLight: Vec3,
): void {
  snapToShadowTexel(center, basis, worldTexel, outTarget);
  outLight.x = outTarget.x + sunOffset.x;
  outLight.y = outTarget.y + sunOffset.y;
  outLight.z = outTarget.z + sunOffset.z;
}

// --- Blue-hour sky gradient math (Phase 19, TDD §8/§13) -----------------------------------
// The sky is a 2D CanvasTexture on scene.background (world/BlueHourRig.tsx). Because the
// follow camera is fixed-yaw (config/camera.ts), a screen-space gradient maps to a constant
// compass bearing, so the whole look — vertical blue-hour ramp + a warm directional "lake
// glow" lobe over the south horizon — can be baked with zero extra draw cost. The PAINTING
// lives in BlueHourRig (needs a canvas); the pure geometry of WHERE the stops/lobe land is
// here so it unit-tests without a DOM. Colours pass through untouched (no colour math here).

/** Structural view of LIGHTING.sky (kept decoupled from the config const so tests pass
 * literals). */
export interface SkyConfig {
  readonly top: string;
  readonly horizon: string;
  readonly bottom: string;
  readonly horizonStop: number;
  readonly glow: {
    readonly color: string;
    readonly strength: number;
    readonly centerX: number;
    readonly centerY: number;
    readonly radius: number;
  };
}

export interface SkyStop {
  /** Position down the vertical gradient, 0 (top) .. 1 (bottom). */
  readonly pos: number;
  readonly color: string;
}

// The warm band needs room above and below it, so the horizon stop can never sit hard against
// either end even if a leva drag pushes horizonStop to 0/1.
const HORIZON_STOP_MIN = 0.05;
const HORIZON_STOP_MAX = 0.95;

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * The three vertical colour stops of the blue-hour sky ramp: deep-blue zenith at the top,
 * the warm horizon band at `horizonStop` (clamped into [0.05, 0.95] so it always has room),
 * ground-ward tint at the bottom. Strictly ascending by construction — ready to feed a
 * canvas linear gradient top→bottom.
 */
export function skyGradientStops(sky: SkyConfig): SkyStop[] {
  const stop = Math.min(HORIZON_STOP_MAX, Math.max(HORIZON_STOP_MIN, sky.horizonStop));
  return [
    { pos: 0, color: sky.top },
    { pos: stop, color: sky.horizon },
    { pos: 1, color: sky.bottom },
  ];
}

/** A resolved radial glow lobe in CANVAS PIXELS, ready for a canvas radial gradient. */
export interface SkyGlowLobe {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly color: string;
  /** Peak added-warmth alpha at the lobe centre, 0..1. */
  readonly strength: number;
}

/**
 * Place the directional lake-glow lobe on a `width`×`height` canvas: centre from the config's
 * screen-space fractions (clamped to the canvas), radius as a fraction of the canvas diagonal
 * (never below 1px), strength clamped to [0,1]. Pure — the painter just draws the returned
 * radial gradient.
 */
export function resolveSkyGlow(sky: SkyConfig, width: number, height: number): SkyGlowLobe {
  const g = sky.glow;
  const diag = Math.hypot(width, height);
  return {
    cx: clamp01(g.centerX) * width,
    cy: clamp01(g.centerY) * height,
    radius: Math.max(1, g.radius * diag),
    color: g.color,
    strength: clamp01(g.strength),
  };
}

// Precomputed once at load from the (structural) sun angle — see config/lighting.ts on why
// azimuth/elevation aren't leva-live. sunOffset places the light `distanceM` up its own
// direction from whatever the shadow target is (= −forward · distance = toSun · distance).
export const SUN_BASIS = computeSunBasis(LIGHTING.sun.azimuthDeg, LIGHTING.sun.elevationDeg);
export const SUN_OFFSET: Vec3 = {
  x: -SUN_BASIS.forward.x * LIGHTING.sun.distanceM,
  y: -SUN_BASIS.forward.y * LIGHTING.sun.distanceM,
  z: -SUN_BASIS.forward.z * LIGHTING.sun.distanceM,
};
