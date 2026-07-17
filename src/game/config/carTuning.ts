// Phase 17 Task 1 — the six-car grade→parameter mapping layer's DATA.
//
// This module holds two things and NO resolve logic (that lives in
// vehicles/definitions.ts, which combines these tables into a full VEHICLE_TUNING-shaped
// controller-param object per car):
//
//   1. Three grade tables (SPEED / ACCEL / HANDLING) keyed by the TDD §5.9 letter grades.
//      A car's speed/accel/handling letters (config/vehicles.ts PLAYER_CARS) index these
//      to get its top speed, engine-force scale, and steering/grip scales. The tables are
//      calibrated so the STARTER — Rusty Sedan (speed C, accel C, handling B) — resolves to
//      the signed-off VEHICLE_TUNING values EXACTLY (every sedan factor here is 1.0 / a
//      direct reference, so the resolver reproduces the M1 gate byte-for-byte; locked by a
//      vitest in definitions.test.ts).
//
//   2. CAR_OVERRIDES — per-car EXACT chassis + wheel geometry (widths, wheelbase, wheel
//      radius, ride height) plus the two things that are physically per-car, not graded:
//      anti-flip angular damping and the audio enginePitch. Geometry is NOT graded — a bus
//      is 9 m long regardless of its handling letter — so it is spelled out here as literals
//      (the sedan's block references VEHICLE_TUNING so it can never drift from the source).
//
// WHY scales-over-a-shared-baseline (not absolute per-car numbers): it keeps the sedan the
// single reference the whole roster is expressed against, so the M1-signed-off feel is the
// literal origin of the coordinate system and the invariant test is meaningful.
//
// Mass: a car's kg = massFactor × VEHICLE_TUNING.chassis.massKg (1200). Engine force, brake
// force, suspension stiffness/damping/force, and downforce all scale off massFactor in the
// resolver so heavy cars don't bottom out or feel identical to the sedan — see definitions.ts.

import { type StatGrade, STARTER_TOP_SPEED, VEHICLE_TUNING } from './vehicles';

// --- Grade tables ---------------------------------------------------------------------------

/**
 * Top speed (m/s) by SPEED grade — the governor cap the player controller fades engine force
 * to (vehicles/steering.ts throttleGovernor) and the reference speed the steer clamp eases
 * against. C is the STARTER baseline (= STARTER_TOP_SPEED = the sedan's signed-off top speed),
 * so the sedan's top speed is unchanged; A clearly out-runs police overdrive (105% ≈ 26.25),
 * D is a slow heavy-vehicle crawl.
 */
export const SPEED_TOP_SPEED_MPS: Record<StatGrade, number> = {
  A: 32,
  B: 28,
  C: STARTER_TOP_SPEED,
  D: 19,
};

/**
 * Engine-force multiplier by ACCEL grade, applied over VEHICLE_TUNING.engine.maxForce. The
 * resolver ALSO multiplies by massFactor (full mass compensation), so this scale IS the felt
 * acceleration regardless of the car's weight — a "C accel" pickup launches like the sedan
 * even at 1.4× mass; heaviness reads through top speed / braking / steering / collisions
 * instead, not through a mushy throttle. C = 1.0 keeps the sedan exact.
 */
export const ACCEL_FORCE_SCALE: Record<StatGrade, number> = {
  A: 1.35,
  B: 1.12,
  C: 1.0,
  D: 0.78,
};

/** Steering + grip scales by HANDLING grade, applied over the sedan's steering/wheel-friction
 *  baseline (VEHICLE_TUNING.steering / .wheels). `steerClamp` scales the max + high-speed steer
 *  angles, `steerRate` the chase/return rates, `grip` both frictionSlip and sideFrictionStiffness.
 *  B = all 1.0 keeps the sedan exact. (The Red Rocket's boat-turn is a per-car steering OVERRIDE
 *  on top of its D grade — a normal D bus shouldn't turn as absurdly as an 11 m streetcar.) */
