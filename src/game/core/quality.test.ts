import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDetectedQuality,
  classifyProbeTier,
  detectQualityTier,
  resolveProbe,
  startQualityProbe,
  sustainedFps,
  PROBE_DURATION_MS,
  type ProbeRuntimeDeps,
} from './quality';
import { getGameState, SETTINGS_STORAGE_KEY, type Settings } from '../state/store';
import type { GameState } from '../state/machine';
import type { QualityTier } from '../config';

// jsdom ships a real `navigator`; stub it per-case so the heuristic is tested against
// known signals, and restore afterwards so nothing leaks between tests.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectQualityTier', () => {
  it("returns 'low' for a mobile user agent (regardless of core count)", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      hardwareConcurrency: 8,
    });
    expect(detectQualityTier()).toBe('low');
  });

  it("returns 'low' for an Android phone user agent", () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36',
      hardwareConcurrency: 8,
    });
    expect(detectQualityTier()).toBe('low');
  });

  it("returns 'med' for a desktop UA with <= 4 logical cores", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      hardwareConcurrency: 4,
    });
    expect(detectQualityTier()).toBe('med');
  });

  it("returns 'high' for a desktop UA with many cores", () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      hardwareConcurrency: 16,
    });
    expect(detectQualityTier()).toBe('high');
  });

  it("falls back to 'high' when navigator lacks userAgent and hardwareConcurrency", () => {
    vi.stubGlobal('navigator', {});
    expect(detectQualityTier()).toBe('high');
  });

  it("falls back to 'high' when navigator is undefined", () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectQualityTier()).toBe('high');
  });
});

// --- FPS probe: pure decision core ----------------------------------------------------------

describe('sustainedFps', () => {
  it('returns the median-derived fps (16.7 ms ≈ 60 fps, 40 ms ≈ 25 fps)', () => {
    expect(sustainedFps([16, 16, 16, 16])).toBeCloseTo(62.5, 1);
    expect(sustainedFps([40, 40, 40])).toBeCloseTo(25, 5);
  });

  it('is robust to outliers (a single GC hitch does not drag it down)', () => {
    // Median of a mostly-60fps window with one 1s stall stays ≈ 60, unlike a mean.
    expect(sustainedFps([16, 16, 16, 1000, 16])).toBeCloseTo(62.5, 1);
  });

  it('drops non-positive / non-finite deltas and returns 0 for an empty window', () => {
    expect(sustainedFps([])).toBe(0);
    expect(sustainedFps([0, -5, NaN])).toBe(0);
  });
});

describe('classifyProbeTier', () => {
  it('keeps the tier when the device comfortably holds it (>= 45 fps)', () => {
    expect(classifyProbeTier(60, 'high')).toBe('high');
    expect(classifyProbeTier(60, 'med')).toBe('med');
    expect(classifyProbeTier(45, 'high')).toBe('high');
  });

  it('drops one tier at 22–45 fps', () => {
    expect(classifyProbeTier(30, 'high')).toBe('med');
    expect(classifyProbeTier(30, 'med')).toBe('low');
    expect(classifyProbeTier(30, 'low')).toBe('low'); // already the floor
  });

  it('goes straight to low below 22 fps', () => {
    expect(classifyProbeTier(15, 'high')).toBe('low');
    expect(classifyProbeTier(15, 'med')).toBe('low');
  });

  it('never promotes and treats no-signal (fps <= 0) as "keep"', () => {
    expect(classifyProbeTier(120, 'low')).toBe('low');
    expect(classifyProbeTier(0, 'med')).toBe('med');
  });
});

describe('resolveProbe', () => {
  const fps60 = [16, 16, 16, 16];
  const fps25 = [40, 40, 40];
  const fps15 = [66, 66, 66];

  it('demotes (apply:true) when an auto tier cannot hold the frame rate', () => {
    expect(resolveProbe({ deltasMs: fps25, current: 'high', source: 'auto' })).toEqual({
      tier: 'med',
      apply: true,
    });
    expect(resolveProbe({ deltasMs: fps15, current: 'high', source: 'auto' })).toEqual({
      tier: 'low',
      apply: true,
    });
  });

  it('does not persist when the tier already fits (apply:false, same tier)', () => {
    expect(resolveProbe({ deltasMs: fps60, current: 'high', source: 'auto' })).toEqual({
      tier: 'high',
      apply: false,
    });
    expect(resolveProbe({ deltasMs: [], current: 'med', source: 'auto' })).toEqual({
      tier: 'med',
      apply: false,
    });
  });

  it('NEVER overrides an explicit user choice, however bad the fps (user-choice-wins)', () => {
    expect(resolveProbe({ deltasMs: fps15, current: 'high', source: 'user' })).toEqual({
      tier: 'high',
      apply: false,
    });
  });
});

