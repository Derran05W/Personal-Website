// Phase 31 T2 (D6) — playerCarPack.ts: model/tint mapping + the pure body-scale resolver.
import { describe, expect, it } from 'vitest';
import { getCityPackModel } from '../assets/cityPackManifest';
import { playerVariantId } from '../../../scripts/lib/cityPackPlayerCar.mjs';
import { CAR_OVERRIDES } from './carTuning';
import { VEHICLE_TUNING } from './vehicles';
import {
  PLAYER_CAR_PACK_MODEL,
  PLAYER_CAR_TINT,
  resolvePlayerCarBodyScale,
  targetWheelRadiusWu,
  type PlayerPackCarId,
} from './playerCarPack';

const PLAYER_PACK_CAR_IDS: readonly PlayerPackCarId[] = [
  'rustySedan',
  'streetRacer',
  'pickup',
  'schoolBus',
  'redRocket',
];

describe('PLAYER_CAR_PACK_MODEL — the 5 D6 swaps (monsterTruck excluded, stays in-house)', () => {
  it('maps every swapped car to a real, distinct manifest id', () => {
    const ids = Object.values(PLAYER_CAR_PACK_MODEL);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(() => getCityPackModel(id)).not.toThrow();
      expect(() => getCityPackModel(playerVariantId(id))).not.toThrow();
    }
  });

  it('matches the CLAUDE.md-directed mapping exactly', () => {
    expect(PLAYER_CAR_PACK_MODEL).toEqual({
      rustySedan: 'car-a',
      streetRacer: 'sports-car-a',
      pickup: 'pickup-truck',
      schoolBus: 'bus',
      redRocket: 'sports-car-b',
    });
  });

  it('does not include monsterTruck', () => {
    expect('monsterTruck' in PLAYER_CAR_PACK_MODEL).toBe(false);
  });
});

describe('PLAYER_CAR_TINT', () => {
  it('has a valid #rrggbb hex for every swapped car', () => {
    for (const carId of PLAYER_PACK_CAR_IDS) {
      expect(PLAYER_CAR_TINT[carId]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("rustySedan's tint is the rust hex (THE default car — CLAUDE.md locked override)", () => {
    expect(PLAYER_CAR_TINT.rustySedan).toBe('#a9502f');
  });
});

describe('resolvePlayerCarBodyScale — D6 "length matches the car\'s collider length"', () => {
  it('resolves a positive, finite scale for every swapped car', () => {
    for (const carId of PLAYER_PACK_CAR_IDS) {
      const scale = resolvePlayerCarBodyScale(carId);
      expect(scale, carId).toBeGreaterThan(0);
      expect(Number.isFinite(scale), carId).toBe(true);
    }
  });

  it('scaling the model native length by the resolved factor reproduces the car\'s own collider length exactly', () => {
    const targets: Record<PlayerPackCarId, number> = {
      rustySedan: VEHICLE_TUNING.chassis.halfLength * 2,
      streetRacer: CAR_OVERRIDES.streetRacer.chassis.halfLength * 2,
      pickup: CAR_OVERRIDES.pickup.chassis.halfLength * 2,
      schoolBus: CAR_OVERRIDES.schoolBus.chassis.halfLength * 2,
      redRocket: CAR_OVERRIDES.redRocket.chassis.halfLength * 2,
    };
    for (const carId of PLAYER_PACK_CAR_IDS) {
      const modelId = PLAYER_CAR_PACK_MODEL[carId];
      const nativeLength = getCityPackModel(playerVariantId(modelId)).nativeDims.d;
      const scale = resolvePlayerCarBodyScale(carId);
      expect(nativeLength * scale, carId).toBeCloseTo(targets[carId], 6);
    }
  });

  it("rustySedan's collider length is exactly the signed-off 4.0 m (VEHICLE_TUNING cross-check, mirrors cityPackScale.test.ts's CAR_REF idiom)", () => {
    const modelId = PLAYER_CAR_PACK_MODEL.rustySedan;
    const nativeLength = getCityPackModel(playerVariantId(modelId)).nativeDims.d;
    expect(nativeLength * resolvePlayerCarBodyScale('rustySedan')).toBeCloseTo(4.0, 6);
  });
});

describe('targetWheelRadiusWu', () => {
  it('matches each car\'s own physics wheel radius exactly', () => {
    expect(targetWheelRadiusWu('rustySedan')).toBe(VEHICLE_TUNING.wheels.radius);
    expect(targetWheelRadiusWu('streetRacer')).toBe(CAR_OVERRIDES.streetRacer.wheels.radius);
    expect(targetWheelRadiusWu('pickup')).toBe(CAR_OVERRIDES.pickup.wheels.radius);
    expect(targetWheelRadiusWu('schoolBus')).toBe(CAR_OVERRIDES.schoolBus.wheels.radius);
    expect(targetWheelRadiusWu('redRocket')).toBe(CAR_OVERRIDES.redRocket.wheels.radius);
  });

  it('is positive for every swapped car', () => {
    for (const carId of PLAYER_PACK_CAR_IDS) {
      expect(targetWheelRadiusWu(carId)).toBeGreaterThan(0);
    }
  });
});
