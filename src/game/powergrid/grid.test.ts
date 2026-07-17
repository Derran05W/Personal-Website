// Live integration tests against the REAL powergrid/emitters.ts (Task 1 — now landed).
// `blackoutDistrict` is wrapped in a `vi.fn` around its OWN real implementation (not a
// fake stand-in): every call not explicitly overridden with `mockImplementationOnce`
// behaves exactly like production (starts a real, seeded flicker on emitters.ts's own
// module-scope FlickerRunner singleton), while still giving these tests call-count/
// call-args assertions and one dedicated test a way to force a throw. This is the
// "Live... blackout-all -> banner + badge persisted" verification path (see this task's
// brief): grid.ts's repeat-districtId guard is asserted directly against blackoutDistrict's
// call count, not just against emitters.ts's own (separately idempotent) flicker state —
// otherwise emitters.ts's own idempotency guard (FlickerRunner.start no-ops for an
// already-active/dark district) could mask a bug in grid.ts's own guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from '../state/events';
import { PROGRESS_STORAGE_KEY, loadProgress } from '../state/persistence';
import { DISTRICT_COUNT, gridRef, initPowerGrid, __resetGridForTest } from './grid';
import { activeFlickerCount, clearFlickers, isDistrictFlickering } from './emitters';

vi.mock('./emitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./emitters')>();
  return { ...actual, blackoutDistrict: vi.fn(actual.blackoutDistrict) };
});

// Imported AFTER the vi.mock factory above so this binding resolves to the mocked (but
// real-implementation-backed) export — same module specifier, vitest's mock registry.
import { blackoutDistrict } from './emitters';
const blackoutDistrictMock = vi.mocked(blackoutDistrict);

beforeEach(() => {
  localStorage.clear();
  __resetGridForTest();
  clearFlickers(); // real emitters.ts singleton — drop cross-test flicker/dark residue.
  blackoutDistrictMock.mockClear();
});

afterEach(() => {
  gameEvents.clearAllListeners();
  __resetGridForTest();
  clearFlickers();
});

describe('DISTRICT_COUNT', () => {
  it('is 16 (4x4 district grid, TDD §5.8)', () => {
    expect(DISTRICT_COUNT).toBe(16);
  });
});

describe('initPowerGrid — initial state', () => {
  it('starts with every district lit and allDark false', () => {
    const off = initPowerGrid();
    expect(gridRef.current.lit).toHaveLength(DISTRICT_COUNT);
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    expect(gridRef.current.allDark).toBe(false);
    off();
  });
});

