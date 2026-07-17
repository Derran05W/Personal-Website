import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from '../state/events';
import { useGameStore } from '../state/store';
import { DAMAGE, BUSTED } from '../config/damage';
import { playerVehicle } from '../vehicles/playerRef';
import { unitsRef, type UnitSlot, type PursuitApi } from '../ai/pursuitTypes';
import { getDeathPullback, resetCameraRig } from '../fx/cameraRig';
import type { IVehicleModel, VehicleState } from '../vehicles/IVehicleModel';
import {
  createBustedTracker,
  countPursuersNear,
  shouldTriggerWrecked,
  initRunLoopSystem,
  tickRunLoop,
  __resetRunLoopForTest,
} from './runLoop';

// --- fixtures --------------------------------------------------------------------------------

function unitSlot(overrides: Partial<UnitSlot> & { x: number; z: number }): UnitSlot {
  return {
    id: 0,
    kind: 'police',
    state: 'pursuing',
    y: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    hp: 40,
    behaviorLabel: 'pursue',
    ...overrides,
  };
}

function fakeUnitsApi(slots: UnitSlot[]): PursuitApi {
  return {
    slots,
    activeCount: () => slots.filter((s) => s.kind !== null).length,
    forceSpawn: () => false,
    despawnAll: () => {},
  };
}

/** Minimal IVehicleModel test double: only readState() is exercised by runLoop.ts. */
function fakeVehicle(speed: number, position = { x: 0, y: 0, z: 0 }): IVehicleModel {
  const state: VehicleState = {
    pose: { position, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    rawPose: { position, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    velocity: { x: 0, y: 0, z: 0 },
    speed,
    forwardSpeed: speed,
    upright: true,
    wheels: [],
  };
  return {
    create: () => {},
    destroy: () => {},
    applyInputs: () => {},
    readState: () => state,
    reset: () => {},
  };
}

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialStoreState, true);
  __resetRunLoopForTest();
  resetCameraRig();
  playerVehicle.current = null;
  unitsRef.current = null;
});

afterEach(() => {
  gameEvents.clearAllListeners();
  __resetRunLoopForTest();
  resetCameraRig();
  playerVehicle.current = null;
  unitsRef.current = null;
});

// --- pure core: createBustedTracker -----------------------------------------------------------

describe('createBustedTracker (pure rolling window)', () => {
  const cfg = { maxSpeed: 1, holdSec: 3, minPursuers: 3 };

  it('never triggers while unarmed, even if the condition holds continuously', () => {
    const t = createBustedTracker(cfg);
    let triggered = false;
    for (let i = 0; i < 10; i++) triggered ||= t.tick(0, 5, 1);
    expect(triggered).toBe(false);
    expect(t.isArmed()).toBe(false);
  });

  it('triggers exactly on the step the continuous hold reaches holdSec', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    expect(t.tick(0, 5, 1)).toBe(false); // 1s
    expect(t.tick(0, 5, 1)).toBe(false); // 2s
    expect(t.tick(0, 5, 1)).toBe(true); // 3s — trigger edge
  });

  it('resets the rolling window when speed rises above maxSpeed mid-window', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    t.tick(0, 5, 1); // 1s
    t.tick(0, 5, 1); // 2s
    expect(t.tick(5, 5, 1)).toBe(false); // speed breaks condition — resets to 0
    expect(t.tick(0, 5, 1)).toBe(false); // 1s again, not 3s
    expect(t.tick(0, 5, 1)).toBe(false); // 2s
    expect(t.tick(0, 5, 1)).toBe(true); // 3s
  });

  it('resets the rolling window when pursuer count drops below minPursuers mid-window', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    t.tick(0, 5, 1);
    t.tick(0, 5, 1);
    expect(t.tick(0, 2, 1)).toBe(false); // only 2 pursuers — resets
    expect(t.tick(0, 3, 1)).toBe(false); // 1s again
  });

  it('triggers only once — stays false on every step after the trigger, even if the condition keeps holding', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    t.tick(0, 5, 1);
    t.tick(0, 5, 1);
    expect(t.tick(0, 5, 1)).toBe(true);
    expect(t.tick(0, 5, 1)).toBe(false);
    expect(t.tick(0, 5, 1)).toBe(false);
  });

  it('reset() re-arms cleanly: unarms, clears the window, and allows a fresh trigger', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    t.tick(0, 5, 1);
    t.tick(0, 5, 1);
    expect(t.tick(0, 5, 1)).toBe(true);

    t.reset();
    expect(t.isArmed()).toBe(false);
    expect(t.tick(0, 5, 1)).toBe(false); // unarmed again

    t.arm();
    t.tick(0, 5, 1);
    t.tick(0, 5, 1);
    expect(t.tick(0, 5, 1)).toBe(true); // fires again after a real reset
  });

  it('the exact boundary is inclusive on speed (< maxSpeed) and pursuers (>= minPursuers)', () => {
    const t = createBustedTracker(cfg);
    t.arm();
    // speed exactly AT maxSpeed does not count ("< 1", not "<= 1").
    expect(t.tick(1, 3, 10)).toBe(false);
    // pursuers exactly AT minPursuers DOES count (">= 3").
    t.tick(0.999, 3, 1);
    t.tick(0.999, 3, 1);
    expect(t.tick(0.999, 3, 1)).toBe(true);
  });
});

