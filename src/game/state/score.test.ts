import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gameEvents } from './events';
import { useGameStore } from './store';
import { HEAT } from '../config/heat';
import { accrueRisk, initScoreSystem, __resetRiskAccumulatorForTest } from './score';

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  useGameStore.setState(initialStoreState, true);
  __resetRiskAccumulatorForTest();
});

afterEach(() => {
  gameEvents.clearAllListeners();
});

describe('initScoreSystem — heatChanged mirror ("Σ heat events" term)', () => {
  it('adds score equal to the heatChanged delta', () => {
    const off = initScoreSystem();
    gameEvents.emit('heatChanged', { heat: 5, delta: 5 });
    expect(useGameStore.getState().score).toBe(5);
    off();
  });

  it('accumulates across multiple heatChanged events', () => {
    const off = initScoreSystem();
    gameEvents.emit('heatChanged', { heat: 1, delta: 1 });
    gameEvents.emit('heatChanged', { heat: 3, delta: 2 });
    gameEvents.emit('heatChanged', { heat: 15, delta: 12 });
    expect(useGameStore.getState().score).toBe(1 + 2 + 12);
    off();
  });

  it('a zero delta (e.g. a clamped negative addHeat call) does not add score', () => {
    const off = initScoreSystem();
    gameEvents.emit('heatChanged', { heat: 10, delta: 0 });
    expect(useGameStore.getState().score).toBe(0);
    off();
  });

  it('end-to-end: store.addHeat drives score via the real heatChanged emission', () => {
    const off = initScoreSystem();
    useGameStore.getState().addHeat(HEAT.events.civWreck);
    expect(useGameStore.getState().score).toBe(HEAT.events.civWreck);
    off();
  });

  it('the returned teardown unsubscribes', () => {
    const off = initScoreSystem();
    off();
    gameEvents.emit('heatChanged', { heat: 5, delta: 5 });
    expect(useGameStore.getState().score).toBe(0);
  });
});

describe('accrueRisk — TDD §5.10 "5 x current_tier per second while >= *1"', () => {
  it('is a no-op at tier 0', () => {
    for (let i = 0; i < 600; i++) accrueRisk(1 / 60);
    expect(useGameStore.getState().score).toBe(0);
  });

  it('adds riskBonusPerTierPerSec x tier whole points per second of accrual at tier 1', () => {
    useGameStore.getState().addHeat(15); // tier 1
    for (let i = 0; i < 60; i++) accrueRisk(1 / 60); // 1.0s
    expect(useGameStore.getState().score).toBe(HEAT.riskBonusPerTierPerSec * 1);
  });

  it('scales with the CURRENT tier, read fresh every call', () => {
    useGameStore.getState().addHeat(75); // tier 2 directly
    for (let i = 0; i < 60; i++) accrueRisk(1 / 60); // 1.0s at tier 2
    expect(useGameStore.getState().score).toBe(HEAT.riskBonusPerTierPerSec * 2);
  });

  it('carries a fractional remainder across calls instead of losing it to repeated floor()s', () => {
    useGameStore.getState().addHeat(15); // tier 1: 5 points/sec -> 1 whole point every 0.2s (12 steps)
    for (let i = 0; i < 11; i++) accrueRisk(1 / 60);
    expect(useGameStore.getState().score).toBe(0);
    accrueRisk(1 / 60); // 12th step crosses 12/60 * 5 = 1.0
    expect(useGameStore.getState().score).toBe(1);
  });

  it('resets the accumulator while tier is 0', () => {
    accrueRisk(0.9); // tier 0 — must not be banked
    useGameStore.getState().addHeat(15); // tier 1
    accrueRisk(1 / 60); // far short of a whole point on its own
    expect(useGameStore.getState().score).toBe(0);
  });

  it('a mid-accrual tier-up is reflected on the very next call (no stale-tier lag)', () => {
    useGameStore.getState().addHeat(15); // tier 1
    accrueRisk(0.1); // 0.1s @ tier1 = 0.5 accumulated, no flush yet
    useGameStore.getState().addHeat(60); // heat 75 -> tier 2
    accrueRisk(0.1); // + 0.1s @ tier2 = 1.0 -> total accumulator 0.5 + 1.0 = 1.5 -> flush 1
    expect(useGameStore.getState().score).toBe(1);
  });
});
