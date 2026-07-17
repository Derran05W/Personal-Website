import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import { getGameState, tierForHeat, useGameStore } from './store';
import { PROGRESS_STORAGE_KEY } from './persistence';
import { WORLD_GEN } from '../config';

const SETTINGS_KEY = 'smashy6ix:settings';

// Snapshot of the store's state at module-evaluation time (includes action references,
// which are stable for the store's lifetime, plus the settings hydrated from
// localStorage at import — expected to be defaults, since localStorage is empty before
// any test runs). Used to fully reset the store between tests.
const initialState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialState, true);
});

afterEach(() => {
  gameEvents.clearAllListeners();
});

describe('initial state', () => {
  it('matches the documented defaults', () => {
    const state = useGameStore.getState();
    expect(state.machine).toBe('BOOT');
    expect(state.heat).toBe(0);
    expect(state.tier).toBe(0);
    expect(state.score).toBe(0);
    expect(state.playerHp).toBe(100);
    expect(state.seed).toBe(WORLD_GEN.defaultSeed);
    expect(state.settings).toEqual({ quality: 'high', qualitySource: 'auto', muted: false, reducedShake: false });
    expect(state.selectedCarId).toBe('rustySedan');
    expect(state.unlockedCarIds).toEqual(['rustySedan']);
  });
});

describe('getGameState', () => {
  it('is useGameStore.getState, and reflects live state', () => {
    expect(getGameState).toBe(useGameStore.getState);
    useGameStore.getState().addScore(10);
    expect(getGameState().score).toBe(10);
  });
});

describe('transition', () => {
  it('a valid transition updates machine', () => {
    useGameStore.getState().transition('LOADING');
    expect(useGameStore.getState().machine).toBe('LOADING');
  });

  it('an invalid transition throws (dev) and leaves state unchanged', () => {
    expect(() => useGameStore.getState().transition('PLAYING')).toThrow(
      /Invalid game state transition/,
    );
    expect(useGameStore.getState().machine).toBe('BOOT');
  });
});

describe('addHeat', () => {
  it('accumulates across calls', () => {
    useGameStore.getState().addHeat(5);
    useGameStore.getState().addHeat(3);
    expect(useGameStore.getState().heat).toBe(8);
  });

  it('is monotonic: a negative delta is clamped to 0, not applied', () => {
    useGameStore.getState().addHeat(10);
    useGameStore.getState().addHeat(-100);
    expect(useGameStore.getState().heat).toBe(10);
  });

  it('crossing the tier-1 threshold (15) flips tier 0 -> 1 and emits tierChanged', () => {
    const tierHandler = vi.fn();
    gameEvents.on('tierChanged', tierHandler);

    useGameStore.getState().addHeat(10); // heat 10: still tier 0
    expect(useGameStore.getState().tier).toBe(0);
    expect(tierHandler).not.toHaveBeenCalled();

    useGameStore.getState().addHeat(5); // heat 15: tier 0 -> 1
    expect(useGameStore.getState().tier).toBe(1);
    expect(tierHandler).toHaveBeenCalledTimes(1);
    expect(tierHandler).toHaveBeenCalledWith({ tier: 1, prevTier: 0 });
  });

  it('a multi-tier jump emits tierChanged once PER crossing, in ascending order', () => {
    const tierHandler = vi.fn();
    gameEvents.on('tierChanged', tierHandler);

    useGameStore.getState().addHeat(10); // heat 10, tier 0
    useGameStore.getState().addHeat(200); // heat 210: crosses tier 1 (15), 2 (75), 3 (180)

    expect(useGameStore.getState().heat).toBe(210);
    expect(useGameStore.getState().tier).toBe(3);
    expect(tierHandler).toHaveBeenCalledTimes(3);
    expect(tierHandler).toHaveBeenNthCalledWith(1, { tier: 1, prevTier: 0 });
    expect(tierHandler).toHaveBeenNthCalledWith(2, { tier: 2, prevTier: 1 });
    expect(tierHandler).toHaveBeenNthCalledWith(3, { tier: 3, prevTier: 2 });
  });

  it('a jump that lands exactly on the max tier does not overshoot or repeat', () => {
    const tierHandler = vi.fn();
    gameEvents.on('tierChanged', tierHandler);

    useGameStore.getState().addHeat(600); // straight to tier 5 from 0
    expect(useGameStore.getState().tier).toBe(5);
    expect(tierHandler).toHaveBeenCalledTimes(5);
    expect(tierHandler).toHaveBeenNthCalledWith(5, { tier: 5, prevTier: 4 });

    tierHandler.mockClear();
    useGameStore.getState().addHeat(1000); // already at tier 5 (max) — no further crossings
    expect(useGameStore.getState().tier).toBe(5);
    expect(tierHandler).not.toHaveBeenCalled();
  });

  it('emits heatChanged on every call with the applied (post-clamp) delta', () => {
    const heatHandler = vi.fn();
    gameEvents.on('heatChanged', heatHandler);

    useGameStore.getState().addHeat(7);
    expect(heatHandler).toHaveBeenNthCalledWith(1, { heat: 7, delta: 7 });

    useGameStore.getState().addHeat(-3); // clamped to 0, heat unchanged, still emits
    expect(heatHandler).toHaveBeenNthCalledWith(2, { heat: 7, delta: 0 });
    expect(heatHandler).toHaveBeenCalledTimes(2);
  });
});