export interface HandlingScale {
  readonly steerClamp: number;
  readonly steerRate: number;
  readonly grip: number;
}
export const HANDLING_SCALE: Record<StatGrade, HandlingScale> = {
  A: { steerClamp: 1.05, steerRate: 1.2, grip: 1.2 },
  B: { steerClamp: 1.0, steerRate: 1.0, grip: 1.0 },
  C: { steerClamp: 0.92, steerRate: 0.9, grip: 0.95 },
  D: { steerClamp: 0.82, steerRate: 0.72, grip: 0.82 },
};

// --- Per-car geometry + anti-flip + engine pitch overrides ----------------------------------

/** Optional explicit steer-angle override (replaces the grade-derived steering). Used only by
 *  the Red Rocket, whose comically small clamp + slow rate is what "turns like a boat" means. */
export interface SteeringOverride {
  readonly maxAngleDeg: number;
  readonly highSpeedAngleDeg: number;
  readonly rateDegPerSec: number;
  readonly returnRateDegPerSec: number;
}

export interface CarOverride {
  /** Cuboid half-extents (m) + dropped COM. massKg is NOT here — it is massFactor × 1200. */
  readonly chassis: {
    readonly halfWidth: number;
    readonly halfHeight: number;
    readonly halfLength: number;
    /** Center-of-mass Y offset below the collider center (arcade anti-flip). Dropped harder on
     *  tall/top-heavy cars (bus, monster, streetcar). */
    readonly comYOffset: number;
  };
  /** Wheel radius + chassis-local connection geometry. friction is graded, so it is NOT here. */
  readonly wheels: {
    readonly radius: number;
    readonly halfTrack: number;
    readonly frontZ: number;
    readonly rearZ: number;
    /** Connection point below the chassis center. Dropped LOW on the monster truck so the
     *  wheels hang far below the body → the chassis rides high (paired with a long restLength). */
    readonly connectionY: number;
  };
  /** Ride-height geometry. stiffness/damping/maxForce are mass-derived (resolver), NOT here. */
  readonly suspension: {
    readonly restLength: number;
    readonly maxTravel: number;
  };
  /** Chassis angular damping — the main arcade anti-flip. Raised on tall/heavy cars so the
   *  monster truck and streetcar don't tip; the sedan references its signed-off value. */
  readonly angularDamping: number;
  /** Per-car base pitch multiplier for the synthesized engine voice (audio/synth.ts). 1 = the
   *  sedan; <1 is deeper (bus/streetcar), >1 brighter (racer). Not a controller param. */
  readonly enginePitch: number;
  /** Red Rocket only: explicit tiny steer clamp (boat turn). Absent → grade-derived steering. */
  readonly steering?: SteeringOverride;
}

