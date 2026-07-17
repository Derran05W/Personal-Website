import { afterEach, describe, expect, it } from 'vitest';
import { getCarDef, getSelectedCarDef, resolveControllerParams } from './definitions';
import { getGameState } from '../state/store';
import { PLAYER_CARS, VEHICLE_TUNING, type PlayerCarId } from '../config/vehicles';
import {
  ACCEL_FORCE_SCALE,
  HANDLING_SCALE,
  SPEED_TOP_SPEED_MPS,
} from '../config/carTuning';

const ALL_IDS = Object.keys(PLAYER_CARS) as PlayerCarId[];

afterEach(() => {
  // getSelectedCarDef reads the shared store — restore the default so tests don't bleed.
  getGameState().setSelectedCar('rustySedan');
});

describe('car definitions — the M1 sedan invariant', () => {
  // THE HARD INVARIANT. The signed-off Rusty Sedan feel must not drift through the grade layer:
  // getCarDef('rustySedan').controller must equal VEHICLE_TUNING field-for-field.
  it('getCarDef("rustySedan").controller deep-equals the signed-off VEHICLE_TUNING', () => {
    expect(getCarDef('rustySedan').controller).toEqual(VEHICLE_TUNING);
  });

  // ...and it is the SAME object reference, so the sedan stays leva-live (the dev panel mutates
  // VEHICLE_TUNING in place and the controller reads it fresh each physics step).
  it('the sedan controller is the live VEHICLE_TUNING reference (leva-live contract)', () => {
    expect(getCarDef('rustySedan').controller).toBe(VEHICLE_TUNING);
  });

  // The mapping itself is honest: running the sedan's grades + overrides through the pure
  // resolver REPRODUCES VEHICLE_TUNING exactly (not just the short-circuit) — so a drift in any
  // grade-table value or resolve formula the sedan touches fails here.
  it('resolveControllerParams("rustySedan") reproduces VEHICLE_TUNING through the mapping', () => {
    expect(resolveControllerParams('rustySedan')).toEqual(VEHICLE_TUNING);
  });
});

describe('car definitions — every roster id resolves', () => {
  it('resolves all six PLAYER_CARS ids to a well-formed definition', () => {
    for (const id of ALL_IDS) {
      const def = getCarDef(id);
      expect(def.id).toBe(id);
      expect(def.name).toBe(PLAYER_CARS[id].name);
      expect(def.hp).toBe(PLAYER_CARS[id].hp);
      expect(def.hp).toBeGreaterThan(0);
      expect(def.massFactor).toBe(PLAYER_CARS[id].massFactor);
      expect(def.topSpeed).toBeGreaterThan(0);
      expect(def.enginePitch).toBeGreaterThan(0);

      const c = def.controller;
      // Every leaf finite (no NaN/Infinity from a bad scale) and the load-bearing ones positive.
      const leaves = [
        c.chassis.halfWidth, c.chassis.halfHeight, c.chassis.halfLength, c.chassis.massKg, c.chassis.comYOffset,
        c.engine.maxForce, c.engine.reverseForce, c.engine.brakeForce,
        c.steering.maxAngleDeg, c.steering.highSpeedAngleDeg, c.steering.rateDegPerSec, c.steering.returnRateDegPerSec,
        c.suspension.restLength, c.suspension.maxTravel, c.suspension.stiffness,
        c.suspension.compressionDamping, c.suspension.relaxationDamping, c.suspension.maxForce,
        c.wheels.radius, c.wheels.halfTrack, c.wheels.frontZ, c.wheels.rearZ, c.wheels.connectionY,
        c.wheels.frictionSlip, c.wheels.sideFrictionStiffness,
        c.stability.angularDamping, c.stability.linearDamping, c.stability.downforcePerSpeed,
        c.safety.triggerY, c.safety.liftToY,
      ];
      for (const v of leaves) expect(Number.isFinite(v)).toBe(true);

      expect(c.chassis.massKg).toBeGreaterThan(0);
      expect(c.chassis.halfWidth).toBeGreaterThan(0);
      expect(c.chassis.halfLength).toBeGreaterThan(0);
      expect(c.engine.maxForce).toBeGreaterThan(0);
      expect(c.engine.brakeForce).toBeGreaterThan(0);
      expect(c.wheels.radius).toBeGreaterThan(0);
      expect(c.steering.maxAngleDeg).toBeGreaterThan(0);
    }
  });
});

