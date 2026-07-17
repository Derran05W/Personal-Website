// Phase 17 Task 1 — the six-car roster's fully-resolved controller definitions.
//
// This is the resolve half of the grade→parameter mapping: it takes a car's abstract letter
// grades + massFactor (config/vehicles.ts PLAYER_CARS) and its per-car geometry/anti-flip/pitch
// overrides (config/carTuning.ts CAR_OVERRIDES) and produces a concrete, VEHICLE_TUNING-shaped
// controller-params object the RaycastVehicle drives, plus the run-scoped extras the player
// path needs (top-speed governor cap, engine-audio pitch, hp/massFactor passthrough).
//
// HARD INVARIANT (locked by definitions.test.ts): getCarDef('rustySedan').controller must equal
// the signed-off VEHICLE_TUNING field-for-field — the M1 user-gate feel must not drift. It is
// guaranteed two ways: (1) getCarDef returns the VEHICLE_TUNING reference itself for the sedan
// (so the sedan stays leva-live AND the invariant is byte-exact by construction), and (2) the
// pure resolver is independently calibrated to REPRODUCE VEHICLE_TUNING for the sedan (every
// sedan factor is ×1.0 / ×√1 / a direct reference), proven by a second test — so the grade
// system is honest, not a special-case shim.
//
// Mass model: kg = massFactor × VEHICLE_TUNING.chassis.massKg (1200). Engine + reverse force
// scale with massFactor (full mass compensation → grade == felt acceleration); brake force with
// √massFactor (heavy cars keep braking but proportionally weaker → ponderous); suspension
// stiffness/damping/force + downforce with massFactor (so heavy cars don't bottom out or launch).

import { getGameState } from '../state/store';
import {
  ACCEL_FORCE_SCALE,
  CAR_OVERRIDES,
  HANDLING_SCALE,
  SPEED_TOP_SPEED_MPS,
  type CarOverride,
} from '../config/carTuning';
import { PLAYER_CARS, VEHICLE_TUNING, type PlayerCarId, type StatGrade } from '../config/vehicles';

/**
 * A car's resolved controller parameters — the SAME shape as VEHICLE_TUNING (the sedan's
 * signed-off block), so vehicles/raycastVehicle.ts can consume either interchangeably (it
 * defaults to VEHICLE_TUNING for AI-unit reuse, and the player injects one of these). Widened
 * to number/boolean leaves (VEHICLE_TUNING's own type carries literal types, which resolved
 * arithmetic can't satisfy).
 */
export interface ControllerParams {
  readonly chassis: {
    readonly halfWidth: number;
    readonly halfHeight: number;
    readonly halfLength: number;
    readonly massKg: number;
    readonly comYOffset: number;
  };
  readonly engine: {
    readonly maxForce: number;
    readonly reverseForce: number;
    readonly brakeForce: number;
    readonly handbrakeForce: number;
    readonly handbrakeRearFrictionMul: number;
    readonly brakeToReverseSpeed: number;
    readonly reverseSpeedCapPct: number;
  };
  readonly steering: {
    readonly maxAngleDeg: number;
    readonly highSpeedAngleDeg: number;
    readonly rateDegPerSec: number;
    readonly returnRateDegPerSec: number;
    readonly invertInReverse: boolean;
  };
  readonly suspension: {
    readonly restLength: number;
    readonly maxTravel: number;
    readonly stiffness: number;
    readonly compressionDamping: number;
    readonly relaxationDamping: number;
    readonly maxForce: number;
  };
  readonly wheels: {
    readonly radius: number;
    readonly halfTrack: number;
    readonly frontZ: number;
    readonly rearZ: number;
    readonly connectionY: number;
    readonly frictionSlip: number;
    readonly sideFrictionStiffness: number;
  };
  readonly stability: {
    readonly angularDamping: number;
    readonly linearDamping: number;
    readonly downforcePerSpeed: number;
  };
  readonly safety: {
    readonly triggerY: number;
    readonly liftToY: number;
  };
}

/** Everything a run needs to build + present one player car. */
export interface CarDefinition {
  readonly id: PlayerCarId;
  readonly name: string;
  readonly stats: { readonly speed: StatGrade; readonly accel: StatGrade; readonly handling: StatGrade };
  /** Full hit points (also the damage/visual max-HP source of truth — fx/damageStates.ts). */
  readonly hp: number;
  /** Collision mass multiplier over the 1200 kg reference (ram/explosion/crush paths, Task 3). */
  readonly massFactor: number;
  readonly character: string;
  /** Resolved Rapier-vehicle params (VEHICLE_TUNING shape). */
  readonly controller: ControllerParams;
  /** Top-speed governor cap (m/s) — from the SPEED grade. */
  readonly topSpeed: number;
  /** Synthesized-engine base pitch multiplier (audio/synth.ts buildEngine). */
  readonly enginePitch: number;
}

/**
 * Pure grade→param resolve. Combines PLAYER_CARS grades + massFactor with the car's CAR_OVERRIDES
 * geometry over the VEHICLE_TUNING baseline. Exported for the invariance test (resolving the
 * sedan must reproduce VEHICLE_TUNING exactly). Reads VEHICLE_TUNING / the grade tables FRESH on
 * each call, so a leva edit to either applies on the next resolve (i.e. the next player remount).
 */
