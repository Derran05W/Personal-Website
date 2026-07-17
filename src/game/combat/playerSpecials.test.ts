import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  crushContactCivHandle,
  isMonsterTruckSelected,
  playerSideHandle,
  retainPlanarVelocity,
  selectedCarMassFactor,
} from './playerSpecials';
import { SPECIALS } from '../config/specials';
import { PLAYER_CARS } from '../config/vehicles';
import type { EntityEntry } from '../world/registry';
import type { ImpactRecord } from './types';
import { getGameState, useGameStore } from '../state/store';

// --- fixtures --------------------------------------------------------------------------------

const PLAYER: EntityEntry = { kind: 'player', districtId: -1 };
const CIV: EntityEntry = { kind: 'civilian', districtId: -1, hp: 30 };
const BUILDING: EntityEntry = { kind: 'building', districtId: 0 };

function rec(
  a: EntityEntry | undefined,
  b: EntityEntry | undefined,
  forceMag: number,
  aHandle = 11,
  bHandle = 22,
): ImpactRecord {
  return { aHandle, bHandle, a, b, forceMag };
}

const initialStoreState = useGameStore.getState();
beforeEach(() => useGameStore.setState(initialStoreState, true)); // resets selectedCarId → rustySedan
afterEach(() => useGameStore.setState(initialStoreState, true));

// --- selected-car policy ---------------------------------------------------------------------

describe('isMonsterTruckSelected / selectedCarMassFactor', () => {
  it('reflect the live store selection', () => {
    expect(isMonsterTruckSelected()).toBe(false); // default rustySedan
    expect(selectedCarMassFactor()).toBe(PLAYER_CARS.rustySedan.massFactor);

    getGameState().setSelectedCar('monsterTruck');
    expect(isMonsterTruckSelected()).toBe(true);
    expect(selectedCarMassFactor()).toBe(PLAYER_CARS.monsterTruck.massFactor);

    getGameState().setSelectedCar('schoolBus');
    expect(isMonsterTruckSelected()).toBe(false);
    expect(selectedCarMassFactor()).toBe(PLAYER_CARS.schoolBus.massFactor);
  });
});

// --- crush rule: selected car + contact kind → wreck decision ---------------------------------

describe('crushContactCivHandle (the crush decision)', () => {
  const min = SPECIALS.monsterCrush.minForceN;

  it('returns the CIVILIAN side handle for a player↔civ contact at/above minForceN, either order', () => {
    expect(crushContactCivHandle(rec(PLAYER, CIV, min, 11, 22), min)).toBe(22);
    expect(crushContactCivHandle(rec(CIV, PLAYER, min, 33, 44), min)).toBe(33);
  });

  it('is a strict force gate: below minForceN there is no crush', () => {
    expect(crushContactCivHandle(rec(PLAYER, CIV, min - 1), min)).toBe(-1);
    expect(crushContactCivHandle(rec(PLAYER, CIV, min), min)).toBe(22); // AT the gate crushes
  });

  it('never crushes a non-civilian contact (buildings, props, other player-only hits)', () => {
    expect(crushContactCivHandle(rec(PLAYER, BUILDING, min * 10), min)).toBe(-1);
    expect(crushContactCivHandle(rec(PLAYER, undefined, min * 10), min)).toBe(-1);
  });

  it('requires the player on one side (a civ↔building contact is not a crush)', () => {
    expect(crushContactCivHandle(rec(CIV, BUILDING, min * 10), min)).toBe(-1);
  });
});

// --- plow gate: selected-car massFactor threshold ---------------------------------------------

describe('prop-plow mass gate (selectedCarMassFactor vs SPECIALS.propPlow.massFactorThreshold)', () => {
  const th = SPECIALS.propPlow.massFactorThreshold;

  it('heavy cars (bus / monster / Red Rocket) clear the gate; light cars do not', () => {
    const plows = (carId: keyof typeof PLAYER_CARS) => {
      getGameState().setSelectedCar(carId);
      return selectedCarMassFactor() >= th;
    };
    expect(plows('schoolBus')).toBe(true); // 2.6
    expect(plows('monsterTruck')).toBe(true); // 2.2
    expect(plows('redRocket')).toBe(true); // 3.0
    expect(plows('pickup')).toBe(false); // 1.4
    expect(plows('rustySedan')).toBe(false); // 1.0
    expect(plows('streetRacer')).toBe(false); // 0.8
  });
});

// --- player side resolution ------------------------------------------------------------------

describe('playerSideHandle', () => {
  it('returns the player side handle in either order, −1 when neither side is the player', () => {
    expect(playerSideHandle(rec(PLAYER, CIV, 100, 11, 22))).toBe(11);
    expect(playerSideHandle(rec(CIV, PLAYER, 100, 11, 22))).toBe(22);
    expect(playerSideHandle(rec(CIV, BUILDING, 100))).toBe(-1);
  });
});

// --- momentum-retention clamp ----------------------------------------------------------------

describe('retainPlanarVelocity (velocity-loss clamp)', () => {
  it('restores the retained speed along the PRE-contact direction when the car was slowed', () => {
    // pre = 10 m/s along +x; post = 3 m/s; retain 0.85 → restore to 8.5 m/s along +x.
    const out = retainPlanarVelocity({ x: 10, z: 0 }, { x: 3, z: 0 }, 0.85);
    expect(out).not.toBeNull();
    expect(out!.x).toBeCloseTo(8.5, 9);
    expect(out!.z).toBeCloseTo(0, 9);
  });

  it('keeps the pre-contact HEADING, not the post-contact one (diagonal pre-velocity)', () => {
    const pre = { x: 6, z: 8 }; // speed 10, dir (0.6, 0.8)
    const out = retainPlanarVelocity(pre, { x: 0, z: 1 }, 0.9);
    expect(out).not.toBeNull();
    expect(Math.hypot(out!.x, out!.z)).toBeCloseTo(9, 9);
    expect(out!.x).toBeCloseTo(5.4, 9); // 9 * 0.6
    expect(out!.z).toBeCloseTo(7.2, 9); // 9 * 0.8
  });

  it('never adds speed: a contact that barely slowed the car (or sped it up) is left alone', () => {
    expect(retainPlanarVelocity({ x: 10, z: 0 }, { x: 9.5, z: 0 }, 0.85)).toBeNull(); // 9.5 >= 8.5
    expect(retainPlanarVelocity({ x: 10, z: 0 }, { x: 12, z: 0 }, 0.85)).toBeNull();
  });

  it('returns null when there was no pre-contact momentum to preserve', () => {
    expect(retainPlanarVelocity({ x: 0, z: 0 }, { x: 0, z: 0 }, 0.85)).toBeNull();
  });
});