// --- FPS probe: runtime driver (fake timers/rAF/store) --------------------------------------

interface ProbeHarness {
  deps: ProbeRuntimeDeps;
  reachGarage: () => void;
  flushDelay: () => void;
  runFrames: (frames: number, deltaMs: number) => void;
  settings: () => Settings;
}

function makeHarness(initial: Partial<Settings> = {}): ProbeHarness {
  let machine: GameState = 'LOADING';
  let settings: Settings = {
    quality: 'high',
    qualitySource: 'auto',
    muted: false,
    reducedShake: false,
    ...initial,
  };
  let clock = 0;
  const rafQueue: (() => void)[] = [];
  const timerQueue: (() => void)[] = [];
  const listeners = new Set<() => void>();

  const deps: ProbeRuntimeDeps = {
    now: () => clock,
    raf: (cb) => rafQueue.push(cb),
    caf: () => {},
    setTimeout: (cb) => timerQueue.push(cb),
    clearTimeout: () => {},
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getMachine: () => machine,
    getSettings: () => settings,
    setQuality: (tier: QualityTier, source: Settings['qualitySource']) => {
      settings = { ...settings, quality: tier, qualitySource: source };
    },
  };

  return {
    deps,
    reachGarage: () => {
      machine = 'GARAGE';
      for (const l of [...listeners]) l();
    },
    flushDelay: () => timerQueue.shift()?.(),
    runFrames: (frames, deltaMs) => {
      for (let i = 0; i < frames; i++) {
        clock += deltaMs;
        rafQueue.shift()?.();
      }
    },
    settings: () => settings,
  };
}

// Enough frames to always pass PROBE_DURATION_MS for the deltas used below.
const FRAMES = Math.ceil(PROBE_DURATION_MS / 16) + 4;

describe('startQualityProbe (runtime)', () => {
  it('samples after GARAGE and demotes an auto tier that cannot hold the frame rate', () => {
    const h = makeHarness({ quality: 'high', qualitySource: 'auto' });
    startQualityProbe(h.deps);
    h.reachGarage();
    h.flushDelay(); // fire the warmup delay → begin sampling
    h.runFrames(FRAMES, 40); // 25 fps
    expect(h.settings().quality).toBe('med');
    expect(h.settings().qualitySource).toBe('auto');
  });

  it('leaves a comfortable tier alone (no demotion at 60 fps)', () => {
    const h = makeHarness({ quality: 'high', qualitySource: 'auto' });
    startQualityProbe(h.deps);
    h.reachGarage();
    h.flushDelay();
    h.runFrames(FRAMES, 16); // ~60 fps
    expect(h.settings().quality).toBe('high');
  });

  it('never overrides a persisted USER choice even at terrible fps', () => {
    const h = makeHarness({ quality: 'high', qualitySource: 'user' });
    startQualityProbe(h.deps);
    h.reachGarage();
    h.flushDelay();
    h.runFrames(FRAMES, 80); // 12.5 fps
    expect(h.settings().quality).toBe('high');
    expect(h.settings().qualitySource).toBe('user');
  });

  it('does nothing until the machine reaches GARAGE (never during LOADING)', () => {
    const h = makeHarness({ quality: 'high', qualitySource: 'auto' });
    startQualityProbe(h.deps);
    h.flushDelay(); // no GARAGE yet → no sampling was scheduled
    h.runFrames(FRAMES, 80);
    expect(h.settings().quality).toBe('high');
  });

  it('teardown cancels a pending probe (no persistence after unmount)', () => {
    const h = makeHarness({ quality: 'high', qualitySource: 'auto' });
    const stop = startQualityProbe(h.deps);
    h.reachGarage();
    stop(); // cancel before the delay fires
    h.flushDelay();
    h.runFrames(FRAMES, 80);
    expect(h.settings().quality).toBe('high');
  });
});

// --- applyDetectedQuality provenance --------------------------------------------------------

describe('applyDetectedQuality provenance', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  });

  it("persists the detected tier as 'auto' when nothing is stored", () => {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone) Mobile',
      hardwareConcurrency: 4,
    });
    applyDetectedQuality();
    expect(getGameState().settings.quality).toBe('low');
    expect(getGameState().settings.qualitySource).toBe('auto');
  });

  it('does not override a persisted user choice', () => {
    getGameState().setQuality('high', 'user'); // writes to localStorage as a user pick
    vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile' }); // would otherwise detect low
    applyDetectedQuality();
    expect(getGameState().settings.quality).toBe('high');
    expect(getGameState().settings.qualitySource).toBe('user');
  });
});