// Sedan geometry REFERENCES VEHICLE_TUNING so the resolver reproduces the signed-off values
// with zero duplicated literals to drift. Every other car spells out its own dimensions from
// the agreed mesh-task dims table (do not drift these without re-agreeing with the mesh task).
export const CAR_OVERRIDES = {
  // Rusty Sedan — the reference. 1.8 × 4.0 m, wheel r 0.34 (== VEHICLE_TUNING).
  rustySedan: {
    chassis: {
      halfWidth: VEHICLE_TUNING.chassis.halfWidth,
      halfHeight: VEHICLE_TUNING.chassis.halfHeight,
      halfLength: VEHICLE_TUNING.chassis.halfLength,
      comYOffset: VEHICLE_TUNING.chassis.comYOffset,
    },
    wheels: {
      radius: VEHICLE_TUNING.wheels.radius,
      halfTrack: VEHICLE_TUNING.wheels.halfTrack,
      frontZ: VEHICLE_TUNING.wheels.frontZ,
      rearZ: VEHICLE_TUNING.wheels.rearZ,
      connectionY: VEHICLE_TUNING.wheels.connectionY,
    },
    suspension: {
      restLength: VEHICLE_TUNING.suspension.restLength,
      maxTravel: VEHICLE_TUNING.suspension.maxTravel,
    },
    angularDamping: VEHICLE_TUNING.stability.angularDamping,
    enginePitch: 1.0,
  },
  // Street Racer — 1.7 × 3.9 m, LOW body (hh 0.30), small stiff wheels (r 0.32). Grippy + agile
  // (slightly freer yaw than the sedan). Glass cannon: fastest/snappiest, dies to anything.
  streetRacer: {
    chassis: { halfWidth: 0.85, halfHeight: 0.3, halfLength: 1.95, comYOffset: -0.22 },
    wheels: { radius: 0.32, halfTrack: 0.78, frontZ: 1.3, rearZ: -1.25, connectionY: -0.1 },
    suspension: { restLength: 0.32, maxTravel: 0.2 },
    angularDamping: 1.7,
    enginePitch: 1.35,
  },
  // Pickup — 2.0 × 4.6 m, hh 0.40, wheel r 0.38. Stable pusher, mild steer, planted COM.
  pickup: {
    chassis: { halfWidth: 1.0, halfHeight: 0.4, halfLength: 2.3, comYOffset: -0.28 },
    wheels: { radius: 0.38, halfTrack: 0.9, frontZ: 1.5, rearZ: -1.5, connectionY: -0.18 },
    suspension: { restLength: 0.44, maxTravel: 0.28 },
    angularDamping: 2.0,
    enginePitch: 0.9,
  },
  // School Bus — 2.4 × 9.0 m, tall (hh 0.55), long 6.3 m wheelbase, wheel r 0.42. Slow,
  // ponderous, immense; COM dropped hard + high angular damping so a 9 m box doesn't tip.
  schoolBus: {
    chassis: { halfWidth: 1.2, halfHeight: 0.55, halfLength: 4.5, comYOffset: -0.4 },
    wheels: { radius: 0.42, halfTrack: 1.05, frontZ: 3.1, rearZ: -3.2, connectionY: -0.22 },
    suspension: { restLength: 0.5, maxTravel: 0.3 },
    angularDamping: 2.6,
    enginePitch: 0.7,
  },
  // Monster Truck — 2.2 × 4.6 m, wheel r 0.62, HIGH clearance: a long restLength + a deep
  // connectionY hang the huge wheels far below the body so the chassis rides well above the
  // wheel tops (the crush task builds on this stance). Strong anti-flip for the tall COM.
  monsterTruck: {
    chassis: { halfWidth: 1.1, halfHeight: 0.45, halfLength: 2.3, comYOffset: -0.35 },
    wheels: { radius: 0.62, halfTrack: 1.15, frontZ: 1.55, rearZ: -1.6, connectionY: -0.45 },
    suspension: { restLength: 0.85, maxTravel: 0.45 },
    angularDamping: 3.0,
    enginePitch: 0.8,
  },
  // Red Rocket (streetcar) — 2.4 × 11.0 m, hh 0.60, wheel r 0.36 (hidden by a skirt — mesh
  // task's problem). Nearly unstoppable (3.0× mass, resolved in the collision paths, Task 3),
  // slow accel (D), and the signature boat turn: an explicit ~13° steer clamp with a slow rate,
  // way tighter than a normal D car, over an 8.6 m wheelbase → an enormous turning circle.
  redRocket: {
    chassis: { halfWidth: 1.2, halfHeight: 0.6, halfLength: 5.5, comYOffset: -0.42 },
    wheels: { radius: 0.36, halfTrack: 1.0, frontZ: 4.2, rearZ: -4.4, connectionY: -0.3 },
    suspension: { restLength: 0.46, maxTravel: 0.28 },
    angularDamping: 2.8,
    enginePitch: 0.6,
    steering: { maxAngleDeg: 13, highSpeedAngleDeg: 7, rateDegPerSec: 170, returnRateDegPerSec: 210 },
  },
} as const satisfies Record<string, CarOverride>;

/**
 * Aggregate the dev tuning panel (leva) auto-mounts from the CONFIG registry (config/index.ts).
 * ONLY the three grade tables live here — editing a leaf then remounting the player (garage
 * re-select / run reset re-runs getSelectedCarDef → re-resolves off these tables) applies it;
 * mid-run they don't re-resolve (the controller caches its params at spawn). CAR_OVERRIDES is
 * intentionally NOT here: it is structural geometry (needs a remount regardless), not a live knob.
 */
export const CAR_TUNING = {
  speedTopSpeedMps: SPEED_TOP_SPEED_MPS,
  accelForceScale: ACCEL_FORCE_SCALE,
  handlingScale: HANDLING_SCALE,
} as const;