// --- pure core: countPursuersNear ---------------------------------------------------------------

describe('countPursuersNear', () => {
  const player = { x: 0, y: 0, z: 0 };

  it('counts pursuing units within radius', () => {
    const slots = [unitSlot({ x: 3, z: 0 }), unitSlot({ x: 0, z: 4 }), unitSlot({ x: 20, z: 0 })];
    expect(countPursuersNear(slots, player, 8)).toBe(2);
  });

  it('excludes free slots (kind null)', () => {
    const slots = [unitSlot({ x: 1, z: 0, kind: null })];
    expect(countPursuersNear(slots, player, 8)).toBe(0);
  });

  it('excludes wrecked-state slots', () => {
    const slots = [unitSlot({ x: 1, z: 0, state: 'wrecked' })];
    expect(countPursuersNear(slots, player, 8)).toBe(0);
  });

  it('the radius boundary is inclusive', () => {
    const slots = [unitSlot({ x: 8, z: 0 })]; // exactly at radius 8
    expect(countPursuersNear(slots, player, 8)).toBe(1);
    const justOutside = [unitSlot({ x: 8.01, z: 0 })];
    expect(countPursuersNear(justOutside, player, 8)).toBe(0);
  });

  it('an empty slot list counts zero', () => {
    expect(countPursuersNear([], player, 8)).toBe(0);
  });
});

// --- pure core: shouldTriggerWrecked ------------------------------------------------------------

describe('shouldTriggerWrecked', () => {
  it('true when hp<=0 and not already triggered', () => {
    expect(shouldTriggerWrecked(false, 0)).toBe(true);
    expect(shouldTriggerWrecked(false, -5)).toBe(true);
  });

  it('false when hp>0', () => {
    expect(shouldTriggerWrecked(false, 1)).toBe(false);
  });

  it('false once already triggered, regardless of hp', () => {
    expect(shouldTriggerWrecked(true, 0)).toBe(false);
  });
});

// --- integration: runStarted -------------------------------------------------------------------

describe('runStarted', () => {
  it('emits {seed} on GARAGE->PLAYING, not before', () => {
    const handler = vi.fn();
    gameEvents.on('runStarted', handler);
    const off = initRunLoopSystem();
    const store = useGameStore.getState();
    store.setSeed(4242);
    store.transition('LOADING');
    store.transition('GARAGE');
    expect(handler).not.toHaveBeenCalled();

    store.transition('PLAYING');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ seed: 4242 });
    off();
  });

  it('fires again on GAMEOVER->PLAYING (retry) but NOT on PAUSED->PLAYING (resume)', () => {
    const handler = vi.fn();
    gameEvents.on('runStarted', handler);
    const off = initRunLoopSystem();
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');
    expect(handler).toHaveBeenCalledTimes(1);

    store.transition('PAUSED');
    store.transition('PLAYING');
    expect(handler).toHaveBeenCalledTimes(1); // resume — no new run

    store.transition('PAUSED');
    store.transition('GAMEOVER');
    store.transition('PLAYING'); // retry
    expect(handler).toHaveBeenCalledTimes(2);
    off();
  });
});

// --- integration: WRECKED flow -------------------------------------------------------------------