describe('tierForHeat', () => {
  const THRESHOLDS = [0, 15, 75, 180, 350, 600] as const;

  it.each([
    [0, 0],
    [14, 0],
    [15, 1],
    [74, 1],
    [75, 2],
    [599, 4],
    [600, 5],
    [10_000, 5],
  ])('tierForHeat(%d) === %d', (heat, expected) => {
    expect(tierForHeat(heat, THRESHOLDS)).toBe(expected);
  });
});

describe('addScore / setPlayerHp / setSeed', () => {
  it('addScore accumulates', () => {
    useGameStore.getState().addScore(10);
    useGameStore.getState().addScore(5);
    expect(useGameStore.getState().score).toBe(15);
  });

  it('setPlayerHp / setSeed set directly', () => {
    useGameStore.getState().setPlayerHp(42);
    useGameStore.getState().setSeed(1234);
    expect(useGameStore.getState().playerHp).toBe(42);
    expect(useGameStore.getState().seed).toBe(1234);
  });
});

describe('settings — setQuality / toggleMuted', () => {
  it('setQuality updates state and persists to localStorage', () => {
    useGameStore.getState().setQuality('med');
    expect(useGameStore.getState().settings).toEqual({
      quality: 'med',
      qualitySource: 'user',
      muted: false,
      reducedShake: false,
    });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({
      quality: 'med',
      qualitySource: 'user',
      muted: false,
      reducedShake: false,
    });
  });

  it('toggleMuted flips state and persists to localStorage', () => {
    useGameStore.getState().toggleMuted();
    expect(useGameStore.getState().settings.muted).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({
      quality: 'high',
      qualitySource: 'auto',
      muted: true,
      reducedShake: false,
    });

    useGameStore.getState().toggleMuted();
    expect(useGameStore.getState().settings.muted).toBe(false);
  });
});

describe('settings — setReducedShake (Phase 16 a11y)', () => {
  it('defaults to false', () => {
    expect(useGameStore.getState().settings.reducedShake).toBe(false);
  });

  it('setReducedShake updates state and persists to localStorage', () => {
    useGameStore.getState().setReducedShake(true);
    expect(useGameStore.getState().settings.reducedShake).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({
      quality: 'high',
      qualitySource: 'auto',
      muted: false,
      reducedShake: true,
    });
  });

  it('leaves quality/muted untouched when toggled', () => {
    const store = useGameStore.getState();
    store.setQuality('low');
    store.toggleMuted();
    store.setReducedShake(true);
    expect(useGameStore.getState().settings).toEqual({
      quality: 'low',
      qualitySource: 'user',
      muted: true,
      reducedShake: true,
    });
  });
});