describe('transitions — transformerDestroyed marks exactly one district dark', () => {
  it('marks only the targeted district dark, leaves the rest lit', () => {
    const off = initPowerGrid();
    gameEvents.emit('transformerDestroyed', { districtId: 5 });

    expect(gridRef.current.lit[5]).toBe(false);
    const stillLit = gridRef.current.lit.filter((_, i) => i !== 5);
    expect(stillLit.every((lit) => lit === true)).toBe(true);
    expect(gridRef.current.allDark).toBe(false);
    off();
  });

  it('calls the real blackoutDistrict with the districtId, starting a real flicker', () => {
    const off = initPowerGrid();

    gameEvents.emit('transformerDestroyed', { districtId: 3 });

    expect(blackoutDistrictMock).toHaveBeenCalledTimes(1);
    expect(blackoutDistrictMock).toHaveBeenCalledWith(3);
    expect(isDistrictFlickering(3)).toBe(true); // real emitters.ts side effect, not faked
    off();
  });

  it('multiple distinct districts each go dark independently', () => {
    const off = initPowerGrid();
    gameEvents.emit('transformerDestroyed', { districtId: 0 });
    gameEvents.emit('transformerDestroyed', { districtId: 8 });
    gameEvents.emit('transformerDestroyed', { districtId: 15 });

    expect(gridRef.current.lit[0]).toBe(false);
    expect(gridRef.current.lit[8]).toBe(false);
    expect(gridRef.current.lit[15]).toBe(false);
    expect(gridRef.current.lit.filter((lit) => !lit)).toHaveLength(3);
    expect(gridRef.current.allDark).toBe(false);
    expect(activeFlickerCount()).toBe(3);
    off();
  });

  it('blackoutDistrict throwing does not break grid state or subsequent districts', () => {
    blackoutDistrictMock.mockImplementationOnce(() => {
      throw new Error('emitters.ts flicker sequencer blew up');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = initPowerGrid();

    gameEvents.emit('transformerDestroyed', { districtId: 1 }); // throws, caught
    gameEvents.emit('transformerDestroyed', { districtId: 2 }); // real call, succeeds

    expect(gridRef.current.lit[1]).toBe(false); // grid state still updated despite the throw
    expect(gridRef.current.lit[2]).toBe(false);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(2);
    expect(isDistrictFlickering(2)).toBe(true); // district 2's real flicker still started
    expect(errorSpy).toHaveBeenCalledTimes(1);
    off();
  });

  it('an out-of-range districtId is ignored defensively (no throw, no state change, no blackoutDistrict call)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = initPowerGrid();
    const before = gridRef.current;

    expect(() => gameEvents.emit('transformerDestroyed', { districtId: 99 })).not.toThrow();

    expect(gridRef.current).toBe(before); // no reassignment at all
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    expect(blackoutDistrictMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('repeat districtId — defensive idempotency', () => {
  it('a second transformerDestroyed for an already-dark district does not call blackoutDistrict again', () => {
    const off = initPowerGrid();

    gameEvents.emit('transformerDestroyed', { districtId: 2 });
    const stateAfterFirst = gridRef.current;
    gameEvents.emit('transformerDestroyed', { districtId: 2 });

    expect(gridRef.current).toBe(stateAfterFirst); // no reassignment on the repeat
    expect(gridRef.current.lit[2]).toBe(false);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(1); // NOT called again for the repeat
    off();
  });
});

describe('DARK CITY — exactly once per run at 16/16 dark', () => {
  function darkenAll() {
    for (let d = 0; d < DISTRICT_COUNT; d++) {
      gameEvents.emit('transformerDestroyed', { districtId: d });
    }
  }

  it('does not fire darkCity until the 16th district goes dark', () => {
    const darkCityListener = vi.fn();
    gameEvents.on('darkCity', darkCityListener);
    const off = initPowerGrid();

    for (let d = 0; d < DISTRICT_COUNT - 1; d++) {
      gameEvents.emit('transformerDestroyed', { districtId: d });
    }
    expect(darkCityListener).not.toHaveBeenCalled();
    expect(gridRef.current.allDark).toBe(false);
    off();
  });

  it('fires darkCity exactly once when the last district goes dark', () => {
    const darkCityListener = vi.fn();
    gameEvents.on('darkCity', darkCityListener);
    const off = initPowerGrid();

    darkenAll();

    expect(darkCityListener).toHaveBeenCalledTimes(1);
    expect(darkCityListener).toHaveBeenCalledWith({});
    expect(gridRef.current.allDark).toBe(true);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(DISTRICT_COUNT);
    expect(activeFlickerCount()).toBe(DISTRICT_COUNT); // every district's real flicker started
    off();
  });

  it('sets the persisted darkCityUnlocked badge when all 16 go dark', () => {
    const off = initPowerGrid();
    expect(loadProgress().darkCityUnlocked).toBeUndefined();

    darkenAll();

    expect(loadProgress().darkCityUnlocked).toBe(true);
    expect(JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) ?? 'null').darkCityUnlocked).toBe(true);
    off();
  });

  it('a stray repeat event for an already-dark district after 16/16 does not re-emit darkCity', () => {
    const darkCityListener = vi.fn();
    gameEvents.on('darkCity', darkCityListener);
    const off = initPowerGrid();

    darkenAll();
    gameEvents.emit('transformerDestroyed', { districtId: 0 }); // repeat, post-DARK-CITY

    expect(darkCityListener).toHaveBeenCalledTimes(1);
    expect(blackoutDistrictMock).toHaveBeenCalledTimes(DISTRICT_COUNT); // repeat added no call
    off();
  });
});

describe('reset — module state clears on every initPowerGrid() call (keyed-mount contract)', () => {
  it('a second initPowerGrid() call resets dark districts back to lit', () => {
    const off1 = initPowerGrid();
    gameEvents.emit('transformerDestroyed', { districtId: 6 });
    expect(gridRef.current.lit[6]).toBe(false);
    off1();

    const off2 = initPowerGrid(); // simulates a keyed remount for a new run/retry
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    expect(gridRef.current.allDark).toBe(false);
    off2();
  });

  it('a second initPowerGrid() call lets darkCity fire again for the new run', () => {
    const darkCityListener = vi.fn();
    gameEvents.on('darkCity', darkCityListener);

    const off1 = initPowerGrid();
    for (let d = 0; d < DISTRICT_COUNT; d++) gameEvents.emit('transformerDestroyed', { districtId: d });
    expect(darkCityListener).toHaveBeenCalledTimes(1);
    off1();

    clearFlickers(); // simulates emitters.ts's own PowerGridSystem unmount teardown
    const off2 = initPowerGrid();
    for (let d = 0; d < DISTRICT_COUNT; d++) gameEvents.emit('transformerDestroyed', { districtId: d });
    expect(darkCityListener).toHaveBeenCalledTimes(2); // fired again for the new run
    off2();
  });

  it('__resetGridForTest clears state without touching subscriptions', () => {
    const off = initPowerGrid();
    gameEvents.emit('transformerDestroyed', { districtId: 9 });
    expect(gridRef.current.lit[9]).toBe(false);

    __resetGridForTest();
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);

    // Subscription is still live after a bare state reset (no re-init needed).
    gameEvents.emit('transformerDestroyed', { districtId: 1 });
    expect(gridRef.current.lit[1]).toBe(false);
    off();
  });
});

describe('teardown', () => {
  it('the returned unsubscribe stops the grid from reacting to further events', () => {
    const off = initPowerGrid();
    off();

    gameEvents.emit('transformerDestroyed', { districtId: 0 });

    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    expect(blackoutDistrictMock).not.toHaveBeenCalled();
  });
});
