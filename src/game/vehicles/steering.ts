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

export interface FallThroughSafety {
  /** Chassis-center world Y below which the car is deemed to have punched through the
   * ground (below the ground plane at y=0, unreachable while driving on top of it). */
  readonly triggerY: number;
  /** World Y to lift a caught chassis back to — just above the ~0.837 m settle height, so
   * the wheel-ray suspension re-engages immediately without a bounce. */
  readonly liftToY: number;
}

export interface FallThroughCorrection {
  /** Whether the chassis had fallen through and needs correcting this step. */
  readonly caught: boolean;
  /** Chassis Y to write when caught (else the input Y, unchanged). */
  readonly y: number;
  /** Vertical velocity to write when caught — any downward motion arrested (else input vy). */
  readonly vy: number;
}

/**
 * Fall-through safety catch (Phase 6, wave-2 physics session). Belt-and-suspenders behind the
 * primary defenses (the chassis↔GROUND cuboid collision + CCD, which a headless Rapier
 * reproduction proved already stop the car dead under a stall). If the chassis center has
 * nonetheless dropped below `triggerY` — i.e. it is fully submerged beneath the ground plane,
 * which only happens if that primary backstop is somehow inactive — report a correction that
 * lifts it to `liftToY` and kills any downward velocity, so the suspension re-engages instead
 * of the car plummeting to the fell-out net (BOUNDARY.fellOutResetY).
 *
 * Pure number-in/number-out (no Rapier) so it unit-tests without the wasm module. Feel-neutral
 * by construction: the trigger sits below the ground surface, unreachable in normal play (the
 * deepest a stalled-but-grounded chassis dips is ≈0.32 m — well above 0), so this never fires
 * while the car is driving and cannot alter the M1-signed-off feel.
 */
export function fallThroughCatch(y: number, vy: number, cfg: FallThroughSafety): FallThroughCorrection {
  if (y < cfg.triggerY) {
    return { caught: true, y: cfg.liftToY, vy: vy < 0 ? 0 : vy };
  }
  return { caught: false, y, vy };
}