describe('settings — qualitySource provenance (Phase 18)', () => {
  it("setQuality defaults to 'user' provenance (a menu pick the probe must never override)", () => {
    useGameStore.getState().setQuality('med');
    expect(useGameStore.getState().settings.qualitySource).toBe('user');
  });

  it("setQuality(tier, 'auto') records auto provenance (heuristic / FPS-probe path)", () => {
    useGameStore.getState().setQuality('low', 'auto');
    expect(useGameStore.getState().settings.qualitySource).toBe('auto');
  });
});

describe('hardReset', () => {
  it('zeroes run data and resets machine to BOOT, but preserves settings and seed', () => {
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');
    store.addHeat(50);
    store.addScore(100);
    store.setPlayerHp(40);
    store.setSeed(999);
    store.setQuality('low');

    useGameStore.getState().hardReset();

    const state = useGameStore.getState();
    expect(state.machine).toBe('BOOT');
    expect(state.heat).toBe(0);
    expect(state.tier).toBe(0);
    expect(state.score).toBe(0);
    expect(state.playerHp).toBe(100);
    expect(state.seed).toBe(999);
    expect(state.settings).toEqual({ quality: 'low', qualitySource: 'user', muted: false, reducedShake: false });
  });
});

describe('runReset', () => {
  it('zeroes heat/tier/score and restores playerHp, but leaves machine untouched', () => {
    const store = useGameStore.getState();
    store.transition('LOADING');
    store.transition('GARAGE');
    store.transition('PLAYING');
    store.addHeat(50);
    store.addScore(100);
    store.setPlayerHp(40);

    useGameStore.getState().runReset();

    const state = useGameStore.getState();
    expect(state.machine).toBe('PLAYING'); // unchanged — contrast hardReset
    expect(state.heat).toBe(0);
    expect(state.tier).toBe(0);
    expect(state.score).toBe(0);
    expect(state.playerHp).toBe(100);
  });

  it('preserves settings and seed, same as hardReset', () => {
    const store = useGameStore.getState();
    store.setSeed(999);
    store.setQuality('low');

    store.runReset();

    const state = useGameStore.getState();
    expect(state.seed).toBe(999);
    expect(state.settings).toEqual({ quality: 'low', qualitySource: 'user', muted: false, reducedShake: false });
  });

  it('does not emit tierChanged/heatChanged (a silent reset, not a monotonic addHeat call)', () => {
    const tierHandler = vi.fn();
    const heatHandler = vi.fn();
    gameEvents.on('tierChanged', tierHandler);
    gameEvents.on('heatChanged', heatHandler);

    useGameStore.getState().addHeat(50); // tier 0 -> 2, emits both
    tierHandler.mockClear();
    heatHandler.mockClear();

    useGameStore.getState().runReset();

    expect(tierHandler).not.toHaveBeenCalled();
    expect(heatHandler).not.toHaveBeenCalled();
  });
});

