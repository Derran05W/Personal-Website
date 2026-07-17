// Phase 17: tests for the `carUnlocked` -> `unlockedCarIds` flow and `selectCar`'s
// interaction with it. Deliberately split out of store.test.ts: that file's own
// `afterEach` calls `gameEvents.clearAllListeners()` after EVERY test (correct for its
// pre-existing locally-registered handlers), which also permanently wipes
// state/store.ts's module-scope `carUnlocked` subscription (registered once, at
// store.ts's import time) the moment the first test in that file runs — there is no way
// to re-register it short of re-importing the module. This file has no such blanket
// cleanup, the same "preserve the production listener" idiom hud/gameOverRunEnd.ts's and
// hud/gameOverUnlocks.ts's test files already use.
import { beforeEach, describe, expect, it } from 'vitest';
import { gameEvents } from './events';
import { getGameState, useGameStore } from './store';

const initialState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
});

describe('carUnlocked subscription (Phase 17, module-scope)', () => {
  it('appends a newly unlocked car id, deduplicated against repeats', () => {
    gameEvents.emit('carUnlocked', { carId: 'schoolBus' });
    expect(useGameStore.getState().unlockedCarIds).toEqual(['rustySedan', 'schoolBus']);

    gameEvents.emit('carUnlocked', { carId: 'schoolBus' }); // repeat — must not duplicate
    expect(useGameStore.getState().unlockedCarIds).toEqual(['rustySedan', 'schoolBus']);
  });

  it('never removes a previously unlocked id', () => {
    gameEvents.emit('carUnlocked', { carId: 'monsterTruck' });
    gameEvents.emit('carUnlocked', { carId: 'redRocket' });
    expect(useGameStore.getState().unlockedCarIds).toEqual(['rustySedan', 'monsterTruck', 'redRocket']);
  });
});

describe('selectCar + carUnlocked integration (Phase 17)', () => {
  it('a car unlocked via carUnlocked immediately becomes selectable', () => {
    expect(useGameStore.getState().unlockedCarIds).not.toContain('pickup');

    gameEvents.emit('carUnlocked', { carId: 'pickup' });

    expect(useGameStore.getState().unlockedCarIds).toContain('pickup');
    getGameState().selectCar('pickup');
    expect(useGameStore.getState().selectedCarId).toBe('pickup');
  });

  it('selectCar still rejects a car that was never unlocked', () => {
    getGameState().selectCar('redRocket');
    expect(useGameStore.getState().selectedCarId).toBe('rustySedan');
  });
});
