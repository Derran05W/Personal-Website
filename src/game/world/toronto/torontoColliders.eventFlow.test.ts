// Phase 29 T1 — event-flow proofs for the Toronto registry entries (torontoColliders.ts),
// using the SAME idioms combat/damage.test.ts already exercises against synthetic EntityEntry
// objects (applyEntityDamage direct-call, gameEvents listeners) — no live Rapier/WebGL mount
// needed, since applyEntityDamage/gameEvents are the entire "impact resolved -> event fires"
// surface combat/contacts.ts's dispatch ultimately drives.
//
// Two chains proven end-to-end:
//   1. power-box -> transformerDestroyed -> powergrid/grid.ts marks the district dark (the
//      district-blackout entry point D2 asked for).
//   2. parked-car -> propDestroyed{archetype:'parkedCar'} -> state/heat.ts's civHit heat mapping
//      (the "impact -> prop destroyed -> score" chain for Toronto, since the general fixed->
//      dynamic swap visual doesn't apply here — see torontoColliders.ts's file header).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEntityDamage } from '../../combat/damage';
import { gameEvents } from '../../state/events';
import { getGameState, useGameStore } from '../../state/store';
import { initHeatSystem, __resetPassiveAccumulatorForTest } from '../../state/heat';
import { gridRef, initPowerGrid, __resetGridForTest } from '../../powergrid/grid';
import { clearFlickers } from '../../powergrid/emitters';
import { HEAT } from '../../config/heat';
import { POWER_GRID, PROPS } from '../../config';
import { torontoParkedCarEntry, torontoTransformerEntry } from './torontoColliders';

vi.mock('../../powergrid/emitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../powergrid/emitters')>();
  return { ...actual, blackoutDistrict: vi.fn(actual.blackoutDistrict) };
});

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialStoreState, true);
  __resetGridForTest();
  clearFlickers();
  __resetPassiveAccumulatorForTest();
});

afterEach(() => {
  gameEvents.clearAllListeners();
  useGameStore.setState(initialStoreState, true);
  __resetGridForTest();
  clearFlickers();
});

describe('power-box -> transformerDestroyed -> district blackout', () => {
  it('draining a power-box entry to 0 hp emits transformerDestroyed with its districtId', () => {
    const entry = torontoTransformerEntry('financial'); // hp = POWER_GRID.transformerHp
    const listener = vi.fn();
    gameEvents.on('transformerDestroyed', listener);

    applyEntityDamage(entry, POWER_GRID.transformerHp); // exactly lethal

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ districtId: entry.districtId }));
    expect(entry.hp).toBe(0);
  });

  it('a sub-lethal hit does not fire the event (hp survives, no double-kill)', () => {
    const entry = torontoTransformerEntry('kingWest');
    const listener = vi.fn();
    gameEvents.on('transformerDestroyed', listener);

    applyEntityDamage(entry, POWER_GRID.transformerHp - 1);
    expect(listener).not.toHaveBeenCalled();
    expect(entry.hp).toBe(1);
  });

  it('feeds powergrid/grid.ts end-to-end: the district goes dark once the box dies', () => {
    const off = initPowerGrid(15); // Toronto district count (world/toronto/districts.ts)
    const entry = torontoTransformerEntry('harbourfront');

    applyEntityDamage(entry, POWER_GRID.transformerHp);

    expect(gridRef.current.lit[entry.districtId]).toBe(false);
    off();
  });
});

describe('parked car -> propDestroyed{parkedCar} -> heat/score', () => {
  it('draining a parked-car entry to 0 hp emits propDestroyed{archetype: parkedCar}', () => {
    const entry = torontoParkedCarEntry('queenWest'); // hp = PROPS.parkedCarHp
    const listener = vi.fn();
    gameEvents.on('propDestroyed', listener);

    applyEntityDamage(entry, PROPS.parkedCarHp);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ archetype: 'parkedCar' }));
    expect(entry.hp).toBe(0);
  });

  it('propDestroyed{parkedCar} adds HEAT.events.civHit heat via state/heat.ts (the scoring path)', () => {
    const off = initHeatSystem();
    const before = getGameState().heat;
    const entry = torontoParkedCarEntry('stLawrence');

    applyEntityDamage(entry, PROPS.parkedCarHp);

    expect(getGameState().heat).toBe(before + HEAT.events.civHit);
    off();
  });

  it('a cone entry (no hp) never reaches propDestroyed via applyEntityDamage (no score this phase)', () => {
    const listener = vi.fn();
    gameEvents.on('propDestroyed', listener);
    // torontoConeEntry() has no hp — applyEntityDamage is a documented no-op for it.
    const entry = { kind: 'propDynamic' as const, districtId: -1 };
    applyEntityDamage(entry, 9999);
    expect(listener).not.toHaveBeenCalled();
  });
});