describe('car definitions — grade tables are monotonic (A best → D worst)', () => {
  it('SPEED grade top speeds strictly descend A > B > C > D', () => {
    expect(SPEED_TOP_SPEED_MPS.A).toBeGreaterThan(SPEED_TOP_SPEED_MPS.B);
    expect(SPEED_TOP_SPEED_MPS.B).toBeGreaterThan(SPEED_TOP_SPEED_MPS.C);
    expect(SPEED_TOP_SPEED_MPS.C).toBeGreaterThan(SPEED_TOP_SPEED_MPS.D);
  });

  it('ACCEL grade force scales strictly descend A > B > C > D', () => {
    expect(ACCEL_FORCE_SCALE.A).toBeGreaterThan(ACCEL_FORCE_SCALE.B);
    expect(ACCEL_FORCE_SCALE.B).toBeGreaterThan(ACCEL_FORCE_SCALE.C);
    expect(ACCEL_FORCE_SCALE.C).toBeGreaterThan(ACCEL_FORCE_SCALE.D);
  });

  it('HANDLING grade steer-rate and grip strictly descend A > B > C > D', () => {
    expect(HANDLING_SCALE.A.steerRate).toBeGreaterThan(HANDLING_SCALE.B.steerRate);
    expect(HANDLING_SCALE.B.steerRate).toBeGreaterThan(HANDLING_SCALE.C.steerRate);
    expect(HANDLING_SCALE.C.steerRate).toBeGreaterThan(HANDLING_SCALE.D.steerRate);
    expect(HANDLING_SCALE.A.grip).toBeGreaterThan(HANDLING_SCALE.B.grip);
    expect(HANDLING_SCALE.B.grip).toBeGreaterThan(HANDLING_SCALE.C.grip);
    expect(HANDLING_SCALE.C.grip).toBeGreaterThan(HANDLING_SCALE.D.grip);
  });

  it('the Street Racer is the fastest car and the School Bus the slowest', () => {
    const tops = ALL_IDS.map((id) => getCarDef(id).topSpeed);
    expect(getCarDef('streetRacer').topSpeed).toBe(Math.max(...tops));
    expect(getCarDef('schoolBus').topSpeed).toBe(Math.min(...tops));
  });
});

describe('car definitions — mass model scales suspension so heavy cars are supported', () => {
  it('massKg is massFactor × 1200 for every car', () => {
    for (const id of ALL_IDS) {
      expect(getCarDef(id).controller.chassis.massKg).toBeCloseTo(1200 * PLAYER_CARS[id].massFactor, 6);
    }
  });

  it('suspension stiffness / damping / force scale with mass (never negative or absurd)', () => {
    for (const id of ALL_IDS) {
      const mf = PLAYER_CARS[id].massFactor;
      const s = getCarDef(id).controller.suspension;
      expect(s.stiffness).toBeCloseTo(VEHICLE_TUNING.suspension.stiffness * mf, 6);
      expect(s.compressionDamping).toBeCloseTo(VEHICLE_TUNING.suspension.compressionDamping * mf, 6);
      expect(s.relaxationDamping).toBeCloseTo(VEHICLE_TUNING.suspension.relaxationDamping * mf, 6);
      expect(s.maxForce).toBeCloseTo(VEHICLE_TUNING.suspension.maxForce * mf, 6);
      // Sanity bounds: positive, finite, and not runaway (a 3× car stays well under 10× the sedan).
      for (const v of [s.stiffness, s.compressionDamping, s.relaxationDamping, s.maxForce, s.restLength, s.maxTravel]) {
        expect(v).toBeGreaterThan(0);
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(s.stiffness).toBeLessThan(VEHICLE_TUNING.suspension.stiffness * 10);
    }
  });

  it('the heaviest car has stiffer suspension and more engine force than the sedan', () => {
    const bus = getCarDef('schoolBus').controller;
    const sedan = getCarDef('rustySedan').controller;
    expect(bus.suspension.stiffness).toBeGreaterThan(sedan.suspension.stiffness);
    expect(bus.engine.maxForce).toBeGreaterThan(sedan.engine.maxForce);
    // …but proportionally weaker brakes (√mass) — ponderous, "smashes without slowing".
    expect(bus.engine.brakeForce / bus.chassis.massKg).toBeLessThan(
      sedan.engine.brakeForce / sedan.chassis.massKg,
    );
  });
});

describe('car definitions — signature feels', () => {
  it('the Red Rocket turns like a boat (tiny steer clamp vs the sedan)', () => {
    const rocket = getCarDef('redRocket').controller.steering;
    expect(rocket.maxAngleDeg).toBeLessThan(VEHICLE_TUNING.steering.maxAngleDeg / 2);
    expect(rocket.rateDegPerSec).toBeLessThan(VEHICLE_TUNING.steering.rateDegPerSec);
  });

  it('engine pitch descends with size (racer bright, sedan 1, bus/streetcar deep)', () => {
    expect(getCarDef('streetRacer').enginePitch).toBeGreaterThan(1);
    expect(getCarDef('rustySedan').enginePitch).toBe(1);
    expect(getCarDef('schoolBus').enginePitch).toBeLessThan(1);
    expect(getCarDef('redRocket').enginePitch).toBeLessThan(getCarDef('schoolBus').enginePitch);
  });
});

describe('getSelectedCarDef reads the store selection', () => {
  it('follows store.selectedCarId', () => {
    expect(getSelectedCarDef().id).toBe('rustySedan');
    getGameState().setSelectedCar('monsterTruck');
    expect(getSelectedCarDef().id).toBe('monsterTruck');
    expect(getSelectedCarDef().controller.wheels.radius).toBeCloseTo(0.62, 6);
  });
});
