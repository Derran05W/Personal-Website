// Pure, framework-free geometry/fade math for the skid-mark system (fx/SkidMarks.tsx).
// Kept in its own module — plain numbers, zero three/R3F imports — so the load-bearing
// bits (segment placement, the fade curve) unit-test cleanly without dragging the whole
// InstancedMesh component (and its three dependency) into vitest. SkidMarks.tsx owns all
// the stateful ring-buffer/allocation-free wiring; this file is stateless helpers only.

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Fade progress 0..1 for a mark of the given age (s) over `fadeSeconds`. 0 = fresh rubber,
 * 1 = fully dissolved into the ground colour (caller then hides the instance). Guards a
 * zero/negative fade window by returning 1 (instant fade) rather than dividing by zero.
 */
export function skidFadeProgress(age: number, fadeSeconds: number): number {
  if (fadeSeconds <= 0) return 1;
  return clamp01(age / fadeSeconds);
}

// --- lateral-slip trigger (Phase 16 Task 2) -------------------------------------------------
// Upgrades the mark/tire-smoke trigger from handbrake-only to "reward deliberate drifts, not
// gentle cornering" (part-file). Three small pure functions, composed by fx/SkidMarks.tsx each
// frame — kept separate rather than one do-everything function because each has a distinct
// job/testing shape: (1) project the chassis's world velocity onto its own heading to get a
// single-frame lateral speed reading, (2) low-pass that reading across frames so a one-frame
// contact-point/suspension spike can't fire the trigger, (3) gate + scale the (smoothed)
// reading into the bool/strength SkidMarks.tsx and the tireSmoke emitter actually consume.

/**
 * Signed lateral speed (m/s) of a chassis moving at world-space velocity (vx, vz) with the
 * given heading yaw (rad) — positive = drifting toward the chassis's own right side, zero =
 * moving exactly along (or against) its nose. `headingYaw` uses this project's +Z-forward,
 * `atan2(dx, dz)` convention (matches computeSkidSegment's yaw above and combat/hitscan.ts's
 * bulletDirection) so callers can derive it the same way a mark's own segment yaw is derived.
 * The chassis's local +X ("right") axis at that heading is (cos(yaw), 0, -sin(yaw)) — the same
 * yaw-about-Y rotation matrix bulletDirection's forward vector uses, just projecting onto the
 * perpendicular axis instead. Pure/testable.
 */
export function lateralSpeedAtYaw(vx: number, vz: number, headingYaw: number): number {
  const rightX = Math.cos(headingYaw);
  const rightZ = -Math.sin(headingYaw);
  return vx * rightX + vz * rightZ;
}

/**
 * One-pole low-pass filter step: blends `prev` toward `raw` by `alpha` (0..1 — higher tracks
 * faster / smooths less; 1 = no smoothing, immediately snaps to `raw`). Generic (not slip-
 * specific) — used to damp a single-frame lateral-speed spike (a curb tap, a suspension
 * settle jolt) so the slip trigger reads sustained sideways motion, not noise. Pure/testable.
 */
export function smoothSlip(prev: number, raw: number, alpha: number): number {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return prev + (raw - prev) * a;
}

/** The mark/tire-smoke trigger's gate + strength. */
export interface SlipState {
  /** True while a rear-wheel slide should paint marks / smoke — handbrake held OR the
   * (already-smoothed) lateral speed clears `thresholdMps`. */
  readonly slipping: boolean;
  /** 0..1 strength ramp from `thresholdMps` (0) to `maxMps` (1), driven purely by the
   * measured slide — NOT forced to 1 just because the handbrake is held, so a handbrake
   * pivot with little real sideways speed still ramps smoke in rather than popping to full
   * intensity immediately. Feeds fx/particleFeed.ts's tireSmoke emitter `intensity`. */
  readonly slip01: number;
}

/**
 * Turns an already-smoothed lateral speed (see smoothSlip above) + handbrake state into the
 * skid trigger. `slipping` is true when the handbrake is held (the pre-existing path — kept
 * as a straight OR, per the part-file) OR `|lateralSpeedMps|` exceeds `thresholdMps` (a
 * deliberate, unassisted drift). `slip01` clamps the 0..1 ramp between `thresholdMps` and
 * `maxMps`; a degenerate `maxMps <= thresholdMps` falls back to a hard 0/1 step rather than
 * dividing by a non-positive range. Pure/testable.
 */
export function computeLateralSlip(
  lateralSpeedMps: number,
  handbrake: boolean,
  thresholdMps: number,
  maxMps: number,
): SlipState {
  const magnitude = Math.abs(lateralSpeedMps);
  const overThreshold = magnitude > thresholdMps;
  const range = maxMps - thresholdMps;
  const slip01 = range > 0 ? clamp01((magnitude - thresholdMps) / range) : overThreshold ? 1 : 0;
  return { slipping: handbrake || overThreshold, slip01 };
}

export interface SkidSegment {
  /** Midpoint between the previous and current wheel ground point (world XZ). */
  readonly midX: number;
  readonly midZ: number;
  /** Yaw about world +Y (rad) that aligns a quad's local +Z (length axis) with the
   * travel direction. atan2(dx, dz) because +Z is forward in this project's frame. */
  readonly yaw: number;
  /** Segment length (m) — the distance travelled since the last emit, clamped to
   * `maxLength` so one over-long frame can't stretch a single quad. */
  readonly length: number;
}

/**
 * Solve the transform for one skid quad spanning the wheel's previous ground point
 * (a) → current ground point (b), in world XZ. The quad is centred on the midpoint,
 * oriented along a→b, and length-clamped. Width is applied by the caller (SKID.markWidth);
 * a degenerate a===b yields yaw 0 (atan2(0,0)) and length 0, which the caller never emits.
 */
export function computeSkidSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  maxLength: number,
): SkidSegment {
  const dx = bx - ax;
  const dz = bz - az;
  const rawLength = Math.hypot(dx, dz);
  return {
    midX: (ax + bx) * 0.5,
    midZ: (az + bz) * 0.5,
    yaw: Math.atan2(dx, dz),
    length: rawLength < maxLength ? rawLength : maxLength,
  };
}
