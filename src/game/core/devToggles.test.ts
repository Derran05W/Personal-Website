// Phase 42 — the sweep toggles' contract (core/devToggles.ts's `civTraffic` / `transit`, added so
// the flicker sweep can photograph a world with no moving agents in it).
//
// What matters here and cannot be checked by the live probe alone:
//   • both default ON, so a normal boot — and every production build, where nothing ever calls
//     setDevToggle — mounts civilian traffic and TTC transit exactly as before;
//   • flipping one NOTIFIES subscribers, which is the mechanism game/index.tsx's mount gate depends
//     on (a toggle read once per render would silently never unmount anything);
//   • the debug-bridge mirrors the headless sweep drives write through to the same store, so a
//     human at the leva panel and the script can never diverge.
// The actual unmount (trafficCount() → 0, transit slots empty) is proven live by
// .planning/tools/p42-freeze-probe.mjs — index.tsx cannot be rendered in jsdom (WebGL canvas).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getDevToggles, setDevToggle, useDevToggle } from './devToggles';
import { isWorldFrozen, resetSimClock } from './simClock';
import { cameraJitter } from '../fx/cameraJitterRef';
import './debugBridge';

beforeEach(() => {
  setDevToggle('civTraffic', true);
  setDevToggle('transit', true);
  resetSimClock();
  cameraJitter.x = 0;
  cameraJitter.z = 0;
});

afterEach(() => {
  setDevToggle('civTraffic', true);
  setDevToggle('transit', true);
  resetSimClock();
  cameraJitter.x = 0;
  cameraJitter.z = 0;
});

describe('sweep toggles (Phase 42)', () => {
  it('civTraffic and transit both default ON', () => {
    expect(getDevToggles().civTraffic).toBe(true);
    expect(getDevToggles().transit).toBe(true);
  });

  it('useDevToggle re-renders on a flip — the subscription the mount gate depends on', () => {
    const { result } = renderHook(() => useDevToggle('civTraffic'));
    expect(result.current).toBe(true);

    act(() => setDevToggle('civTraffic', false));
    expect(result.current).toBe(false);

    act(() => setDevToggle('civTraffic', true));
    expect(result.current).toBe(true);
  });

  it('notifies only on a real change (setDevToggle is idempotent)', () => {
    const listener = vi.fn();
    const { result } = renderHook(() => {
      listener();
      return useDevToggle('transit');
    });
    const rendersAtStart = listener.mock.calls.length;

    act(() => setDevToggle('transit', true)); // same value — no notification, no re-render
    expect(listener.mock.calls.length).toBe(rendersAtStart);

    act(() => setDevToggle('transit', false));
    expect(result.current).toBe(false);
    expect(listener.mock.calls.length).toBeGreaterThan(rendersAtStart);
  });
});

describe('window.__smashy flicker controls (Phase 42 bridge mirrors)', () => {
  it('exposes the whole detector control surface', () => {
    const api = window.__smashy;
    expect(typeof api?.setFreezeWorld).toBe('function');
    expect(typeof api?.getFreezeWorld).toBe('function');
    expect(typeof api?.setCameraJitter).toBe('function');
    expect(typeof api?.setCivTraffic).toBe('function');
    expect(typeof api?.setTransit).toBe('function');
  });

  it('setCivTraffic / setTransit write through to the toggle store', () => {
    window.__smashy!.setCivTraffic(false);
    window.__smashy!.setTransit(false);
    expect(getDevToggles().civTraffic).toBe(false);
    expect(getDevToggles().transit).toBe(false);

    window.__smashy!.setCivTraffic(true);
    window.__smashy!.setTransit(true);
    expect(getDevToggles().civTraffic).toBe(true);
    expect(getDevToggles().transit).toBe(true);
  });

  it('setFreezeWorld / getFreezeWorld round-trip through core/simClock.ts', () => {
    expect(window.__smashy!.getFreezeWorld()).toBe(false);
    window.__smashy!.setFreezeWorld(true);
    expect(window.__smashy!.getFreezeWorld()).toBe(true);
    expect(isWorldFrozen()).toBe(true);
    window.__smashy!.setFreezeWorld(false);
    expect(isWorldFrozen()).toBe(false);
  });

  it('setCameraJitter writes the shared ref the rig reads', () => {
    window.__smashy!.setCameraJitter(0.05, -0.02);
    expect(cameraJitter).toEqual({ x: 0.05, z: -0.02 });
    window.__smashy!.setCameraJitter(0, 0);
    expect(cameraJitter).toEqual({ x: 0, z: 0 });
  });
});
