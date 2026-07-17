import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import { useGameStore } from './store';
import { HEAT } from '../config/heat';
import { accruePassive, initHeatSystem, __resetPassiveAccumulatorForTest } from './heat';

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialStoreState, true);
  __resetPassiveAccumulatorForTest();
});

afterEach(() => {
  gameEvents.clearAllListeners();
});

describe('initHeatSystem — event → heat delta mapping', () => {
  it.each([
    ['streetlight', HEAT.events.lightPost],
    ['hydrant', HEAT.events.lightPost],
    ['mailbox', HEAT.events.lightPost],
    ['bench', HEAT.events.lightPost],
    ['fenceSegment', HEAT.events.lightPost],
    ['tree', HEAT.events.lightPost],
    ['trafficLight', HEAT.events.trafficLight],
    // Locked plan decision (phase-08-plan.md): parked cars are civilian property, so they
    // bill at civHit (+5), NOT a dedicated "parkedCar" row (there isn't one in config/heat.ts).
    ['parkedCar', HEAT.events.civHit],
  ] as const)('propDestroyed{archetype: %s} adds %d heat', (archetype, expected) => {
    const off = initHeatSystem();
    gameEvents.emit('propDestroyed', { archetype });
    expect(useGameStore.getState().heat).toBe(expected);
    off();
  });

  it('propDestroyed{archetype: "transformerBox"} is unmapped — no-ops with a DEV warning', () => {
    // transformerBox never actually reaches propDestroyed in the live system (it emits
    // transformerDestroyed instead — see combat/damage.ts + world/propDynamics.ts), but this
    // guards the defensive branch in case that emission contract is ever violated upstream.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = initHeatSystem();
    gameEvents.emit('propDestroyed', { archetype: 'transformerBox' });
    expect(useGameStore.getState().heat).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    off();
  });

  it('civHit adds HEAT.events.civHit', () => {
    const off = initHeatSystem();
    gameEvents.emit('civHit', {});
    expect(useGameStore.getState().heat).toBe(HEAT.events.civHit);
    off();
  });

  it('civWrecked adds HEAT.events.civWreck', () => {
    const off = initHeatSystem();
    gameEvents.emit('civWrecked', {});
    expect(useGameStore.getState().heat).toBe(HEAT.events.civWreck);
    off();
  });

  it('transformerDestroyed adds HEAT.events.transformer (NOT the propDestroyed path)', () => {
    const off = initHeatSystem();
    gameEvents.emit('transformerDestroyed', { districtId: 3 });
    expect(useGameStore.getState().heat).toBe(HEAT.events.transformer);
    off();
  });

  it('accumulates across multiple distinct events', () => {
    const off = initHeatSystem();
    gameEvents.emit('propDestroyed', { archetype: 'streetlight' }); // +1
    gameEvents.emit('propDestroyed', { archetype: 'trafficLight' }); // +2
    gameEvents.emit('civHit', {}); // +5
    gameEvents.emit('civWrecked', {}); // +8
    gameEvents.emit('transformerDestroyed', { districtId: 0 }); // +12
    expect(useGameStore.getState().heat).toBe(1 + 2 + 5 + 8 + 12);
    off();
  });

  it.each([
    ['police', HEAT.events.policeWreck],
    ['armored', HEAT.events.armoredWreck],
    ['swat', HEAT.events.swatWreck],
    ['gunTruck', HEAT.events.gunTruckWreck],
    ['tank', HEAT.events.tankWreck],
  ] as const)('unitWrecked{unitKind: %s} adds %d heat', (unitKind, expected) => {
    const off = initHeatSystem();
    gameEvents.emit('unitWrecked', { unitKind });
    expect(useGameStore.getState().heat).toBe(expected);
    off();
  });

  it('unitWrecked for an unmapped kind is a no-op with a DEV warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = initHeatSystem();
    gameEvents.emit('unitWrecked', { unitKind: 'unknownFutureUnit' });
    expect(useGameStore.getState().heat).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    off();
  });

  it('the returned teardown unsubscribes every listener', () => {
    const off = initHeatSystem();
    off();
    gameEvents.emit('civHit', {});
    gameEvents.emit('civWrecked', {});
    gameEvents.emit('transformerDestroyed', { districtId: 0 });
    gameEvents.emit('propDestroyed', { archetype: 'mailbox' });
    gameEvents.emit('unitWrecked', { unitKind: 'police' });
    expect(useGameStore.getState().heat).toBe(0);
  });
});

describe('accruePassive', () => {
  it('is a no-op at tier 0 (heat below ★1) even across many calls', () => {
    for (let i = 0; i < 600; i++) accruePassive(1 / 60);
    expect(useGameStore.getState().heat).toBe(0);
    expect(useGameStore.getState().tier).toBe(0);
  });

  it('only advances heat when explicitly called — no ambient/automatic accrual', () => {
    useGameStore.getState().addHeat(15); // tier -> 1
    // No accruePassive() calls at all.
    expect(useGameStore.getState().heat).toBe(15);
  });

  it('adds HEAT.passivePerSec heat per second, once tier >= 1, via whole-number flushes', () => {
    useGameStore.getState().addHeat(15); // heat 15, tier 1
    // 60 steps of 1/60s = 1.0s of simulated time -> passivePerSec (1) whole heat.
    for (let i = 0; i < 60; i++) accruePassive(1 / 60);
    expect(useGameStore.getState().heat).toBe(15 + HEAT.passivePerSec);
  });

  it('carries a fractional remainder across calls instead of losing it to repeated floor()s', () => {
    useGameStore.getState().addHeat(15); // tier 1
    // 59 steps: accumulator reaches 59/60 (<1) — nothing flushed yet.
    for (let i = 0; i < 59; i++) accruePassive(1 / 60);
    expect(useGameStore.getState().heat).toBe(15);
    // One more step crosses 60/60 = 1.0 -> exactly one whole heat flushed, not zero.
    accruePassive(1 / 60);
    expect(useGameStore.getState().heat).toBe(15 + 1);
  });

  it('resets the accumulator while tier is 0, so a later ★1 crossing does not inherit a stale remainder', () => {
    accruePassive(1 / 60); // tier 0: accumulates nothing meaningful, and resets are no-ops here
    accruePassive(0.9); // still tier 0 — this large dt must NOT be banked
    useGameStore.getState().addHeat(15); // now tier 1
    // If the 0.9s call above had been banked, a single small step would immediately flush
    // a whole heat point. It must not: 1/60s alone is far short of 1.0.
    accruePassive(1 / 60);
    expect(useGameStore.getState().heat).toBe(15);
  });
});
