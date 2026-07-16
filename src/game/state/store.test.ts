import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameEvents } from './events';
import { getGameState, tierForHeat, useGameStore } from './store';

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
    expect(state.seed).toBe(0);
    expect(state.settings).toEqual({ quality: 'high', muted: false });
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
    expect(useGameStore.getState().settings).toEqual({ quality: 'med', muted: false });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({
      quality: 'med',
      muted: false,
    });
  });

  it('toggleMuted flips state and persists to localStorage', () => {
    useGameStore.getState().toggleMuted();
    expect(useGameStore.getState().settings.muted).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')).toEqual({
      quality: 'high',
      muted: true,
    });

    useGameStore.getState().toggleMuted();
    expect(useGameStore.getState().settings.muted).toBe(false);
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
    expect(state.settings).toEqual({ quality: 'low', muted: false });
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
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'low', muted: true });
  });

  it('falls back to defaults on unparseable JSON', async () => {
    localStorage.setItem(SETTINGS_KEY, '{not valid json');
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', muted: false });
  });

  it('falls back to defaults on well-formed but wrong-shaped JSON', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'ultra', muted: 'nope' }));
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', muted: false });
  });

  it('falls back to defaults when nothing is stored', async () => {
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useGameStore.getState().settings).toEqual({ quality: 'high', muted: false });
  });
});