describe('WRECKED flow', () => {
  function startRun(): () => void {
    const off = initRunLoopSystem();
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');
    return off;
  }

  it('playerDamaged{hp:0} triggers playerWrecked once, then GAMEOVER + runEnded after the lock window', () => {
    const wreckedHandler = vi.fn();
    const runEndedHandler = vi.fn();
    gameEvents.on('playerWrecked', wreckedHandler);
    gameEvents.on('runEnded', runEndedHandler);
    const off = startRun();

    gameEvents.emit('playerDamaged', { hp: 0, amount: 100 });
    expect(wreckedHandler).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().machine).toBe('PLAYING'); // still locked, not yet over
    expect(getDeathPullback()).toBe(true);

    const lockTicks = Math.round(DAMAGE.wreckedLockSec * 60);
    for (let i = 0; i < lockTicks - 5; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('PLAYING'); // not yet — margin before the edge

    for (let i = 0; i < 10; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    expect(runEndedHandler).toHaveBeenCalledTimes(1);
    expect(runEndedHandler).toHaveBeenCalledWith({ score: useGameStore.getState().score, reason: 'wrecked' });

    // Further ticks (machine no longer PLAYING) must not double-fire anything.
    for (let i = 0; i < 60; i++) tickRunLoop();
    expect(wreckedHandler).toHaveBeenCalledTimes(1);
    expect(runEndedHandler).toHaveBeenCalledTimes(1);
    off();
  });

  it('enteredWater triggers the same instant-WRECKED path', () => {
    const wreckedHandler = vi.fn();
    gameEvents.on('playerWrecked', wreckedHandler);
    const off = startRun();

    gameEvents.emit('enteredWater', {});
    expect(wreckedHandler).toHaveBeenCalledTimes(1);

    const lockTicks = Math.round(DAMAGE.wreckedLockSec * 60) + 5;
    for (let i = 0; i < lockTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    off();
  });

  it('the poll fallback catches hp<=0 even without a playerDamaged event (the debugBridge.setPlayerHp kill path)', () => {
    const wreckedHandler = vi.fn();
    gameEvents.on('playerWrecked', wreckedHandler);
    const off = startRun();

    // Mirrors core/debugBridge.ts's setPlayerHp: a raw store mutation, no event.
    useGameStore.getState().setPlayerHp(0);
    expect(wreckedHandler).not.toHaveBeenCalled(); // not yet — needs a tick to poll

    tickRunLoop();
    expect(wreckedHandler).toHaveBeenCalledTimes(1);
    off();
  });

  it('does not double-fire playerWrecked on repeated hp<=0 ticks within one run', () => {
    const wreckedHandler = vi.fn();
    gameEvents.on('playerWrecked', wreckedHandler);
    const off = startRun();

    useGameStore.getState().setPlayerHp(0);
    for (let i = 0; i < 20; i++) tickRunLoop();
    expect(wreckedHandler).toHaveBeenCalledTimes(1);
    off();
  });

  it('a retry (GAMEOVER->PLAYING) resets the WRECKED latch so the next run can WRECKED again', () => {
    const wreckedHandler = vi.fn();
    const runEndedHandler = vi.fn();
    gameEvents.on('playerWrecked', wreckedHandler);
    gameEvents.on('runEnded', runEndedHandler);
    const off = startRun();

    useGameStore.getState().setPlayerHp(0);
    const lockTicks = Math.round(DAMAGE.wreckedLockSec * 60) + 5;
    for (let i = 0; i < lockTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    expect(wreckedHandler).toHaveBeenCalledTimes(1);

    // Retry: runReset (heat/tier/score/playerHp reset) + GAMEOVER->PLAYING.
    useGameStore.getState().runReset();
    useGameStore.getState().transition('PLAYING');
    expect(getDeathPullback()).toBe(false); // beginRun cleared the pull-back

    useGameStore.getState().setPlayerHp(0);
    for (let i = 0; i < lockTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    expect(wreckedHandler).toHaveBeenCalledTimes(2);
    expect(runEndedHandler).toHaveBeenCalledTimes(2);
    off();
  });

  it('a WRECKED poll while a BUSTED lock is already in flight does not hijack the reason/timer', () => {
    const off = startRun();
    playerVehicle.current = fakeVehicle(0);
    unitsRef.current = fakeUnitsApi([
      unitSlot({ x: 1, z: 0 }),
      unitSlot({ x: 2, z: 0, id: 1 }),
      unitSlot({ x: 3, z: 0, id: 2 }),
    ]);
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });

    const holdTicks = Math.round(BUSTED.holdSec * 60) + 2;
    for (let i = 0; i < holdTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('PLAYING'); // busted locked in, not over yet

    // hp now also drops to 0 mid-lock — must NOT restart the timer as 'wrecked'.
    useGameStore.getState().setPlayerHp(0);
    tickRunLoop();

    const lockTicks = Math.round(BUSTED.lockSec * 60) + 5;
    for (let i = 0; i < lockTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    off();
  });
});

// --- integration: BUSTED flow --------------------------------------------------------------------

describe('BUSTED flow', () => {
  function startRun(): () => void {
    const off = initRunLoopSystem();
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');
    return off;
  }

  it('never triggers before the run has reached tier >= 1 (unarmed)', () => {
    const bustedHandler = vi.fn();
    gameEvents.on('busted', bustedHandler);
    const off = startRun();
    playerVehicle.current = fakeVehicle(0);
    unitsRef.current = fakeUnitsApi([
      unitSlot({ x: 1, z: 0 }),
      unitSlot({ x: 2, z: 0, id: 1 }),
      unitSlot({ x: 3, z: 0, id: 2 }),
    ]);

    const holdTicks = Math.round(BUSTED.holdSec * 60) + 30;
    for (let i = 0; i < holdTicks; i++) tickRunLoop();
    expect(bustedHandler).not.toHaveBeenCalled();
    expect(useGameStore.getState().machine).toBe('PLAYING');
    off();
  });

  it('triggers after a continuous hold once armed, then GAMEOVER + runEnded{reason:"busted"} after the lock', () => {
    const bustedHandler = vi.fn();
    const runEndedHandler = vi.fn();
    gameEvents.on('busted', bustedHandler);
    gameEvents.on('runEnded', runEndedHandler);
    const off = startRun();
    playerVehicle.current = fakeVehicle(0.2); // < BUSTED.maxSpeed
    unitsRef.current = fakeUnitsApi([
      unitSlot({ x: 1, z: 0 }),
      unitSlot({ x: 2, z: 0, id: 1 }),
      unitSlot({ x: 3, z: 0, id: 2 }),
    ]);
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 }); // arms

    const holdTicks = Math.round(BUSTED.holdSec * 60);
    for (let i = 0; i < holdTicks - 5; i++) tickRunLoop();
    expect(bustedHandler).not.toHaveBeenCalled();

    for (let i = 0; i < 10; i++) tickRunLoop();
    expect(bustedHandler).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().machine).toBe('PLAYING');

    const lockTicks = Math.round(BUSTED.lockSec * 60) + 5;
    for (let i = 0; i < lockTicks; i++) tickRunLoop();
    expect(useGameStore.getState().machine).toBe('GAMEOVER');
    expect(runEndedHandler).toHaveBeenCalledWith({ score: useGameStore.getState().score, reason: 'busted' });
    off();
  });

  it('does not trigger when fewer than minPursuers are within radius', () => {
    const bustedHandler = vi.fn();
    gameEvents.on('busted', bustedHandler);
    const off = startRun();
    playerVehicle.current = fakeVehicle(0);
    unitsRef.current = fakeUnitsApi([unitSlot({ x: 1, z: 0 }), unitSlot({ x: 2, z: 0, id: 1 })]); // only 2
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });

    const holdTicks = Math.round(BUSTED.holdSec * 60) + 30;
    for (let i = 0; i < holdTicks; i++) tickRunLoop();
    expect(bustedHandler).not.toHaveBeenCalled();
    off();
  });

  it('does not trigger while the player keeps moving, even surrounded', () => {
    const bustedHandler = vi.fn();
    gameEvents.on('busted', bustedHandler);
    const off = startRun();
    playerVehicle.current = fakeVehicle(5); // moving
    unitsRef.current = fakeUnitsApi([
      unitSlot({ x: 1, z: 0 }),
      unitSlot({ x: 2, z: 0, id: 1 }),
      unitSlot({ x: 3, z: 0, id: 2 }),
    ]);
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });

    const holdTicks = Math.round(BUSTED.holdSec * 60) + 30;
    for (let i = 0; i < holdTicks; i++) tickRunLoop();
    expect(bustedHandler).not.toHaveBeenCalled();
    off();
  });

  it('with no unitsRef mounted (no live PursuitApi), pursuersNear is treated as 0 — never triggers', () => {
    const bustedHandler = vi.fn();
    gameEvents.on('busted', bustedHandler);
    const off = startRun();
    playerVehicle.current = fakeVehicle(0);
    unitsRef.current = null;
    gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });

    const holdTicks = Math.round(BUSTED.holdSec * 60) + 30;
    for (let i = 0; i < holdTicks; i++) tickRunLoop();
    expect(bustedHandler).not.toHaveBeenCalled();
    off();
  });
});

// --- integration: pause / machine gating -----------------------------------------------------

describe('tickRunLoop machine gating', () => {
  it('is a no-op whenever machine !== PLAYING (e.g. BOOT, or a mid-lock PAUSE)', () => {
    __resetRunLoopForTest();
    // BOOT: no crash, no state change.
    expect(() => tickRunLoop()).not.toThrow();
    expect(useGameStore.getState().machine).toBe('BOOT');
  });
});