describe('settings hydration at store creation', () => {
  // The store only reads localStorage once, at module-evaluation time (`settings:
  // loadSettings()` in the create() initializer). To observe hydration under different
  // localStorage contents, the module must be re-evaluated: vi.resetModules() clears
  // the registry, and a subsequent dynamic import() re-runs store.ts's top-level code
  // against whatever is in localStorage at that moment. The statically-imported
  // `useGameStore` used by every other test in this file is a separate, already-bound
  // module instance and is unaffected by resetModules().
  it('hydrates settings from a valid stored value', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'low', muted: true }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'low', qualitySource: 'auto', muted: true, reducedShake: false });
  });

  it('falls back to defaults on unparseable JSON', async () => {
    localStorage.setItem(SETTINGS_KEY, '{not valid json');
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', qualitySource: 'auto', muted: false, reducedShake: false });
  });

  it('falls back to defaults on well-formed but wrong-shaped JSON', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'ultra', muted: 'nope' }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', qualitySource: 'auto', muted: false, reducedShake: false });
  });

  it('falls back to defaults when nothing is stored', async () => {
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', qualitySource: 'auto', muted: false, reducedShake: false });
  });

  it('hydrates a stored reducedShake:true', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'high', muted: false, reducedShake: true }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({
      quality: 'high',
      qualitySource: 'auto',
      muted: false,
      reducedShake: true,
    });
  });

  it('normalises a pre-Phase-16 envelope (no reducedShake key) to the false default, keeping quality/muted', async () => {
    // Additive/version-safe extension: an older stored settings object is missing the key
    // entirely — it must still hydrate (not get rejected to defaults) with reducedShake:false.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'low', muted: true }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'low', qualitySource: 'auto', muted: true, reducedShake: false });
  });

  it('rejects a present-but-wrong-typed reducedShake to defaults', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'low', muted: true, reducedShake: 'yes' }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', qualitySource: 'auto', muted: false, reducedShake: false });
  });

  it("migrates a pre-Phase-18 envelope (no qualitySource key) to 'auto', keeping the rest", async () => {
    // Additive/version-safe: a stored settings object from before this field existed must still
    // hydrate (not reset to defaults), with qualitySource normalised to 'auto' so the FPS probe
    // may still re-measure it.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'med', muted: false, reducedShake: true }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({
      quality: 'med',
      qualitySource: 'auto',
      muted: false,
      reducedShake: true,
    });
  });

  it("preserves a persisted qualitySource:'user' (a real menu pick survives reload)", async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ quality: 'low', qualitySource: 'user', muted: false, reducedShake: false }),
    );
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings.qualitySource).toBe('user');
  });

  it('rejects a present-but-invalid qualitySource to defaults', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'low', qualitySource: 'bogus', muted: false }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({
      quality: 'high',
      qualitySource: 'auto',
      muted: false,
      reducedShake: false,
    });
  });
});

describe('selectCar (Phase 17)', () => {
  it('selects an unlocked car', () => {
    useGameStore.getState().selectCar('rustySedan');
    expect(useGameStore.getState().selectedCarId).toBe('rustySedan');
  });

  it('rejects a locked car — selectedCarId is left unchanged', () => {
    expect(useGameStore.getState().unlockedCarIds).not.toContain('redRocket');
    useGameStore.getState().selectCar('redRocket');
    expect(useGameStore.getState().selectedCarId).toBe('rustySedan');
  });

  // A test exercising the real carUnlocked -> unlockedCarIds flow lives in
  // storeUnlocks.test.ts, NOT here — this file's own afterEach (above) calls
  // gameEvents.clearAllListeners() after every test, which (correctly, for the tests
  // that predate Phase 17) tears down locally-registered handlers, but ALSO
  // permanently wipes state/store.ts's module-scope `carUnlocked` subscription
  // (registered exactly once, at store.ts's import time) after the very first test in
  // this file runs — there is no way to re-register it short of re-importing the
  // module. storeUnlocks.test.ts is a separate file with no such blanket cleanup, the
  // same "preserve the production listener" idiom hud/gameOverRunEnd.ts's and
  // hud/gameOverUnlocks.ts's test files already use.
});

describe('unlockedCarIds / seed hydration at store creation (Phase 17)', () => {
  // Same vi.resetModules() + dynamic re-import technique as the settings-hydration block
  // above: the store only reads persisted progress once, at module-evaluation time, so
  // observing a different localStorage state requires a fresh module instance.
  it('hydrates unlockedCarIds from a persisted lifetimeScore that already cleared a threshold', async () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: 1, bestScore: 900, lifetimeScore: 900 }),
    );
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().unlockedCarIds).toEqual(['rustySedan', 'streetRacer']);
  });

  it('unions the derived set with an explicitly persisted unlockedCarIds (monotonic even if thresholds moved)', async () => {
    localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        bestScore: 10,
        lifetimeScore: 10,
        unlockedCarIds: ['rustySedan', 'redRocket'],
      }),
    );
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().unlockedCarIds).toEqual(['rustySedan', 'redRocket']);
  });

  it('hydrates seed from a persisted lastSeed', async () => {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ v: 1, bestScore: 0, lifetimeScore: 0, lastSeed: 8675309 }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().seed).toBe(8675309);
  });

  it('falls back to WORLD_GEN.defaultSeed when no lastSeed is persisted', async () => {
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().seed).toBe(WORLD_GEN.defaultSeed);
  });
});
