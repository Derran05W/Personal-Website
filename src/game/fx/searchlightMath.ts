// Pure, framework-free math for the helicopter searchlight (fx/Searchlight.tsx). Two
// load-bearing bits live here — the aim-tracking spring (lag + slight overshoot) and the
// analytic beam→ground intersection — kept as plain-number helpers with zero three/R3F
// imports so they unit-test cleanly without dragging the whole SpotLight/cone component
// (and its three dependency) into vitest. Searchlight.tsx owns all the stateful R3F wiring
// and the per-frame allocation-free driving; this file is stateless helpers + one small
// mutable spring state object.

/**
 * Convert intuitive spring feel (chase frequency + damping ratio) into the raw stiffness
 * `k` and damping `c` coefficients the integrator below uses.
 *
 *   ω (angular frequency) = 2π·freqHz          — how fast the light chases the player
 *   k (stiffness)         = ω²
 *   c (damping)           = 2·ζ·ω              — ζ (dampingRatio): <1 under-damped (overshoots),
 *                                                1 critically damped (fastest, no overshoot),
 *                                                >1 over-damped (sluggish, no overshoot)
 *
 * The searchlight wants ζ slightly under 1 (~0.6) so the beam lags the player, then
 * slightly overshoots and settles — the "sweeping to catch you" read. Settle time is
 * roughly 4/(ζ·ω); freqHz ≈ 1.4 / ζ ≈ 0.6 lands a ~0.5–0.8 s settle.
 */
export function springConstants(freqHz: number, dampingRatio: number): { k: number; c: number } {
  const omega = 2 * Math.PI * freqHz;
  return { k: omega * omega, c: 2 * dampingRatio * omega };
}

/** Mutable per-axis spring state: current position + velocity for x/y/z. Searchlight.tsx
 * keeps one of these in a ref and steps it every frame toward the player's pose. */
export interface SpringVec3 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export function createSpringVec3(): SpringVec3 {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

/** Hard-snap the spring to a point with zero velocity — used when the heli (re)appears so
 * the beam starts locked on the player instead of lerping in from a stale origin. */
export function snapSpringVec3(s: SpringVec3, x: number, y: number, z: number): void {
  s.x = x;
  s.y = y;
  s.z = z;
  s.vx = 0;
  s.vy = 0;
  s.vz = 0;
}

// Semi-implicit (symplectic) Euler for one axis of a spring-damper: update velocity from
// the spring/damping force, THEN advance position with the new velocity. More stable than
// explicit Euler and cheap; the vec3 wrapper below sub-steps a large frame dt so a stutter
// (or a tab-refocus dt spike) can't make it blow up.
function stepAxis(p: number, v: number, target: number, k: number, c: number, h: number): [number, number] {
  const nv = v + (k * (target - p) - c * v) * h;
  return [p + nv * h, nv];
}

/**
 * Advance the spring toward (tx,ty,tz) by `dt` seconds, mutating `s` in place. `k`/`c` come
 * from springConstants(); `maxSubDt` caps each integration sub-step (e.g. 1/120 s) so a big
 * `dt` is split into several stable steps rather than integrated in one unstable jump.
 * Allocation-free hot path (the [p,v] tuples are stack-lived and JIT-friendly; no shared
 * state escapes).
 */
export function stepSpringVec3(
  s: SpringVec3,
  tx: number,
  ty: number,
  tz: number,
  dt: number,
  k: number,
  c: number,
  maxSubDt: number,
): void {
  if (dt <= 0) return;
  const step = maxSubDt > 0 ? maxSubDt : dt;
  let remaining = dt;
  while (remaining > 1e-9) {
    const h = remaining > step ? step : remaining;
    [s.x, s.vx] = stepAxis(s.x, s.vx, tx, k, c, h);
    [s.y, s.vy] = stepAxis(s.y, s.vy, ty, k, c, h);
    [s.z, s.vz] = stepAxis(s.z, s.vz, tz, k, c, h);
    remaining -= h;
  }
}

/** Result of intersecting the beam (heli → aim point) with the y=0 ground plane. */
export interface GroundHit {
  /** World XZ where the beam axis meets the ground. */
  readonly x: number;
  readonly z: number;
  /** Beam length from the heli apex to that ground point (m) — the cone height / spot
   * light throw distance. */
  readonly dist: number;
}

/**
 * Analytic ray→plane(y=0) intersection for the beam from the heli at (hx,hy,hz) toward the
 * aim point (tx,ty,tz). No physics raycast needed on flat ground (TDD: the map is a flat
 * slab; sloped-terrain beam projection is explicitly out of scope). Returns `null` when the
 * geometry is degenerate — heli at/below ground, or a beam that doesn't point downward
 * (aim at/above the heli) — so the caller can simply hide the beam that frame.
 */
export function beamGroundIntersectionY0(
  hx: number,
  hy: number,
  hz: number,
  tx: number,
  ty: number,
  tz: number,
): GroundHit | null {
  if (hy <= 0) return null; // heli not above the ground plane → no downward hit
  const dy = ty - hy;
  if (dy >= 0) return null; // beam points up/level → never meets y=0 below the heli
  // Param t along heli→aim where y reaches 0:  hy + t·dy = 0  →  t = -hy/dy = hy/(hy-ty).
  const t = -hy / dy;
  const x = hx + t * (tx - hx);
  const z = hz + t * (tz - hz);
  const dx = x - hx;
  const dz = z - hz;
  const dist = Math.sqrt(dx * dx + hy * hy + dz * dz); // vertical drop is exactly hy (ground y=0)
  return { x, z, dist };
}

/** Cone base radius (m) at the ground for a spot of the given half-angle thrown `dist`
 * metres. Trivial trig, but shared with the test so the cone footprint stays in lockstep
 * with the real SpotLight's angle. */
export function coneBaseRadius(dist: number, halfAngleRad: number): number {
  return Math.tan(halfAngleRad) * dist;
}