export function resolveControllerParams(id: PlayerCarId): ControllerParams {
  const car = PLAYER_CARS[id];
  const ov: CarOverride = CAR_OVERRIDES[id];
  const mf = car.massFactor;

  const accelScale = ACCEL_FORCE_SCALE[car.accel];
  const handling = HANDLING_SCALE[car.handling];
  const base = VEHICLE_TUNING;

  // Steering: grade-scaled off the sedan baseline, unless the car spells out an explicit clamp
  // (Red Rocket's boat turn). Rates come from the grade even when the clamp is overridden only
  // if no override is given — the override, when present, fully replaces all four steer fields.
  const steering = ov.steering ?? {
    maxAngleDeg: base.steering.maxAngleDeg * handling.steerClamp,
    highSpeedAngleDeg: base.steering.highSpeedAngleDeg * handling.steerClamp,
    rateDegPerSec: base.steering.rateDegPerSec * handling.steerRate,
    returnRateDegPerSec: base.steering.returnRateDegPerSec * handling.steerRate,
  };

  return {
    chassis: {
      halfWidth: ov.chassis.halfWidth,
      halfHeight: ov.chassis.halfHeight,
      halfLength: ov.chassis.halfLength,
      massKg: base.chassis.massKg * mf,
      comYOffset: ov.chassis.comYOffset,
    },
    engine: {
      // Force scales with accel grade AND mass (full compensation — see file header).
      maxForce: base.engine.maxForce * accelScale * mf,
      reverseForce: base.engine.reverseForce * accelScale * mf,
      // Brake scales with √mass: heavy cars still brake, but proportionally weaker (ponderous).
      brakeForce: base.engine.brakeForce * Math.sqrt(mf),
      handbrakeForce: base.engine.handbrakeForce,
      handbrakeRearFrictionMul: base.engine.handbrakeRearFrictionMul,
      brakeToReverseSpeed: base.engine.brakeToReverseSpeed,
      reverseSpeedCapPct: base.engine.reverseSpeedCapPct,
    },
    steering: {
      maxAngleDeg: steering.maxAngleDeg,
      highSpeedAngleDeg: steering.highSpeedAngleDeg,
      rateDegPerSec: steering.rateDegPerSec,
      returnRateDegPerSec: steering.returnRateDegPerSec,
      invertInReverse: base.steering.invertInReverse,
    },
    suspension: {
      restLength: ov.suspension.restLength,
      maxTravel: ov.suspension.maxTravel,
      // Stiffness/damping/force scale with mass so a heavy car sits at the right height and
      // stays critically-ish damped (c ∝ √(k·m) ∝ massFactor here) rather than bottoming out.
      stiffness: base.suspension.stiffness * mf,
      compressionDamping: base.suspension.compressionDamping * mf,
      relaxationDamping: base.suspension.relaxationDamping * mf,
      maxForce: base.suspension.maxForce * mf,
    },
    wheels: {
      radius: ov.wheels.radius,
      halfTrack: ov.wheels.halfTrack,
      frontZ: ov.wheels.frontZ,
      rearZ: ov.wheels.rearZ,
      connectionY: ov.wheels.connectionY,
      // Grip scales with the handling grade.
      frictionSlip: base.wheels.frictionSlip * handling.grip,
      sideFrictionStiffness: base.wheels.sideFrictionStiffness * handling.grip,
    },
    stability: {
      angularDamping: ov.angularDamping,
      linearDamping: base.stability.linearDamping,
      // More mass → more downforce so tall/heavy cars stay planted at speed.
      downforcePerSpeed: base.stability.downforcePerSpeed * mf,
    },
    safety: {
      triggerY: base.safety.triggerY,
      liftToY: base.safety.liftToY,
    },
  };
}

/**
 * The car's full definition. The STARTER (rustySedan) returns the VEHICLE_TUNING object BY
 * REFERENCE as its controller — so the signed-off sedan stays leva-live (the dev panel mutates
 * VEHICLE_TUNING in place and the controller reads it fresh each step) and the M1 invariant is
 * byte-exact by construction. Every other car resolves a fresh snapshot from the grade tables.
 */
export function getCarDef(id: PlayerCarId): CarDefinition {
  const car = PLAYER_CARS[id];
  const controller: ControllerParams = id === 'rustySedan' ? VEHICLE_TUNING : resolveControllerParams(id);
  return {
    id,
    name: car.name,
    stats: { speed: car.speed, accel: car.accel, handling: car.handling },
    hp: car.hp,
    massFactor: car.massFactor,
    character: car.character,
    controller,
    topSpeed: SPEED_TOP_SPEED_MPS[car.speed],
    enginePitch: CAR_OVERRIDES[id].enginePitch,
  };
}

/** The car the next/current run drives (state/store.ts selectedCarId). Non-reactive one-shot
 *  read — callers that must re-resolve on a car change remount (index.tsx keys the player mount
 *  on the selected car); this is not for per-frame use. */
export function getSelectedCarDef(): CarDefinition {
  return getCarDef(getGameState().selectedCarId);
}
