import { create } from 'zustand';
import { type GameState, assertTransition, canTransition } from './machine';
import { gameEvents } from './events';
import { WORLD_GEN } from '../config';

// Store rule (TDD §6 `game/state/`): this is the ONLY zustand store, and it holds ONLY
// machine state, meta-progression numbers, and HUD-visible values. Per-frame hot data —
// vehicle positions/velocities/wheel contact state, AI steering intermediates, camera
// rig transforms — NEVER lives here: subscribing React components to a store that
// writes at physics rate (60 Hz+) forces a re-render every tick and defeats R3F's
// imperative render loop. That data lives in module-scope / R3F refs instead, and only
// surfaces here at HUD-relevant granularity (e.g. `heat`, never "car #3's velocity").

export interface Settings {
  quality: 'high' | 'med' | 'low';
  muted: boolean;
}

// Exported for game/core/quality.ts: the auto quality-tier detection must check whether
// the user already has a *persisted* settings choice (which always wins) by reading this
// exact key — the store's own `settings` field can't distinguish "persisted" from
// "in-memory default", so the raw key is the source of truth. (Task C export exception.)
export const SETTINGS_STORAGE_KEY = 'smashy6ix:settings';

const DEFAULT_SETTINGS: Settings = { quality: 'high', muted: false };

// Mirrors game/config/heat.ts — Phase 8 wires the real config through. Kept as a local
// literal (not imported) because game/config is being authored in parallel with this
// task; ascending, index = tier, thresholds[0] must be 0 so heat 0 always resolves to
// tier 0.
const DEFAULT_TIER_THRESHOLDS = [0, 15, 75, 180, 350, 600] as const;

/**
 * Highest tier index `i` such that `heat >= thresholds[i]`. `thresholds` must be
 * ascending; heat below `thresholds[0]` (expected to be 0) resolves to tier 0.
 */
export function tierForHeat(heat: number, thresholds: readonly number[]): number {
  let tier = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (heat < thresholds[i]) break; // ascending thresholds: nothing later can match either
    tier = i;
  }
  return tier;
}

function isValidSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.quality === 'high' || candidate.quality === 'med' || candidate.quality === 'low') &&
    typeof candidate.muted === 'boolean'
  );
}

// Both localStorage calls are try/catch-wrapped: private/incognito browsing and
// storage-quota exhaustion can make localStorage throw on read *or* write, and losing
// settings persistence must never be a hard failure.
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    return isValidSettings(parsed) ? parsed : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Swallow: settings simply won't persist this session.
  }
}

export interface GameStoreState {
  machine: GameState;
  heat: number;
  tier: number;
  score: number;
  playerHp: number;
  seed: number;
  settings: Settings;

  /** Validates against machine.ts's TRANSITIONS table before applying. */
  transition: (to: GameState) => void;
  /** Monotonic: negative deltas are clamped to 0 (heat never decays — locked design decision). */
  addHeat: (delta: number) => void;
  addScore: (points: number) => void;
  setPlayerHp: (hp: number) => void;
  setSeed: (seed: number) => void;
  setQuality: (quality: Settings['quality']) => void;
  toggleMuted: () => void;
  /** Out-of-band reset (route-change/unmount teardown) — NOT a table transition. */
  hardReset: () => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  machine: 'BOOT',
  heat: 0,
  tier: 0,
  score: 0,
  playerHp: 100,
  seed: WORLD_GEN.defaultSeed,
  settings: loadSettings(),

  transition: (to) => {
    const from = get().machine;
    // Throws in dev on an invalid transition (fail loud at the call site); in prod
    // this only warns, so the canTransition check below is what actually guards the
    // `set` call in that environment.
    assertTransition(from, to);
    if (canTransition(from, to)) {
      set({ machine: to });
    }
  },

  addHeat: (delta) => {
    let clampedDelta = delta;
    if (delta < 0) {
      if (import.meta.env.DEV) {
        console.warn(
          `[store] addHeat received a negative delta (${delta}); heat is monotonic and never decays — clamping to 0.`,
        );
      }
      clampedDelta = 0;
    }

    const { heat: prevHeat, tier: prevTier } = get();
    const heat = prevHeat + clampedDelta;
    const tier = tierForHeat(heat, DEFAULT_TIER_THRESHOLDS);
    set({ heat, tier });

    gameEvents.emit('heatChanged', { heat, delta: clampedDelta });
    if (tier !== prevTier) {
      gameEvents.emit('tierChanged', { tier, prevTier });
    }
  },

  addScore: (points) => set((state) => ({ score: state.score + points })),
  setPlayerHp: (hp) => set({ playerHp: hp }),
  setSeed: (seed) => set({ seed }),

  setQuality: (quality) => {
    set((state) => {
      const settings = { ...state.settings, quality };
      saveSettings(settings);
      return { settings };
    });
  },

  toggleMuted: () => {
    set((state) => {
      const settings = { ...state.settings, muted: !state.settings.muted };
      saveSettings(settings);
      return { settings };
    });
  },

  hardReset: () => {
    // BOOT has no predecessor in TRANSITIONS, so this intentionally bypasses
    // assertTransition rather than going through `transition`. Settings and seed are
    // meta-progression (not run state) and survive.
    set({ machine: 'BOOT', heat: 0, tier: 0, score: 0, playerHp: 100 });
  },
}));

// Convenience for non-React systems (AI, physics callbacks, etc.) that need a one-shot
// read without subscribing.
export const getGameState = useGameStore.getState;
