// Pure driving-feel math, split out of raycastVehicle.ts so the fun-gate curves can be
// unit-tested without instantiating Rapier (importing the controller pulls in the wasm
// module). No three.js / rapier imports here — only numbers in, numbers out. Callers read
// the (leva-live) VEHICLE_TUNING fresh each physics step and pass the values in.

const DEG2RAD = Math.PI / 180;

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Move `current` toward `target` by at most `maxDelta`, never overshooting. */
export function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export interface SteerLimits {
  /** Max steer angle at standstill (degrees). */
  readonly maxAngleDeg: number;
  /** Steer angle allowed at top speed (degrees) — the eased-down limit. */
  readonly highSpeedAngleDeg: number;
}

/**
 * Speed-scaled steer clamp (radians): full `maxAngleDeg` at a standstill, easing linearly
 * to `highSpeedAngleDeg` once |speed| reaches `topSpeed`. This is what keeps the car twitchy
 * and tight in parking-lot maneuvers but stable at speed (TDD §7).
 */
export function steerClampRad(speed: number, topSpeed: number, limits: SteerLimits): number {
  const t = clamp01(Math.abs(speed) / topSpeed);
  const deg = limits.maxAngleDeg + (limits.highSpeedAngleDeg - limits.maxAngleDeg) * t;
  return deg * DEG2RAD;
}

export interface SteerRates {
  /** How fast the wheel chases a growing steer target, deg/s. */
  readonly rateDegPerSec: number;
  /** How fast the wheel returns toward center, deg/s (usually faster — snappy recenter). */
  readonly returnRateDegPerSec: number;
}

export interface SteerTuning extends SteerLimits, SteerRates {}

/**
 * One physics step of steering: rate-limited chase of the current front-wheel angle toward
 * `inputSteer × speed-scaled clamp`. Uses `rateDegPerSec` while steering outward and the
 * faster `returnRateDegPerSec` when relaxing toward center (or crossing through it), so the
 * wheels snap back when the stick is released. Positive = steer right (matches DrivingInput).
 */
export function nextSteerAngle(
  current: number,
  inputSteer: number,
  speed: number,
  topSpeed: number,
  tuning: SteerTuning,
  dt: number,
): number {
  const target = inputSteer * steerClampRad(speed, topSpeed, tuning);
  // Returning toward center: target is closer to 0 than we are, or on the opposite side.
  const returning = Math.abs(target) < Math.abs(current) || target * current < 0;
  const rateDeg = returning ? tuning.returnRateDegPerSec : tuning.rateDegPerSec;
  return approach(current, target, rateDeg * DEG2RAD * dt);
}

/**
 * Throttle governor: engine force scales by this factor so drive force fades to 0 as forward
 * speed approaches `topSpeed` (STARTER_TOP_SPEED). A plain linear taper — enough to cap top
 * speed without a hard wall. Returns 1 when stationary or reversing (negative forwardSpeed),
 * so you always have full launch force available.
 */
export function throttleGovernor(forwardSpeed: number, topSpeed: number): number {
  return clamp01(1 - Math.max(forwardSpeed, 0) / topSpeed);
}
