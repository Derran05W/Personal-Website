import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import { useGameStore } from './store';
import { HEAT } from '../config/heat';
import { accruePassive, initHeatSystem, __resetPassiveAccumulatorForTest } from './heat';
import { gridRef, initPowerGrid, __resetGridForTest } from '../powergrid/grid';
import { clearFlickers } from '../powergrid/emitters';

// Real (not mocked) powergrid/emitters.ts for this file's regression block — the point is
// to prove powergrid/grid.ts's OWN repeat-districtId guard, driven end-to-end against the
// real flicker sequencer, not a stand-in. See that describe block's header comment.
vi.mock('../powergrid/emitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../powergrid/emitters')>();
  return { ...actual, blackoutDistrict: vi.fn(actual.blackoutDistrict) };
});
import { blackoutDistrict } from '../powergrid/emitters';
const blackoutDistrictMock = vi.mocked(blackoutDistrict);

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

// --- Phase 13 regression: transformerDestroyed double-emit + powergrid/grid.ts -------------
//
// Proves WHERE the "+12 exactly once per transformer" guarantee actually lives. It is NOT
// inside this file: initHeatSystem's `offTransformer` handler (above) adds HEAT.events.
// transformer on every transformerDestroyed event it receives, with zero districtId-
// awareness or dedup logic — by design, per the "transformerBox is deliberately ABSENT"
// header comment's account of the real emission contract. The actual exactly-once guarantee
// is structural, upstream, in combat/damage.ts's `applyEntityDamage`: once an entry's hp
// reaches 0, every subsequent call on that same entry no-ops immediately (`if (hp ===
// undefined || hp <= 0) return;`), so `handleTransformerDeath` — and therefore
// `transformerDestroyed` — can fire at most once per district per run in the real flow.
// That upstream contract is exercised by combat/damage.test.ts, not here.
//
// What IS this file's concern: proving heat.ts's lack of dedup is real (a synthetic double-
// emit genuinely double-bills heat) while also proving powergrid/grid.ts — Phase 13's other
// transformerDestroyed subscriber — stays defensively idempotent against the exact same
// synthetic duplicate, so the user-visible grid/blackout/darkCity behavior can never
// double-fire even in a hypothetical world where the upstream hp-clamp were ever violated.
describe('regression (Phase 13) — transformerDestroyed double-emit vs powergrid/grid.ts', () => {
  beforeEach(() => {
    __resetGridForTest();
    clearFlickers(); // real emitters.ts singleton — drop cross-test flicker/dark residue
    blackoutDistrictMock.mockClear();
  });

  afterEach(() => {
    __resetGridForTest();
    clearFlickers();
  });

  it('a single transformerDestroyed adds +12 exactly once', () => {
    const off = initHeatSystem();
    gameEvents.emit('transformerDestroyed', { districtId: 4 });
    expect(useGameStore.getState().heat).toBe(HEAT.events.transformer);
    off();
  });

  it('a synthetic duplicate for the SAME district double-bills heat.ts (no dedup, by design) while powergrid/grid.ts ignores the repeat', () => {
    const offHeat = initHeatSystem();
    const offGrid = initPowerGrid();

    gameEvents.emit('transformerDestroyed', { districtId: 7 });
    expect(useGameStore.getState().heat).toBe(HEAT.events.transformer);
    expect(gridRef.current.lit[7]).toBe(false);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(1);

    // Synthetic duplicate — cannot happen via the real hp-clamp guard in
    // combat/damage.ts (see this describe block's header); simulates a hypothetical
    // upstream regression to prove each subscriber's own behavior in isolation.
    gameEvents.emit('transformerDestroyed', { districtId: 7 });

    // heat.ts: billed a second time — it has no districtId-level guard of its own.
    expect(useGameStore.getState().heat).toBe(HEAT.events.transformer * 2);
    // powergrid/grid.ts: unchanged — the repeat districtId was a no-op (its own
    // regression coverage lives in powergrid/grid.test.ts's "repeat districtId" block).
    // Asserted against the REAL blackoutDistrict's call count (not just the resulting
    // flicker state), since emitters.ts's FlickerRunner has its own independent
    // idempotency guard that could otherwise mask a bug in grid.ts's own.
    expect(gridRef.current.lit[7]).toBe(false);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(1);

    offGrid();
    offHeat();
  });
});
