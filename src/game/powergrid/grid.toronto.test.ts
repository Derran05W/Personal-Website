// Phase 29 T1 — initPowerGrid's Toronto districtCount override (grid.ts). A SEPARATE file from
// grid.test.ts (which pins the legacy DISTRICT_COUNT=16 behavior byte-for-byte) so this suite's
// own vi.mock('./emitters', ...) setup and district-count fixtures can't interfere with — or be
// confused for — the legacy-grid assertions there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from '../state/events';
import { DISTRICT_COUNT, gridRef, initPowerGrid, __resetGridForTest } from './grid';
import { TORONTO_DISTRICT_COUNT } from '../world/toronto/districts';
import { clearFlickers } from './emitters';

vi.mock('./emitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./emitters')>();
  return { ...actual, blackoutDistrict: vi.fn(actual.blackoutDistrict) };
});

beforeEach(() => {
  localStorage.clear();
  __resetGridForTest();
  clearFlickers();
});

afterEach(() => {
  gameEvents.clearAllListeners();
  __resetGridForTest();
  clearFlickers();
});

describe('initPowerGrid(districtCount) — Toronto (15 districts)', () => {
  it('TORONTO_DISTRICT_COUNT is 15, distinct from the legacy 16', () => {
    expect(TORONTO_DISTRICT_COUNT).toBe(15);
    expect(TORONTO_DISTRICT_COUNT).not.toBe(DISTRICT_COUNT);
  });

  it('sizes gridRef.lit to 15, all lit, when passed the Toronto override', () => {
    const off = initPowerGrid(TORONTO_DISTRICT_COUNT);
    expect(gridRef.current.lit).toHaveLength(TORONTO_DISTRICT_COUNT);
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    off();
  });

  it('district 14 (the last valid Toronto index) is accepted, not out-of-range', () => {
    const off = initPowerGrid(TORONTO_DISTRICT_COUNT);
    gameEvents.emit('transformerDestroyed', { districtId: 14 });
    expect(gridRef.current.lit[14]).toBe(false);
    off();
  });

  it('district 15 (valid under the legacy 16-count, invalid under 15) is rejected defensively', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = initPowerGrid(TORONTO_DISTRICT_COUNT);
    expect(() => gameEvents.emit('transformerDestroyed', { districtId: 15 })).not.toThrow();
    expect(gridRef.current.lit.every((lit) => lit === true)).toBe(true);
    off();
    warnSpy.mockRestore();
  });

  it('DARK CITY fires once all 15 (not 16) Toronto districts go dark', () => {
    const darkCityListener = vi.fn();
    gameEvents.on('darkCity', darkCityListener);
    const off = initPowerGrid(TORONTO_DISTRICT_COUNT);

    for (let d = 0; d < TORONTO_DISTRICT_COUNT - 1; d++) {
      gameEvents.emit('transformerDestroyed', { districtId: d });
    }
    expect(darkCityListener).not.toHaveBeenCalled();
    expect(gridRef.current.allDark).toBe(false);

    gameEvents.emit('transformerDestroyed', { districtId: TORONTO_DISTRICT_COUNT - 1 });
    expect(darkCityListener).toHaveBeenCalledTimes(1);
    expect(gridRef.current.allDark).toBe(true);
    off();
  });

  it('omitting districtCount defaults to the legacy DISTRICT_COUNT (byte-identical legacy call site)', () => {
    const off = initPowerGrid();
    expect(gridRef.current.lit).toHaveLength(DISTRICT_COUNT);
    off();
  });

  it('a later legacy-default init after a Toronto init resizes gridRef back to 16', () => {
    const off1 = initPowerGrid(TORONTO_DISTRICT_COUNT);
    expect(gridRef.current.lit).toHaveLength(TORONTO_DISTRICT_COUNT);
    off1();

    const off2 = initPowerGrid();
    expect(gridRef.current.lit).toHaveLength(DISTRICT_COUNT);
    off2();
  });
});
