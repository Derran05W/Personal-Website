// Phase 29 — regression test for a bug a coordinator live-gate check found: debugBridge.ts's
// `districtDarkStates()`/`blackoutAll()`/`relightAll()` used to loop the FROZEN legacy
// `DISTRICT_COUNT` (16, world/instancing.ts's derivation) regardless of which world is actually
// live, instead of the ACTIVE count `initPowerGrid()` was last called with
// (powergrid/grid.ts's `gridRef.current.lit.length`). Under the Toronto map (15 districts),
// `districtDarkStates()` silently reported 16 entries every time — a scripted live-gate reading
// that length as "did district-count wiring take effect" saw the wrong number even though
// grid.ts's OWN state was correctly sized. This file imports debugBridge.ts for its
// `window.__smashy` side effect (verified importable/testable in jsdom — the module's other
// imports, three.js Color/r3f-perf/audio managers, don't require a live WebGL/audio context just
// to construct) and asserts the fix directly, so a regression can't reintroduce the frozen count.
import { beforeEach, describe, expect, it } from 'vitest';
import { gameEvents } from '../state/events';
import { DISTRICT_COUNT, gridRef, initPowerGrid, __resetGridForTest } from '../powergrid/grid';
import { clearFlickers } from '../powergrid/emitters';
import './debugBridge';

beforeEach(() => {
  localStorage.clear();
  __resetGridForTest();
  clearFlickers();
  gameEvents.clearAllListeners();
});

describe('window.__smashy.districtDarkStates — active count, not the frozen legacy constant', () => {
  it('is present (debugBridge.ts is importable/side-effect-safe under vitest/jsdom)', () => {
    expect(window.__smashy).toBeDefined();
    expect(typeof window.__smashy!.districtDarkStates).toBe('function');
  });

  it('legacy default (initPowerGrid() with no args) reports exactly DISTRICT_COUNT (16) entries', () => {
    const off = initPowerGrid();
    expect(window.__smashy!.districtDarkStates()).toHaveLength(DISTRICT_COUNT);
    expect(DISTRICT_COUNT).toBe(16); // pin, mirrors grid.test.ts's own pinned assertion
    off();
  });

  it('Toronto override (initPowerGrid(15)) reports exactly 15 entries — THE bug the live gate found', () => {
    const off = initPowerGrid(15);
    const states = window.__smashy!.districtDarkStates();
    expect(states).toHaveLength(15); // was 16 before the fix, regardless of the active grid
    expect(states.every((d) => d === false)).toBe(true);
    off();
  });

  it('reflects a real blackout at the correct (Toronto-sized) index, with no out-of-range noise', () => {
    const off = initPowerGrid(15);
    gameEvents.emit('transformerDestroyed', { districtId: 0 });

    const states = window.__smashy!.districtDarkStates();
    expect(states).toHaveLength(15);
    expect(states[0]).toBe(true);
    expect(states.slice(1).every((d) => d === false)).toBe(true);
    off();
  });

  it('window.__smashy.blackoutDistrict fires the real transformerDestroyed chain and gridRef reflects it at the Toronto count', () => {
    const off = initPowerGrid(15);
    window.__smashy!.blackoutDistrict(0);

    expect(gridRef.current.lit).toHaveLength(15);
    expect(gridRef.current.lit[0]).toBe(false);
    expect(window.__smashy!.districtDarkStates()[0]).toBe(true);
    off();
  });
});

describe('window.__smashy.blackoutAll / relightAll — active count, not the frozen legacy constant', () => {
  it('blackoutAll() under a Toronto-sized grid touches exactly 15 districts (not 16, not fewer)', () => {
    const off = initPowerGrid(15);
    window.__smashy!.blackoutAll();

    expect(gridRef.current.lit).toHaveLength(15);
    expect(gridRef.current.lit.every((lit) => lit === false)).toBe(true);
    expect(gridRef.current.allDark).toBe(true); // all 15 dark -> DARK CITY condition met
    off();
  });

  it('relightAll() after blackoutAll() under a Toronto-sized grid does not throw touching a phantom 16th district', () => {
    const off = initPowerGrid(15);
    window.__smashy!.blackoutAll();
    expect(() => window.__smashy!.relightAll()).not.toThrow();
    off();
  });
});

// Phase 74 — feel lab bridge wiring. dev/feelTelemetry.ts / dev/feelProbes.ts /
// dev/feelDrives.ts each carry their own exhaustive behavioural test suites; this block only
// proves the four-step bridge convention (import → declare → thunk) was actually followed for
// every new member — the exact thing a Playwright battery script needs before it can call any
// of them by name off window.__smashy.
describe('window.__smashy — Phase 74 feel lab bridge members', () => {
  it('exposes the telemetry start/stop/reset/read/running/markPhase functions', () => {
    expect(typeof window.__smashy!.feelTelemetryStart).toBe('function');
    expect(typeof window.__smashy!.feelTelemetryStop).toBe('function');
    expect(typeof window.__smashy!.feelTelemetryReset).toBe('function');
    expect(typeof window.__smashy!.feelTelemetryRead).toBe('function');
    expect(typeof window.__smashy!.feelTelemetryRunning).toBe('function');
    expect(typeof window.__smashy!.feelMarkPhase).toBe('function');
  });

  it('exposes the probe-suite entry points', () => {
    expect(typeof window.__smashy!.startFeelProbes).toBe('function');
    expect(typeof window.__smashy!.formatFeelProbeReport).toBe('function');
  });

  it('exposes the route-drive entry points', () => {
    expect(typeof window.__smashy!.startFeelDrive).toBe('function');
    expect(typeof window.__smashy!.isFeelDriveRunning).toBe('function');
    expect(typeof window.__smashy!.activeFeelDriveRoute).toBe('function');
    expect(typeof window.__smashy!.formatFeelDriveReport).toBe('function');
    expect(typeof window.__smashy!.feelRoutes).toBe('function');
  });

  it('feelTelemetryRunning() is false and feelTelemetryRead() returns a legible empty snapshot before any start() call', () => {
    expect(window.__smashy!.feelTelemetryRunning()).toBe(false);
    const snapshot = window.__smashy!.feelTelemetryRead();
    expect(snapshot.timing.samples).toBe(0);
    expect(snapshot.running).toBe(false);
  });

  it('isFeelDriveRunning() is false and activeFeelDriveRoute() is null before any drive starts', () => {
    expect(window.__smashy!.isFeelDriveRunning()).toBe(false);
    expect(window.__smashy!.activeFeelDriveRoute()).toBeNull();
  });

  it('feelRoutes() reports exactly the four named routes, with metadata but no rect thunk', () => {
    const routes = window.__smashy!.feelRoutes();
    expect(Object.keys(routes).sort()).toEqual(
      ['chase3', 'downtownDense', 'minorWeave', 'spineCruise'].sort(),
    );
    for (const id of Object.keys(routes) as (keyof typeof routes)[]) {
      const def = routes[id];
      expect(typeof def.label).toBe('string');
      expect(Array.isArray(def.districtIds)).toBe(true);
      expect(def.districtIds.length).toBeGreaterThan(0);
      expect(typeof def.anchor).toBe('string');
      expect(typeof def.cruiseFracOfTopSpeed).toBe('number');
      expect(typeof def.requireTier).toBe('number');
      expect(typeof def.answers).toBe('string');
      // Deliberately omitted — see feelRoutes' doc comment in debugBridge.ts: `rect` is a
      // `() => DriveRect` thunk on the source FEEL_ROUTES record and does not survive
      // page.evaluate's structured-clone boundary, so the bridge strips it.
      expect('rect' in def).toBe(false);
    }
  });
});
